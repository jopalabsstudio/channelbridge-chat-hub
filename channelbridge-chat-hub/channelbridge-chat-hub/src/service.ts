import { randomUUID } from 'node:crypto';
import { InboxStore } from './storage.ts';
import type { Channel, Thread, Sender } from './types.ts';

export class ChatHub {
  readonly store: InboxStore;
  private readonly sendExternal: Sender;
  constructor(store: InboxStore, sendExternal: Sender) { this.store = store; this.sendExternal = sendExternal; }

  async simulateInbound(channel: Channel, displayName: string, text: string, externalUserId?: string): Promise<string> {
    const external = externalUserId?.trim() || `${channel}-${randomUUID().slice(0, 8)}`;
    const result = await this.store.receive({ mode: 'demo', channel, accountId: `${channel}-sandbox`,
      externalUserId: external, displayName, providerMessageId: `demo-${randomUUID()}`, text });
    return result.threadId;
  }

  async reply(threadId: string, text: string): Promise<void> {
    const thread = this.store.getThread(threadId);
    if (!thread) throw new Error('Conversation not found');
    const message = await this.store.beginReply(threadId, text);
    try {
      const id = thread.mode === 'demo' ? `demo-sent-${randomUUID()}` : await this.sendExternal(thread, text.trim());
      await this.store.completeReply(message.id, true, id);
    } catch (error) {
      await this.store.completeReply(message.id, false, undefined,
        error instanceof Error ? error.message : 'Unknown provider error');
      throw error;
    }
  }
}
