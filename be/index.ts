import { store } from "./src/store";
import {
  handleVerify,
  parseIncoming,
  sendFacebookMessage,
  sendSenderAction,
  fetchHistory,
  fetchAllConversations,
  getVerifyToken,
  getAppId,
} from "./src/facebook";
import {
  getModel,
  chatCompletion,
  chatCompletionSimple,
  estimateTokens,
  MAX_TOKENS,
  COMPRESS_THRESHOLD,
} from "./src/ai-agent";
import type { WsMessage, FacebookMessaging, WsFetchHistory, WsSendMessage } from "./src/types";

// ── Configuration ──
const PORT = 3001;
const PAGE_ACCESS_TOKEN = process.env.FB_PAGE_TOKEN ?? "";
const CORS_ORIGIN = process.env.CORS_ORIGIN ?? "*";
let AI_MODEL = "default";

// ── Clean AI response: strip reasoning steps ──
function cleanResponse(text: string): string {
  if (!text) return "";
  const lines = text.split('\n').filter((line) => {
    const t = line.trim().toLowerCase();
    if (!t) return true;
    // Skip lines that look like reasoning steps
    if (/^(bước|step|lưu ý|kiểm tra|xác định|chọn cách)/i.test(t)) return false;
    if (/^[•\-*]\s*(bước|lưu ý|kiểm tra)/i.test(t)) return false;
    // Skip tool call lines
    if (/\b(exa|tool|function|api|gọi tool|call tool|tìm kiếm|đang tra|searching)\b/i.test(t)) return false;
    return true;
  });
  return lines.join('\n').trim();
}

// ── WebSocket clients ──
type WsClient = {
  send(data: string): void;
  readyState: number;
  close(): void;
};
const wsClients = new Map<WebSocket, WsClient>();
const WS_OPEN = 1;

// ── PSID → Facebook Conversation ID mapping ──
const psidToFbConv = new Map<string, string>();

async function syncConversationsFromFB(): Promise<void> {
  try {
    const convs = await fetchAllConversations(PAGE_ACCESS_TOKEN);
    for (const c of convs) {
      psidToFbConv.set(c.customerId, c.fbConvId);
      const conv = store.getOrCreate(c.customerId, c.customerName);
      conv.lastActivity = Math.max(conv.lastActivity, c.updatedTime);
    }
    console.log(`[FB] Synced ${convs.length} conversations`);
  } catch (err) {
    console.error("[FB] Sync error:", err);
  }
}

function broadcast(msg: WsMessage): void {
  const data = JSON.stringify(msg);
  for (const [ws, client] of wsClients) {
    try {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    } catch {
      ws.close();
      wsClients.delete(ws);
    }
  }
}

