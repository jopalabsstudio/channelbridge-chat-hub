const $ = id => document.getElementById(id);
const filters = document.querySelectorAll('.filter');
let channel = 'all';
let activeId = null;
let threads = [];
let messages = [];
let status = { demo: false, channels: {} };
let token = sessionStorage.getItem('channelbridge-admin-token') || '';
let refreshTimer;

function showToast(message) {
  const node = $('toast'); node.textContent = message; node.classList.add('show');
  clearTimeout(showToast.timeout); showToast.timeout = setTimeout(() => node.classList.remove('show'), 4000);
}
async function api(path, options = {}) {
  const headers = { ...(options.body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) };
  const res = await fetch(path, { ...options, headers });
  if (res.status === 401) {
    const supplied = window.prompt('Admin token required. Enter ADMIN_TOKEN from your .env file:', token);
    if (supplied === null) throw new Error('Admin authentication required');
    token = supplied; sessionStorage.setItem('channelbridge-admin-token', token);
    if (!options._retried) return api(path, { ...options, _retried: true });
  }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
function time(iso) { return iso ? new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : ''; }
function initials(name) { return String(name || '?').trim().split(/\s+/).slice(0, 2).map(x => x[0]?.toUpperCase()).join(''); }
function el(tag, className, value) { const node = document.createElement(tag); if (className) node.className = className; if (value !== undefined) node.textContent = value; return node; }
function renderStatus() {
  const wrap = $('connector-status'); wrap.replaceChildren();
  for (const [name, ready] of Object.entries(status.channels)) {
    const row = el('div', 'connector'); const title = el('span');
    title.append(el('span', `dot ${ready ? 'ready' : ''}`), document.createTextNode(name[0].toUpperCase() + name.slice(1)));
    row.append(title, el('span', '', ready ? 'Configured' : 'Not set')); wrap.append(row);
  }
  $('demo-panel').hidden = !status.demo;
}
function renderThreads() {
  for (const name of ['whatsapp','messenger','telegram']) $('count-' + name).textContent = threads.filter(t => t.channel === name).length;
  $('count-all').textContent = threads.length;
  $('total-threads').textContent = threads.length;
  const query = $('search').value.trim().toLowerCase();
  const list = threads.filter(t => (channel === 'all' || t.channel === channel) &&
    `${t.displayName} ${t.channel} ${t.lastMessage?.text || ''}`.toLowerCase().includes(query));
  const box = $('threads'); box.replaceChildren();
  if (!list.length) box.append(el('p', 'empty', 'No matching conversations.'));
  for (const thread of list) {
    const button = el('button', `thread ${thread.id === activeId ? 'active' : ''}`); button.type = 'button';
    const info = el('div','thread-info'); const top = el('div','thread-top');
    top.append(el('strong','',thread.displayName), el('span','thread-time',time(thread.updatedAt)));
    info.append(top, el('div','thread-content',thread.lastMessage?.text || 'No messages'));
    const label = el('span', `channel-tag ${thread.channel}`, thread.channel);
    info.append(label); if (thread.mode === 'demo') info.append(el('span','tag-demo','SIMULATED'));
    button.append(el('span','initials',initials(thread.displayName)),info);
    button.addEventListener('click', () => selectThread(thread.id)); box.append(button);
  }
}
function renderMessages(forceEnd = false) {
  const box = $('messages');
  const wasNearBottom = box.scrollHeight - box.clientHeight - box.scrollTop < 90;
  box.replaceChildren();
  if (!activeId) { const empty = el('div','empty');empty.append(el('strong','', 'Welcome to ChannelBridge'),el('p','', 'Choose a conversation to view and reply.'));box.append(empty);return; }
  for (const message of messages) {
    const wrap = el('div',`bubble-wrap ${message.direction}`);
    wrap.append(el('div','bubble',message.text));
    const meta = el('div',`bubble-meta ${message.status === 'failed' ? 'failed' : ''}`,`${time(message.createdAt)} · ${message.status}`);
    if (message.error) meta.title = message.error;
    wrap.append(meta); box.append(wrap);
  }
  if (wasNearBottom || forceEnd) box.scrollTop = box.scrollHeight;
}
async function selectThread(id) {
  activeId = id;
  const selected = threads.find(t => t.id === id);
  if (!selected) { activeId = null; return; }
  $('selected-name').textContent = selected.displayName;
  $('selected-meta').textContent = `${selected.channel[0].toUpperCase() + selected.channel.slice(1)} · ${selected.accountId} · ${selected.externalUserId}`;
  $('selected-avatar').textContent = initials(selected.displayName);
  $('selected-mode').textContent = selected.mode === 'demo' ? 'SIMULATED' : 'LIVE';
  $('selected-mode').classList.toggle('live', selected.mode === 'live');
  $('reply-input').disabled = false; $('reply-input').placeholder = 'Write a reply...';
  $('send-button').disabled = false;
  $('composer-note').textContent = selected.mode === 'demo' ? 'Demo reply — saved locally, not delivered externally.' : 'Live reply — sent via the selected provider API. Provider messaging windows apply.';
  renderThreads(); await refreshMessages(true);
}
async function refreshMessages(force = false) {
  if (!activeId) return;
  const id = activeId;
  const data = await api(`/api/threads/${encodeURIComponent(id)}/messages`);
  if (id !== activeId) return;
  if (force || JSON.stringify(messages) !== JSON.stringify(data.messages)) { messages = data.messages; renderMessages(force); }
}
async function refresh() {
  try {
    const data = await api('/api/threads');
    threads = data.threads; renderThreads();
    if (activeId && !threads.some(t => t.id === activeId)) { activeId = null; messages = [];renderMessages(); }
    await refreshMessages();
  } catch (e) { showToast(e.message); }
}
filters.forEach(button => button.addEventListener('click', () => {
  channel = button.dataset.channel;
  filters.forEach(b => b.classList.toggle('active',b === button));renderThreads();
}));
$('search').addEventListener('input',renderThreads);
$('demo-form').addEventListener('submit',async event => {
  event.preventDefault();
  const btn = event.submitter; btn.disabled = true;
  try {
    const result = await api('/api/demo/inbound',{ method: 'POST', body: JSON.stringify({ channel: $('demo-channel').value,
      displayName: $('demo-name').value, text: $('demo-text').value }) });
    channel = 'all'; filters.forEach(b => b.classList.toggle('active',b.dataset.channel === 'all'));
    await refresh();await selectThread(result.threadId);showToast('Simulated incoming message received');
  } catch (e) { showToast(e.message); } finally { btn.disabled = false; }
});
$('reply-form').addEventListener('submit', async event => {
  event.preventDefault();
  const content = $('reply-input').value.trim();if (!content || !activeId) return;
  $('send-button').disabled = true;
  try { await api(`/api/threads/${encodeURIComponent(activeId)}/reply`, { method: 'POST', body: JSON.stringify({ text: content }) });
    $('reply-input').value = '';showToast('Reply saved / sent successfully'); }
  catch (e) { showToast(e.message); } finally { $('send-button').disabled = false;await refresh(); }
});
$('reply-input').addEventListener('keydown',event => {
  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault();$('reply-form').requestSubmit(); }
});
(async () => {
  try { status = await api('/api/status'); renderStatus();await refresh();
    const first = threads[0]; if (first) await selectThread(first.id);
    refreshTimer = setInterval(() => { if (!document.hidden) refresh(); },3000);
  } catch (e) { showToast(e.message); }
})();
