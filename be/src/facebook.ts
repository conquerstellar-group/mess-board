import type { FacebookWebhookEntry, FacebookMessaging } from "./types";

const APP_ID = "999933652961208";
const VERIFY_TOKEN = "messchatbot_verify_2024";

export function getAppId(): string {
  return APP_ID;
}

export function getVerifyToken(): string {
  return VERIFY_TOKEN;
}

/**
 * Handle Facebook webhook verification (GET)
 */
export function handleVerify(mode: string | null, token: string | null, challenge: string | null): Response {
  if (mode === "subscribe" && token === VERIFY_TOKEN && challenge) {
    console.log("[FB] Webhook verified!");
    return new Response(challenge, { status: 200 });
  }
  return new Response("Forbidden", { status: 403 });
}

/**
 * Handle incoming Facebook messages (POST)
 * Returns parsed messages: Array<{ senderId, text }>
 */
export function parseIncoming(body: unknown): Array<{
  senderId: string;
  text: string;
  entryId: string;
  messaging: FacebookMessaging;
}> {
  const data = body as {
    object?: string;
    entry?: FacebookWebhookEntry[];
  };
  const results: Array<{
    senderId: string;
    text: string;
    entryId: string;
    messaging: FacebookMessaging;
  }> = [];

  if (data?.object !== "page") return results;

  for (const entry of data.entry ?? []) {
    for (const event of entry.messaging ?? []) {
      if (event.message?.text) {
        results.push({
          senderId: event.sender.id,
          text: event.message.text,
          entryId: entry.id,
          messaging: event,
        });
      }
      // Handle postbacks
      if (event.postback?.payload) {
        results.push({
          senderId: event.sender.id,
          text: event.postback.payload,
          entryId: entry.id,
          messaging: event,
        });
      }
    }
  }

  return results;
}

/**
 * Send a message back to Facebook Messenger (Send API v25.0)
 * Docs: https://developers.facebook.com/docs/messenger-platform/send-messages
 */
export async function sendFacebookMessage(
  recipientId: string,
  text: string,
  pageAccessToken: string
): Promise<boolean> {
  try {
    const res = await fetch(
      `https://graph.facebook.com/v25.0/me/messages?access_token=${pageAccessToken}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipient: { id: recipientId },
          messaging_type: "RESPONSE",
          message: { text },
        }),
      }
    );
    if (!res.ok) {
      const errText = await res.text();
      console.error("[FB] Send message error:", errText);
      return false;
    }
    return true;
  } catch (err) {
    console.error("[FB] Send message exception:", err);
    return false;
  }
}

/** Send sender action (typing_on, typing_off, mark_seen) */
export async function sendSenderAction(
  recipientId: string,
  action: "typing_on" | "typing_off" | "mark_seen",
  pageAccessToken: string
): Promise<boolean> {
  try {
    const res = await fetch(
      `https://graph.facebook.com/v25.0/me/messages?access_token=${pageAccessToken}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipient: { id: recipientId },
          sender_action: action,
        }),
      }
    );
    if (!res.ok) {
      const errText = await res.text();
      console.error(`[FB] Sender action ${action} error:`, errText);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[FB] Sender action ${action} exception:`, err);
    return false;
  }
}

/** Fetch all conversations from Facebook API */
export async function fetchAllConversations(
  pageAccessToken: string
): Promise<Array<{ fbConvId: string; customerId: string; customerName: string; updatedTime: number }>> {
  try {
    const res = await fetch(
      `https://graph.facebook.com/v25.0/me/conversations?access_token=${pageAccessToken}&fields=participants,updated_time,message_count&limit=50`
    );
    if (!res.ok) return [];
    const body = await res.json();
    const data = (body as { data?: Array<{ id: string; participants: { data: Array<{ id: string; name: string }> }; updated_time: string }> }).data ?? [];
    return data.map((c) => {
      const participants = c.participants?.data ?? [];
      const customer = participants.find((p) => p.id !== "1202330162966881") ?? participants[0];
      return {
        fbConvId: c.id,
        customerId: customer?.id ?? "",
        customerName: customer?.name ?? "Khách hàng",
        updatedTime: new Date(c.updated_time).getTime(),
      };
    }).filter((c) => c.customerId);
  } catch (err) {
    console.error("[FB] Fetch all conversations error:", err);
    return [];
  }
}

/** Fetch conversation history from Facebook using FB conversation ID */
export async function fetchHistory(
  fbConvId: string,
  pageAccessToken: string,
  limit = 20,
  beforeCursor?: string
): Promise<{
  messages: Array<{ text: string; senderId: string; senderName: string; timestamp: number }>;
  customerName: string;
  customerId: string;
  beforeCursor: string | null;
  hasMore: boolean;
} | null> {
  try {
    let url = `https://graph.facebook.com/v25.0/${fbConvId}/messages?access_token=${pageAccessToken}&fields=message,from,created_time&limit=${limit}`;
    if (beforeCursor) url += `&before=${beforeCursor}`;

    const msgsRes = await fetch(url);
    if (!msgsRes.ok) return null;
    const msgs = await msgsRes.json();

    // Get participants info
    const convRes = await fetch(
      `https://graph.facebook.com/v25.0/${fbConvId}?access_token=${pageAccessToken}&fields=participants`
    );
    const conv = convRes.ok ? await convRes.json() : { participants: { data: [] } };
    const participants = (conv as { participants: { data: Array<{ id: string; name: string }> } }).participants?.data ?? [];
    const customer = participants.find((p: { id: string }) => p.id !== "1202330162966881") ?? participants[0];

    const paging = msgs as { paging?: { cursors?: { before?: string; after?: string }; next?: string } };
    const newBeforeCursor = paging.paging?.cursors?.before ?? null;
    const hasMore = !!paging.paging?.next;

    const messages = ((msgs as { data: Array<{ message?: string; from: { id: string; name: string }; created_time: string }> }).data ?? [])
      .filter((m) => m.message)
      .map((m) => ({
        text: m.message!,
        senderId: m.from.id,
        senderName: m.from.name,
        timestamp: new Date(m.created_time).getTime(),
      }))
      .reverse();

    return {
      messages,
      customerName: customer?.name ?? "Khách hàng",
      customerId: customer?.id ?? fbConvId,
      beforeCursor: newBeforeCursor,
      hasMore,
    };
  } catch (err) {
    console.error("[FB] Fetch history error:", err);
    return null;
  }
}