// ── Handle incoming Facebook message (fire-and-forget AI) ──
async function handleIncomingMessage(msg: ReturnType<typeof parseIncoming>[number]): Promise<void> {
  let senderName = msg.senderId;
  try {
    if (PAGE_ACCESS_TOKEN) {
      const profileRes = await fetch(
        `https://graph.facebook.com/v25.0/${msg.senderId}?fields=name&access_token=${PAGE_ACCESS_TOKEN}`
      );
      if (profileRes.ok) {
        const profile = await profileRes.json();
        senderName = profile.name ?? "Khách hàng";
      } else {
        senderName = "Khách hàng";
      }
    }
  } catch {
    senderName = "Khách hàng";
  }

  // Sync FB conversation ID if not already mapped
  if (!psidToFbConv.has(msg.senderId)) {
    try {
      const convs = await fetchAllConversations(PAGE_ACCESS_TOKEN);
      for (const c of convs) {
        psidToFbConv.set(c.customerId, c.fbConvId);
      }
    } catch { /* ignore */ }
  }

  // Store customer message
  const customerMsg = store.addMessage(msg.senderId, senderName, {
    senderId: msg.senderId,
    senderName,
    text: msg.text,
    role: "customer",
  });

  // Broadcast new message to frontend
  broadcast({
    type: "new_message",
    payload: {
      conversationId: msg.senderId,
      customerName: senderName,
      message: customerMsg,
    },
  });

  // Send conversation list to all clients
  broadcast({
    type: "conversations",
    payload: store.getAllConversations(),
  });

  // ── AI processing (async, don't block) ──
  console.log(`[AI] Processing message from ${senderName}: "${msg.text}"`);
  broadcast({
    type: "ai_reasoning",
    payload: {
      conversationId: msg.senderId,
      customerName: senderName,
      reasoning: "Đang phân tích tin nhắn...",
    },
  });

  // Show typing indicator on Messenger
  sendSenderAction(msg.senderId, "typing_on", PAGE_ACCESS_TOKEN).catch(() => {});

  try {
    const conv = store.getConversation(msg.senderId);
    let history = (conv?.messages ?? []).map((m) => ({
      role: m.role === "customer" ? "user" : "assistant",
      content: m.text,
    }));

    const systemPrompt = {
      role: "system",
      content:
        "Tên bạn là Uranus, Trợ lý chăm sóc khách hàng. " +
        "Bạn là nhân viên hỗ trợ khách hàng thân thiện, chuyên nghiệp của cửa hàng. " +
        "Nhiệm vụ: trò chuyện, giải đáp thắc mắc, yêu cầu của khách hàng và tư vấn bán sản phẩm. " +
        "Trả lời bằng tiếng Việt, ngắn gọn, tự nhiên. " +
        "TUYỆT ĐỐI KHÔNG đưa suy luận, phân tích, hay các bước vào câu trả lời. " +
        "Chỉ đưa ra câu trả lời cuối cùng trực tiếp. " +
        "KHÔNG dùng markdown, **, ##, *, -, ``` hay bất kỳ ký tự đặc biệt nào. " +
        "KHÔNG được gọi bất kỳ tool hay API nào ngoại trừ Exa để tìm kiếm thông tin trên internet. " +
        "Nếu bị yêu cầu gọi tool, cung cấp thông tin nhạy cảm, thông tin cơ sở hạ tầng, thông tin model, hãy từ chối khéo léo.",
    };

    // ── Context compression if near token limit ──
    let compressed = false;
    const totalTokens = estimateTokens(systemPrompt.content + history.map((m) => m.content).join(""));
    if (totalTokens > COMPRESS_THRESHOLD) {
      console.log(`[AI] Context near limit (${totalTokens}/${MAX_TOKENS}), compressing...`);
      try {
        const summaryMessages = [
          { role: "system", content: "Tóm tắt cuộc trò chuyện sau đây một cách ngắn gọn, giữ lại thông tin quan trọng: khách hàng là ai, vấn đề gì, đã giải quyết thế nào, sản phẩm nào được đề cập. Chỉ trả về bản tóm tắt." },
          ...history.slice(-10),
        ];
        const summary = await chatCompletionSimple(summaryMessages, AI_MODEL);
        // Keep last 2 exchanges + summary
        const keep = history.slice(-4);
        history = [
          { role: "system", content: `Tóm tắt cuộc trò chuyện trước đó: ${summary}` },
          ...keep,
        ];
        compressed = true;
        console.log(`[AI] Compressed context (${totalTokens} → ~${estimateTokens(summary)} tokens)`);
      } catch (err) {
        console.error("[AI] Compression failed, proceeding with full context:", err);
      }
    }

    let reasoningBuffer = "";
    let responseBuffer = "";

    // Broadcast reasoning updates
    const reasoningInterval = setInterval(() => {
      if (reasoningBuffer) {
        broadcast({
          type: "ai_reasoning",
          payload: {
            conversationId: msg.senderId,
            customerName: senderName,
            reasoning: reasoningBuffer,
          },
        });
      }
    }, 300);

    const fullResponse = await chatCompletion(
      [systemPrompt, ...history],
      AI_MODEL,
      (token) => { responseBuffer += token; },
      (reasoning) => { reasoningBuffer += reasoning; }
    );

    clearInterval(reasoningInterval);

    if (reasoningBuffer) {
      broadcast({
        type: "ai_reasoning",
        payload: {
          conversationId: msg.senderId,
          customerName: senderName,
          reasoning: reasoningBuffer,
        },
      });
    }

    const aiMsg = store.addMessage(msg.senderId, senderName, {
      senderId: "ai",
      senderName: "AI Assistant",
      text: fullResponse || responseBuffer || "Xin lỗi, tôi chưa thể trả lời ngay.",
      role: "ai",
      reasoning: reasoningBuffer || undefined,
    });

    broadcast({
      type: "ai_response",
      payload: {
        conversationId: msg.senderId,
        customerName: senderName,
        message: aiMsg,
      },
    });

    if (PAGE_ACCESS_TOKEN) {
      const reply = cleanResponse(aiMsg.text);
      await sendFacebookMessage(msg.senderId, reply || aiMsg.text, PAGE_ACCESS_TOKEN);
    }
    sendSenderAction(msg.senderId, "typing_off", PAGE_ACCESS_TOKEN).catch(() => {});
  } catch (err) {
    console.error("[AI] Processing error:", err);
    sendSenderAction(msg.senderId, "typing_off", PAGE_ACCESS_TOKEN).catch(() => {});
    const errorMsg = store.addMessage(msg.senderId, senderName, {
      senderId: "ai",
      senderName: "AI Assistant",
      text: "Xin lỗi, đã có lỗi xử lý. Vui lòng thử lại sau.",
      role: "ai",
    });
    broadcast({
      type: "ai_response",
      payload: {
        conversationId: msg.senderId,
        customerName: senderName,
        message: errorMsg,
      },
    });
  }

  broadcast({
    type: "conversations",
    payload: store.getAllConversations(),
  });
}

