export type Channel = 'telegram' | 'whatsapp' | 'messenger';
export type Mode = 'demo' | 'live';
export type Direction = 'inbound' | 'outbound';
export type MessageStatus = 'received' | 'pending' | 'sent' | 'failed';

export type Incoming = {
  mode: Mode;
  channel: Channel;
  accountId: string;
  externalUserId: string;
  displayName: string;
  providerMessageId: string;
  text: string;
  receivedAt?: string;
};

export type Thread = {
  id: string;
  mode: Mode;
  channel: Channel;
  accountId: string;
  externalUserId: string;
  displayName: string;
  createdAt: string;
  updatedAt: string;
  lastInboundAt: string;
};

export type ChatMessage = {
  id: string;
  threadId: string;
  direction: Direction;
  text: string;
  status: MessageStatus;
  createdAt: string;
  providerMessageId?: string;
  error?: string;
};

export type Db = { threads: Thread[]; messages: ChatMessage[] };
export type Sender = (thread: Thread, text: string) => Promise<string>;
