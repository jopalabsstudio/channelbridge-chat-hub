import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ChatMessage, Db, Incoming, Thread } from './types.ts';

function threadKey(item: Pick<Thread, 'mode' | 'channel' | 'accountId' | 'externalUserId'>): string {
  // JSON tuples avoid delimiter collisions and prevent mixing multiple provider accounts.
  return JSON.stringify([item.mode, item.channel, item.accountId, item.externalUserId]);
}

export class InboxStore {
  private db: Db = { threads: [], messages: [] };
  private queue: Promise<unknown> = Promise.resolve();

  private readonly file: string | null;
  constructor(file: string | null = null) { this.file = file; }

  async init(): Promise<void> {
    if (!this.file) return;
    try {
      const data: unknown = JSON.parse(await readFile(this.file, 'utf8'));
      if (!data || typeof data !== 'object' || !Array.isArray((data as Db).threads) || !Array.isArray((data as Db).messages)) {
        throw new Error('Invalid inbox data file');
      }
      this.db = data as Db;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  private async mutate<T>(change: (draft: Db) => T): Promise<T> {
    const task = this.queue.then(async () => {
      const draft = structuredClone(this.db);
      const result = change(draft);
      if (this.file) {
        await mkdir(dirname(this.file), { recursive: true });
        const tmp = `${this.file}.${randomUUID()}.tmp`;
        await writeFile(tmp, JSON.stringify(draft, null, 2), { mode: 0o600 });
        await rename(tmp, this.file);
      }
      this.db = draft;
      return result;
    });
    this.queue = task.catch(() => undefined);
    return task;
  }

  listThreads(): Array<Thread & { lastMessage: ChatMessage | null; messageCount: number }> {
    return this.db.threads.map(thread => {
      const messages = this.db.messages.filter(message => message.threadId === thread.id);
      return { ...thread, lastMessage: messages.at(-1) ?? null, messageCount: messages.length };
    }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  getThread(id: string): Thread | undefined { return this.db.threads.find(thread => thread.id === id); }
  listMessages(id: string): ChatMessage[] { return this.db.messages.filter(message => message.threadId === id); }

  async receive(message: Incoming): Promise<{ inserted: boolean; threadId: string }> {
    if (!message.text.trim() || message.text.length > 4000) throw new Error('Invalid incoming text');
    if (!message.accountId || !message.externalUserId || !message.providerMessageId) throw new Error('Missing message identity');
    return this.mutate(db => {
      const key = threadKey(message);
      let thread = db.threads.find(item => threadKey(item) === key);
      if (db.messages.some(existing => existing.providerMessageId === message.providerMessageId &&
        db.threads.some(t => t.id === existing.threadId && t.mode === message.mode && t.channel === message.channel && t.accountId === message.accountId))) {
        return { inserted: false, threadId: thread?.id ?? '' };
      }
      const now = message.receivedAt && !Number.isNaN(Date.parse(message.receivedAt)) ? message.receivedAt : new Date().toISOString();
      if (!thread) {
        thread = { id: randomUUID(), mode: message.mode, channel: message.channel, accountId: message.accountId,
          externalUserId: message.externalUserId, displayName: message.displayName.slice(0, 100) || message.externalUserId,
          createdAt: now, updatedAt: now, lastInboundAt: now };
        db.threads.push(thread);
      } else {
        thread.displayName = message.displayName.slice(0, 100) || thread.displayName;
        if (now > thread.updatedAt) thread.updatedAt = now;
        if (now > thread.lastInboundAt) thread.lastInboundAt = now;
      }
      db.messages.push({ id: randomUUID(), threadId: thread.id, direction: 'inbound', text: message.text,
        status: 'received', providerMessageId: message.providerMessageId, createdAt: now });
      return { inserted: true, threadId: thread.id };
    });
  }

  async beginReply(threadId: string, text: string): Promise<ChatMessage> {
    if (!text.trim() || text.length > 2000) throw new Error('Replies must be 1–2000 characters');
    return this.mutate(db => {
      const thread = db.threads.find(item => item.id === threadId);
      if (!thread) throw new Error('Conversation not found');
      const createdAt = new Date().toISOString();
      const message: ChatMessage = { id: randomUUID(), threadId, direction: 'outbound', text: text.trim(), status: 'pending', createdAt };
      db.messages.push(message);
      thread.updatedAt = createdAt;
      return message;
    });
  }

  async completeReply(messageId: string, success: boolean, providerMessageId?: string, error?: string): Promise<void> {
    await this.mutate(db => {
      const message = db.messages.find(item => item.id === messageId);
      if (!message) throw new Error('Outgoing message missing');
      message.status = success ? 'sent' : 'failed';
      if (providerMessageId) message.providerMessageId = providerMessageId;
      if (error) message.error = error.slice(0, 200);
    });
  }
}
