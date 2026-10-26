import type { Incoming, Thread } from '../types.ts';

export function parseTelegram(body: unknown): Incoming[] {
  const update = body as { update_id?: number; message?: { message_id?: number; date?: number; text?: string;
    chat?: { id?: number | string; type?: string }; from?: { id?: number; first_name?: string; last_name?: string; is_bot?: boolean } } };
  const m = update?.message;
  if (!Number.isInteger(update?.update_id) || !Number.isInteger(m?.message_id) || typeof m?.text !== 'string' ||
      !m?.chat?.id || m.chat.type !== 'private' || m.from?.is_bot) return [];
  return [{ mode: 'live', channel: 'telegram', accountId: 'bot', externalUserId: String(m.chat.id),
    displayName: [m.from?.first_name, m.from?.last_name].filter(Boolean).join(' ') || String(m.chat.id),
    text: m.text, providerMessageId: `telegram:${update.update_id}`,
    receivedAt: m.date && Number.isFinite(m.date) ? new Date(m.date * 1000).toISOString() : undefined }];
}

export async function sendTelegram(thread: Thread, text: string, token: string, fetcher: typeof fetch = fetch): Promise<string> {
  if (!token) throw new Error('Telegram bot token is not configured');
  const response = await fetcher(`https://api.telegram.org/bot${encodeURIComponent(token)}/sendMessage`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: thread.externalUserId, text }), signal: AbortSignal.timeout(10000)
  });
  const data = await response.json() as { ok?: boolean; description?: string; result?: { message_id?: number } };
  if (!response.ok || data.ok !== true || data.result?.message_id === undefined) {
    throw new Error(`Telegram send failed (${response.status}): ${data.description ?? 'provider error'}`);
  }
  return String(data.result.message_id);
}