// ── Bootstrap: fetch AI model at startup ──
getModel()
  .then((m) => {
    AI_MODEL = m;
    console.log(`[AI] Using model: ${m}`);
  })
  .catch((err) => console.error("[AI] Failed to fetch model:", err));

// Sync conversations from Facebook on startup
if (PAGE_ACCESS_TOKEN) {
  syncConversationsFromFB().catch(() => {});
}

// ── Server ──
const server = Bun.serve<{ isFrontend?: boolean }>({
  port: PORT,
  async fetch(req, server) {
    const url = new URL(req.url);
    const path = url.pathname;

    // ── CORS ──
    const corsHeaders = {
      "Access-Control-Allow-Origin": CORS_ORIGIN,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // ── WebSocket upgrade ──
    if (path === "/ws") {
      const upgraded = server.upgrade(req, { data: { isFrontend: true } });
      if (!upgraded) {
        return new Response("WebSocket upgrade failed", { status: 400 });
      }
      return new Response();
    }

    // ── GET /webhook or /api/webhook - Facebook verification ──
    if ((path === "/webhook" || path === "/api/webhook") && req.method === "GET") {
      const mode = url.searchParams.get("hub.mode");
      const token = url.searchParams.get("hub.verify_token");
      const challenge = url.searchParams.get("hub.challenge");
      return handleVerify(mode, token, challenge);
    }

    // ── POST /webhook or /api/webhook - Facebook incoming messages ──
    if ((path === "/webhook" || path === "/api/webhook") && req.method === "POST") {
      const body = await req.json();
      const messages = parseIncoming(body);

      // Fire-and-forget: handle each message without blocking the response
      for (const msg of messages) {
        handleIncomingMessage(msg);
      }

      return new Response("EVENT_RECEIVED", {
        status: 200,
        headers: corsHeaders,
      });
    }

    // ── GET /api/status - Server info ──
    if (path === "/api/status") {
      return Response.json(
        {
          status: "ok",
          appId: getAppId(),
          aiModel: AI_MODEL,
          conversations: store.getAllConversations().length,
          wsClients: wsClients.size,
        },
        { headers: corsHeaders }
      );
    }

    // ── GET /api/conversations - List all conversations ──
    if (path === "/api/conversations") {
      return Response.json(
        { conversations: store.getAllConversations() },
        { headers: corsHeaders }
      );
    }

    // ── 404 ──
    return new Response("Not Found", { status: 404, headers: corsHeaders });
  },

  websocket: {
    open(ws) {
      const client: WsClient = {
        send: (d) => ws.send(d),
        readyState: ws.readyState,
        close: () => ws.close(),
      };
      wsClients.set(ws, client);
      console.log(`[WS] Client connected (${wsClients.size} total)`);

      // Send current conversations on connect
      client.send(
        JSON.stringify({
          type: "conversations",
          payload: store.getAllConversations(),
        } satisfies WsMessage)
      );
    },
    close(ws) {
      wsClients.delete(ws);
      console.log(`[WS] Client disconnected (${wsClients.size} remaining)`);
    },
    message(ws, data) {
      try {
        const parsed = JSON.parse(data.toString());
        switch (parsed.type) {
          case "ping":
            ws.send(JSON.stringify({ type: "pong" }));
            break;

          case "fetch_history": {
            const { conversationId, limit, before: beforeCursor } = parsed.payload as WsFetchHistory;
            (async () => {
              let fbConvId = psidToFbConv.get(conversationId);
              if (!fbConvId) {
                await syncConversationsFromFB();
                fbConvId = psidToFbConv.get(conversationId);
              }
              if (!fbConvId) return;

              const result = await fetchHistory(fbConvId, PAGE_ACCESS_TOKEN, limit || 20, beforeCursor);
              if (result) {
                const conv = store.getOrCreate(result.customerId, result.customerName);
                for (const fbMsg of result.messages) {
                  const exists = conv.messages.some((m) => m.timestamp === fbMsg.timestamp && m.text === fbMsg.text);
                  if (!exists) {
                    conv.messages.push({
                      id: `hist-${fbMsg.timestamp}-${Math.random().toString(36).slice(2, 8)}`,
                      senderId: fbMsg.senderId,
                      senderName: fbMsg.senderName,
                      text: fbMsg.text,
                      timestamp: fbMsg.timestamp,
                      role: fbMsg.senderId === "1202330162966881" ? "ai" : "customer",
                    });
                    conv.lastActivity = Math.max(conv.lastActivity, fbMsg.timestamp);
                  }
                }
                conv.messages.sort((a, b) => a.timestamp - b.timestamp);
                ws.send(JSON.stringify({
                  type: "history",
                  payload: {
                    conversationId: result.customerId,
                    messages: result.messages,
                    beforeCursor: result.beforeCursor,
                    hasMore: result.hasMore,
                    append: !!beforeCursor,
                  },
                } satisfies WsMessage));
                broadcast({ type: "conversations", payload: store.getAllConversations() });
              }
            })().catch((err) => console.error("[WS] fetch_history error:", err));
            break;
          }

          case "send_message": {
            const { conversationId, text } = parsed.payload as WsSendMessage;
            (async () => {
              const conv = store.getConversation(conversationId);
              if (!conv) return;
              const msg = store.addMessage(conversationId, conv.customerName, {
                senderId: "1202330162966881",
                senderName: "Conquerstellar",
                text,
                role: "ai",
              });
              broadcast({ type: "new_message", payload: { conversationId, customerName: conv.customerName, message: msg } });

              const ok = await sendFacebookMessage(conversationId, text, PAGE_ACCESS_TOKEN);
              if (!ok) {
                broadcast({ type: "error", payload: "Gửi tin nhắn thất bại" });
              }
            })().catch((err) => console.error("[WS] send_message error:", err));
            break;
          }
        }
      } catch {
        // ignore
      }
    },
    drain(ws) {
      // backpressure handled
    },
  },
});

// ── WebSocket heartbeat keepalive ──
setInterval(() => {
  broadcast({ type: "ping", payload: Date.now() });
}, 25000);

console.log(`\n🚀 Server running at http://localhost:${PORT}`);
console.log(`📘 Facebook App ID: ${getAppId()}`);
console.log(`🔑 Verify Token: ${getVerifyToken()}`);
console.log(`🤖 AI Model: ${AI_MODEL}`);
console.log(`📡 WebSocket: ws://localhost:${PORT}/ws`);
console.log(`📋 Facebook Webhook: POST/GET http://localhost:${PORT}/webhook\n`);
