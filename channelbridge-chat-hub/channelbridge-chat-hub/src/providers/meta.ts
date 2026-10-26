import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Incoming, Thread } from '../types.ts';

export function verifyMetaSignature(raw: Buffer, received: string | undefined, secret: string): boolean {
  if (!secret || !received || !/^sha256=[a-f0-9]{64}$/i.test(received)) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(raw).digest('hex'), 'hex');
  const actual = Buffer.from(received.slice(7), 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function parseMeta(body: unknown, whatsappId: string, pageId: string): Incoming[] {
  const payload = body as { object?: string; entry?: Array<{ id?: string; changes?: Array<{
    value?: { metadata?: { phone_number_id?: string }; contacts?: Array<{ wa_id?: string; profile?: { name?: string } }>;
      messages?: Array<{ id?: string; from?: string; type?: string; text?: { body?: string }; timestamp?: string }> } }>; messaging?: Array<{
      sender?: { id?: string }; recipient?: { id?: string }; message?: { mid?: string; text?: string; is_echo?: boolean }; timestamp?: number }> }> };
  const incoming: Incoming[] = [];
  if (!Array.isArray(payload?.entry)) return incoming;
  if (payload.object === 'whatsapp_business_account') {
    for (const entry of payload.entry) for (const change of entry.changes ?? []) {
      const val = change.value; const accountId = val?.metadata?.phone_number_id;
      if (!accountId || !whatsappId || accountId !== whatsappId) continue;
      for (const msg of val?.messages ?? []) {
        if (msg.type !== 'text' || !msg.text?.body || !msg.id || !msg.from) continue;
        const contact = val?.contacts?.find(c => c.wa_id === msg.from);
        incoming.push({ mode: 'live', channel: 'whatsapp', accountId,
          externalUserId: msg.from, displayName: contact?.profile?.name ?? msg.from,
          providerMessageId: msg.id, text: msg.text.body,
          receivedAt: msg.timestamp && Number.isFinite(Number(msg.timestamp)) ? new Date(Number(msg.timestamp) * 1000).toISOString() : undefined });
      }
    }
  }
  if (payload.object === 'page') {
    for (const entry of payload.entry) for (const event of entry.messaging ?? []) {
      if (!pageId || entry.id !== pageId || event.recipient?.id !== pageId || !event.sender?.id ||
        !event.message?.mid || !event.message.text || event.message.is_echo) continue;
      incoming.push({ mode: 'live', channel: 'messenger', accountId: pageId,
        externalUserId: event.sender.id, displayName: `Messenger user ${event.sender.id.slice(-6)}`,
        providerMessageId: event.message.mid, text: event.message.text,
        receivedAt: event.timestamp && Number.isFinite(event.timestamp) ? new Date(event.timestamp).toISOString() : undefined });
    }
  }
  return incoming;
}

async function graphPost(endpoint: string, token: string, payload: unknown, fetcher: typeof fetch): Promise<unknown> {
  const response = await fetcher(endpoint, { method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(10000) });
  const data: unknown = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Meta send failed (${response.status})`);
  return data;
}

export function insideCustomerWindow(lastInboundAt: string, now = Date.now()): boolean {
  const diff = now - Date.parse(lastInboundAt);
  return Number.isFinite(diff) && diff >= 0 && diff < (24 * 60 - 5) * 60 * 1000;
}

export async function sendWhatsApp(thread: Thread, text: string, token: string, version: string, fetcher: typeof fetch = fetch): Promise<string> {
  if (!token) throw new Error('WhatsApp token is not configured');
  if (!insideCustomerWindow(thread.lastInboundAt)) throw new Error('24-hour customer service window expired; a template is required');
  const data = await graphPost(`https://graph.facebook.com/${version}/${encodeURIComponent(thread.accountId)}/messages`, token,
    { messaging_product: 'whatsapp', recipient_type: 'individual', to: thread.externalUserId,
      type: 'text', text: { preview_url: false, body: text } }, fetcher) as { messages?: Array<{ id?: string }> };
  if (!data.messages?.[0]?.id) throw new Error('Meta returned no outgoing message ID');
  return data.messages[0].id;
}

export async function sendMessenger(thread: Thread, text: string, token: string, version: string, fetcher: typeof fetch = fetch): Promise<string> {
  if (!token) throw new Error('Messenger page token is not configured');
  if (!insideCustomerWindow(thread.lastInboundAt)) throw new Error('Messenger standard messaging window expired');
  const data = await graphPost(`https://graph.facebook.com/${version}/${encodeURIComponent(thread.accountId)}/messages`, token,
    { recipient: { id: thread.externalUserId }, messaging_type: 'RESPONSE', message: { text } }, fetcher) as { message_id?: string };
  if (!data.message_id) throw new Error('Meta returned no outgoing message ID');
  return data.message_id;
}
