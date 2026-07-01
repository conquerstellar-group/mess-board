export interface Message {
  id: string;
  senderId: string;
  senderName: string;
  text: string;
  timestamp: number;
  role: "customer" | "ai" | "system";
  reasoning?: string;
}

export interface Conversation {
  id: string;
  customerName: string;
  customerId: string;
  messages: Message[];
  lastActivity: number;
  status: "active" | "waiting" | "resolved";
}

export interface FacebookWebhookEntry {
  id: string;
  time: number;
  messaging: FacebookMessaging[];
}

export interface FacebookMessaging {
  sender: { id: string };
  recipient: { id: string };
  timestamp: number;
  message?: {
    mid: string;
    text?: string;
    attachments?: Array<{ type: string; payload: { url: string } }>;
  };
  postback?: {
    payload: string;
  };
}

export interface WsMessage {
  type: "conversations" | "new_message" | "ai_reasoning" | "ai_response" | "error" | "ping" | "fetch_history" | "send_message" | "history" | "conversation_updated";
  payload: unknown;
}

export interface WsFetchHistory {
  conversationId: string;
  limit?: number;
  before?: string;
}

export interface WsSendMessage {
  conversationId: string;
  text: string;
}
