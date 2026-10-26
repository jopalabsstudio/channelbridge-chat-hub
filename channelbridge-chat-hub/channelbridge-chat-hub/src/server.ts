import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { ChatHub } from './service.ts';
import { InboxStore } from './storage.ts';
import { parseTelegram, sendTelegram } from './providers/telegram.ts';
import { parseMeta, sendWhatsApp, sendMessenger, verifyMetaSignature } from './providers/meta.ts';
import type { Channel, Thread } from './types.ts';

const env = process.env;
const host = env.HOST || '127.0.0.1';
const port = Number(env.PORT || '4177');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
if (!['127.0.0.1', 'localhost', '::1'].includes(host) && !env.ADMIN_TOKEN) {
  throw new Error('ADMIN_TOKEN must be configured when binding a non-local network interface');
}
const store = new InboxStore(env.DATA_FILE || './data/inbox.json');
await store.init();
const metaVersion = env.META_GRAPH_VERSION || 'v26.0';
if (!/^v\d+\.\d+$/.test(metaVersion)) throw new Error('Invalid META_GRAPH_VERSION');
const hub = new ChatHub(store, async (thread: Thread, text: string) => {
  switch (thread.channel) {
    case 'telegram': return sendTelegram(thread, text, env.TELEGRAM_BOT_TOKEN || '');
    case 'whatsapp': return sendWhatsApp(thread, text, env.WHATSAPP_ACCESS_TOKEN || '', metaVersion);
    case 'messenger': return sendMessenger(thread, text, env.MESSENGER_PAGE_ACCESS_TOKEN || '', metaVersion);
  }
});

