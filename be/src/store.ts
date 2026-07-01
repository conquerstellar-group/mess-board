import type { Conversation, Message } from "./types";

class ConversationStore {
  private conversations = new Map<string, Conversation>();

  getOrCreate(customerId: string, customerName: string): Conversation {
    const existing = this.conversations.get(customerId);
    if (existing) return existing;

    const conv: Conversation = {
      id: customerId,
      customerName,
      customerId,
      messages: [],
      lastActivity: Date.now(),
      status: "active",
    };
    this.conversations.set(customerId, conv);
    return conv;
  }

  addMessage(
    customerId: string,
    customerName: string,
    msg: Omit<Message, "id" | "timestamp">
  ): Message {
    const conv = this.getOrCreate(customerId, customerName);
    const message: Message = {
      ...msg,
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: Date.now(),
    };
    conv.messages.push(message);
    conv.lastActivity = Date.now();
    conv.status = "active";
    return message;
  }

  getConversation(customerId: string): Conversation | undefined {
    return this.conversations.get(customerId);
  }

  getAllConversations(): Conversation[] {
    return Array.from(this.conversations.values()).sort(
      (a, b) => b.lastActivity - a.lastActivity
    );
  }

  setStatus(customerId: string, status: Conversation["status"]): void {
    const conv = this.conversations.get(customerId);
    if (conv) {
      conv.status = status;
      conv.lastActivity = Date.now();
    }
  }
}

export const store = new ConversationStore();
