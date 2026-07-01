const AI_HOST = process.env.AI_HOST ?? "http://192.168.3.4:8080/v1";

export interface AiModelInfo {
  id: string;
  object: string;
  created: number;
  owned_by: string;
}

export interface AiChatResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string;
    };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/** Fetch the available model from the AI agent */
export async function getModel(): Promise<string> {
  try {
    const res = await fetch(`${AI_HOST}/models`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as Record<string, unknown>;
    // OpenAI-compatible: { object: "list", data: [{ id: "..." }] }
    const dataArr = (body as { data?: Array<{ id: string }> }).data;
    if (Array.isArray(dataArr) && dataArr.length > 0) {
      return dataArr[0].id ?? "default";
    }
    // Fallback: raw array response
    if (Array.isArray(body)) {
      const first = body[0] as { id?: string };
      return first?.id ?? "default";
    }
    // Single object with id
    const single = body as { id?: string };
    return single.id ?? "default";
  } catch (err) {
    console.error("[AI] Failed to get model:", err);
    return "default";
  }
}

/** Send a chat message to the AI agent and stream the response */
export async function chatCompletion(
  messages: Array<{ role: string; content: string }>,
  model: string,
  onToken?: (token: string) => void,
  onReasoning?: (reasoning: string) => void
): Promise<string> {
  const body = {
    model,
    messages,
    stream: true,
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000); // 30s timeout

  let res: Response;
  try {
    res = await fetch(`${AI_HOST}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeout);
    const msg = err instanceof Error && err.name === "AbortError"
      ? "AI agent request timed out"
      : `AI agent unreachable: ${err}`;
    console.error(`[AI] ${msg}`);
    throw new Error(msg);
  }
  clearTimeout(timeout);

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`AI API error ${res.status}: ${text}`);
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error("No response body");

  let fullContent = "";
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data: ")) continue;
      const jsonStr = trimmed.slice(6);
      if (jsonStr === "[DONE]") break;

      try {
        const chunk = JSON.parse(jsonStr);
        const delta = chunk.choices?.[0]?.delta ?? {};

        // Skip tool/function call chunks
        if (delta.tool_calls || delta.function_call) continue;

        // Handle reasoning content (OpenAI-style reasoning/thinking)
        if (delta.reasoning_content) {
          onReasoning?.(delta.reasoning_content);
        }
        if (delta.reasoning) {
          onReasoning?.(delta.reasoning);
        }

        const content = delta.content ?? "";
        if (content) {
          fullContent += content;
          onToken?.(content);
        }
      } catch {
        // skip malformed JSON lines
      }
    }
  }

  return fullContent;
}

/** Non-streaming chat completion (for summarization) */
export async function chatCompletionSimple(
  messages: Array<{ role: string; content: string }>,
  model: string
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch(`${AI_HOST}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages, stream: false }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return body.choices?.[0]?.message?.content ?? "";
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

/** Rough token estimate (4 chars ≈ 1 token for Vietnamese/English) */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export const MAX_TOKENS = 47360;
export const COMPRESS_THRESHOLD = 38000;