function json(res: ServerResponse, code: number, data: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(data));
}
function text(res: ServerResponse, code: number, value: string): void {
  res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }); res.end(value);
}
function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a); const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
async function rawBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length; if (size > 256 * 1024) throw new Error('Request body too large'); chunks.push(buf); }
  return Buffer.concat(chunks);
}
function parseBody(raw: Buffer): unknown { try { return JSON.parse(raw.toString('utf8')); } catch { throw new Error('Invalid JSON'); } }
function authorized(req: IncomingMessage): boolean {
  const admin = env.ADMIN_TOKEN;
  if (!admin) return true; // Local-only convenience mode; do not expose without token.
  const given = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : '';
  return safeEqual(given, admin);
}
const webRoot = fileURLToPath(new URL('../public/', import.meta.url));

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    const path = url.pathname;
    if (path === '/api/health' && req.method === 'GET') return json(res, 200, { ok: true });

    // Webhooks are independent of dashboard auth and ALWAYS require provider authentication.
    if (path === '/webhooks/telegram' && req.method === 'POST') {
      if (!env.TELEGRAM_WEBHOOK_SECRET || !env.TELEGRAM_BOT_TOKEN) return json(res, 503, { error: 'Telegram not configured' });
      const signature = String(req.headers['x-telegram-bot-api-secret-token'] || '');
      if (!safeEqual(signature, env.TELEGRAM_WEBHOOK_SECRET)) return json(res, 401, { error: 'Invalid Telegram secret' });
      for (const message of parseTelegram(parseBody(await rawBody(req)))) await store.receive(message);
      return json(res, 200, { ok: true });
    }
    if (path === '/webhooks/meta' && req.method === 'GET') {
      if (url.searchParams.get('hub.mode') !== 'subscribe' || !env.META_VERIFY_TOKEN ||
        !safeEqual(url.searchParams.get('hub.verify_token') || '', env.META_VERIFY_TOKEN)) return text(res, 403, 'Forbidden');
      return text(res, 200, url.searchParams.get('hub.challenge') || '');
    }
    if (path === '/webhooks/meta' && req.method === 'POST') {
      if (!env.META_APP_SECRET) return json(res, 503, { error: 'Meta app secret not configured' });
      const raw = await rawBody(req);
      if (!verifyMetaSignature(raw, String(req.headers['x-hub-signature-256'] || ''), env.META_APP_SECRET)) return json(res, 401, { error: 'Invalid Meta signature' });
      for (const message of parseMeta(parseBody(raw), env.WHATSAPP_PHONE_NUMBER_ID || '', env.MESSENGER_PAGE_ID || '')) await store.receive(message);
      return json(res, 200, { ok: true });
    }

    if (path.startsWith('/api/')) {
      if (!authorized(req)) return json(res, 401, { error: 'Invalid admin token' });
      if (path === '/api/status' && req.method === 'GET') return json(res, 200, {
        demo: env.DEMO_ENABLED === 'true',
        channels: { telegram: Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_WEBHOOK_SECRET),
          whatsapp: Boolean(env.WHATSAPP_PHONE_NUMBER_ID && env.WHATSAPP_ACCESS_TOKEN && env.META_APP_SECRET),
          messenger: Boolean(env.MESSENGER_PAGE_ID && env.MESSENGER_PAGE_ACCESS_TOKEN && env.META_APP_SECRET) }
      });
      if (path === '/api/threads' && req.method === 'GET') return json(res, 200, { threads: store.listThreads() });
      const detail = /^\/api\/threads\/([a-z0-9-]+)\/messages$/.exec(path);
      if (detail && req.method === 'GET') {
        if (!store.getThread(detail[1])) return json(res, 404, { error: 'Conversation not found' });
        return json(res, 200, { messages: store.listMessages(detail[1]) });
      }
      const reply = /^\/api\/threads\/([a-z0-9-]+)\/reply$/.exec(path);
      if (reply && req.method === 'POST') {
        const body = parseBody(await rawBody(req)) as { text?: unknown };
        if (typeof body?.text !== 'string' || !body.text.trim() || body.text.length > 2000) return json(res, 400, { error: 'Reply must be 1–2000 characters' });
        if (!store.getThread(reply[1])) return json(res, 404, { error: 'Conversation not found' });
        try { await hub.reply(reply[1], body.text); return json(res, 200, { ok: true }); }
        catch (error) { return json(res, 502, { error: error instanceof Error ? error.message : 'Send failed' }); }
      }
      if (path === '/api/demo/inbound' && req.method === 'POST') {
        if (env.DEMO_ENABLED !== 'true') return json(res, 403, { error: 'Demo disabled' });
        const body = parseBody(await rawBody(req)) as { channel?: unknown; displayName?: unknown; text?: unknown; externalUserId?: unknown };
        if (!['telegram', 'whatsapp', 'messenger'].includes(String(body?.channel)) ||
            typeof body.displayName !== 'string' || !body.displayName.trim() || body.displayName.length > 100 ||
            typeof body.text !== 'string' || !body.text.trim() || body.text.length > 4000 ||
            (body.externalUserId !== undefined && (typeof body.externalUserId !== 'string' || body.externalUserId.length > 100))) {
          return json(res, 400, { error: 'Invalid demo message' });
        }
        const threadId = await hub.simulateInbound(body.channel as Channel, body.displayName, body.text,
          typeof body.externalUserId === 'string' ? body.externalUserId : undefined);
        return json(res, 201, { threadId });
      }
      return json(res, 404, { error: 'Not found' });
    }

    if (req.method === 'GET' && (path === '/' || path === '/app.js' || path === '/styles.css')) {
      const file = path === '/' ? 'index.html' : path.slice(1);
      const mime = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html';
      const content = await readFile(join(webRoot, file));
      res.writeHead(200, { 'content-type': `${mime}; charset=utf-8`, 'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'" });
      return res.end(content);
    }
    return json(res, 404, { error: 'Not found' });
  } catch (error) {
    const badInput = error instanceof SyntaxError || (error instanceof Error && /Invalid|too large|Missing/.test(error.message));
    return json(res, badInput ? 400 : 500, { error: badInput ? 'Invalid request' : 'Internal error' });
  }
});

if (env.DEMO_ENABLED === 'true' && store.listThreads().length === 0) {
  await hub.simulateInbound('whatsapp', 'Mara Santos', 'Hello! Can someone help me with my order?', 'sample-wa');
  await hub.simulateInbound('messenger', 'Alex Rivera', 'Do you have a product guide I can read?', 'sample-fb');
  await hub.simulateInbound('telegram', 'Taylor Cruz', 'Hi, I need help getting started.', 'sample-tg');
}
server.listen(port, host, () => console.log(`ChannelBridge is running at http://${host}:${port}`));
process.on('SIGTERM', () => server.close());
