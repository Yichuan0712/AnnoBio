import test from 'node:test';
import assert from 'node:assert/strict';
import { mountAgentChatSession } from '../src/agentChatSession.js';

// Only the DOM surface used by the chat. Count replacements and retain node identity
// to detect a full-history rebuild even when the rendered text looks identical.
class Element {
  children = [];
  listeners = new Map();
  classList = { add() {}, remove() {}, toggle() {} };
  style = {};
  value = '';
  isConnected = true;
  replacements = 0;
  set innerHTML(value) { this.html = value; this.children = []; this.replacements += 1; }
  get innerHTML() { return this.html || ''; }
  appendChild(child) { this.children.push(child); return child; }
  append(...children) { this.children.push(...children); }
  setAttribute() {}
  focus() { this.focused = true; }
  addEventListener(name, handler) { this.listeners.set(name, handler); }
  removeEventListener(name) { this.listeners.delete(name); }
  closest() { return null; }
  querySelector(selector) {
    for (const child of this.children) {
      if (child.className?.split(' ').includes(selector.slice(1))) return child;
      const found = child.querySelector(selector);
      if (found) return found;
    }
    return null;
  }
}

const tick = () => new Promise(resolve => setImmediate(resolve));

test('web empty-chat examples fill a saved draft without sending and stay out of desktop chats', async (t) => {
  const original = { document: globalThis.document, window: globalThis.window, fetch: globalThis.fetch };
  const sessions = [];
  t.after(() => { sessions.forEach(session => session.destroy()); Object.assign(globalThis, original); });
  globalThis.document = Object.assign(new Element(), { createElement: () => new Element() });
  const requests = [];
  globalThis.fetch = async (url) => {
    requests.push(url);
    if (url === '/api/credentials') return Response.json([]);
    assert.equal(url, '/api/settings');
    return Response.json({});
  };
  for (const desktop of [false, true]) {
    globalThis.window = desktop ? { electronAPI: {} } : {};
    const chat = { id: 'new', messages: [], unsentDraft: 'My task' };
    const messagesEl = new Element();
    const inputEl = new Element();
    let changed = 0;
    const session = mountAgentChatSession({ overlay: new Element(), messagesEl, inputEl, sendButtonEl: new Element(),
      resolveConversation: () => chat, onConversationDraftChanged: () => { changed += 1; },
      workspace: { hasProject: () => true, getCanvasState: () => ({ nodes: [], connections: [] }) } });
    sessions.push(session);
    session.setConversation(chat);
    const welcome = messagesEl.querySelector('.agent-window__welcome');
    if (desktop) {
      assert.equal(welcome, null);
    } else {
      assert.ok(welcome);
      const example = welcome.querySelector('.agent-window__welcome-example');
      example.listeners.get('click')();
      assert.ok(inputEl.value.startsWith('My task\n\n'));
      assert.equal(chat.unsentDraft, inputEl.value);
      assert.equal(changed, 1);
      assert.equal(inputEl.focused, true);
      assert.equal(chat.messages.length, 0);
      welcome.querySelector('.agent-window__welcome-close').listeners.get('click')();
      assert.equal(chat.welcomeDismissed, true);
      assert.equal(changed, 2);
      assert.equal(chat.unsentDraft, inputEl.value);
      assert.equal(chat.messages.length, 0);
      assert.equal(messagesEl.querySelector('.agent-window__welcome'), null);
      // Rendering the same conversation again must not bring dismissed suggestions back.
      session.setConversation(chat);
      assert.equal(messagesEl.querySelector('.agent-window__welcome'), null);
      chat.messages.push({ role: 'user', content: 'Hello' },
        { role: 'tool', name: 'web_search', label: 'Searched the web', content: JSON.stringify({ results: [
          { title: 'Official source', url: 'https://example.org/' },
          { title: 'Unsafe source', url: 'javascript:alert(1)' },
        ] }) },
        { role: 'tool', name: 'read_webpage', label: 'Read a webpage', ok: false, content: '{"error":"The website blocked this request."}' });
      session.setConversation(chat);
      assert.equal(messagesEl.querySelector('.agent-window__welcome'), null);
      const sources = messagesEl.querySelector('.agent-window__web-sources');
      assert.equal(sources.children.length, 1);
      assert.equal(sources.children[0].href, 'https://example.org/');
      assert.equal(sources.children[0].textContent, 'Official source');
      assert.equal(messagesEl.querySelector('.agent-window__web-error').textContent, 'The website blocked this request.');
    }
    await tick();
  }
  assert.ok(requests.every(url => url === '/api/credentials' || url === '/api/settings'));
});

test('streaming a long chat retains history DOM and updates only the live response', async (t) => {
  const original = { document: globalThis.document, window: globalThis.window,
    fetch: globalThis.fetch, requestAnimationFrame: globalThis.requestAnimationFrame };
  let session;
  t.after(() => { session?.destroy(); Object.assign(globalThis, original); });
  const frames = [];
  globalThis.document = Object.assign(new Element(), { createElement: () => new Element() });
  globalThis.window = {};
  globalThis.requestAnimationFrame = callback => frames.push(callback);
  let stream;
  let started;
  const requested = new Promise(resolve => { started = resolve; });
  globalThis.fetch = async (url) => {
    if (url === '/api/credentials') return Response.json([{ id: 'model', model: 'test', last_check_ok: true }]);
    if (url === '/api/settings') return Response.json({ default_agent_credential_id: 'model' });
    if (String(url).startsWith('/api/agent/context')) return Response.json({ context_tokens: 1000000, reply_tokens: 8192 });
    assert.equal(url, '/api/agent/turn');
    const body = new ReadableStream({ start(controller) { stream = controller; } });
    started();
    return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
  };
  const chat = { id: 'long', messages: Array.from({ length: 200 }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user', content: `Historical message ${i}`,
  })) };
  const overlay = new Element();
  const messagesEl = new Element();
  const inputEl = new Element();
  const sendButtonEl = new Element();
  session = mountAgentChatSession({ overlay, messagesEl, inputEl, sendButtonEl,
    resolveConversation: () => chat, workspace: { getCanvasState: () => ({ nodes: [], connections: [] }) } });
  session.setConversation(chat);
  for (let attempt = 0; inputEl.disabled && attempt < 100; attempt += 1) await tick();
  assert.equal(inputEl.disabled, false);
  inputEl.value = 'Continue';
  sendButtonEl.listeners.get('click')();
  await requested;
  const history = [...messagesEl.children];
  const replacements = messagesEl.replacements;
  const encoder = new TextEncoder();
  for (let i = 0; i < 30; i += 1) {
    stream.enqueue(encoder.encode('data: {"type":"text","delta":"word "}\n\n'));
    await tick();
    while (frames.length) frames.shift()();
    assert.equal(messagesEl.replacements, replacements);
    assert.equal(messagesEl.children[0], history[0]);
  }
  const pending = messagesEl.children.at(-1);
  assert.equal(pending.querySelector('.agent-window__message-content').innerHTML, 'word '.repeat(30));
  stream.enqueue(encoder.encode('data: {"type":"done","finish_reason":"stop"}\n\n'));
  stream.close();
  for (let attempt = 0; chat.pending && attempt < 100; attempt += 1) await tick();
  assert.equal(chat.pending, false);
  assert.equal(chat.messages.at(-1).content, 'word '.repeat(30));
});
