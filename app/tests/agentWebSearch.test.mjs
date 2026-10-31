import test from 'node:test';
import assert from 'node:assert/strict';
import { agentToolDefinitions, executeAgentTool } from '../src/agent/tools/agentTools.js';
import { runAgentLoop } from '../src/agent/agentLoop.js';
import { formatAgentText } from '../src/agent/formatAgentText.js';
import { allowedWebSourceUrl, attachWebSourceLinks } from '../src/externalLinks.js';

test('web tools are offered on both platforms with and without a project', () => {
  for (const projectOpen of [true, false]) for (const attachments of [true, false]) {
    const names = agentToolDefinitions({ projectOpen, attachments }).map(tool => tool.function.name);
    assert.ok(names.includes('web_search'));
    assert.ok(names.includes('read_webpage'));
  }
});

test('web lookup limits stop repeated model calls while preserving sources and answer', async (t) => {
  const previousFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = previousFetch; });
  let turns = 0;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    if (url.includes('/api/agent/context')) return Response.json({ context_tokens: 128000, reply_tokens: 8192 });
    if (url.endsWith('/api/agent/web-search') || url.endsWith('/api/agent/webpage')) {
      requests.push(url);
      return Response.json(url.endsWith('web-search') ? { results: [{ title: 'Example', url: 'https://example.org/', snippet: 'Source evidence' }] }
        : { url: 'https://example.org/', title: 'Example', content: 'Read evidence' });
    }
    assert.ok(url.endsWith('/api/agent/turn'));
    turns += 1;
    const calls = [...Array.from({ length: 4 }, (_, i) => ({ id: `s${i}`, name: 'web_search', arguments: '{"query":"example"}' })),
      ...Array.from({ length: 5 }, (_, i) => ({ id: `r${i}`, name: 'read_webpage', arguments: '{"url":"https://example.org/"}' }))];
    const events = turns === 1 ? [{ type: 'tool_calls', tool_calls: calls }, { type: 'done', finish_reason: 'tool_calls' }]
      : [{ type: 'text', delta: 'Evidence: [Example](https://example.org/)' }, { type: 'done', finish_reason: 'stop' }];
    return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
  };
  const messages = [{ role: 'user', content: 'Look this up' }];
  const progress = [];
  assert.equal(await runAgentLoop({ messages, credentialId: 'model', runtime: { projectOpen: false }, workspaceSummary: '', onProgress: p => progress.push(p.status) }), 'answered');
  assert.equal(requests.filter(url => url.endsWith('web-search')).length, 2);
  assert.equal(requests.filter(url => url.endsWith('webpage')).length, 3);
  assert.equal(messages.filter(m => m.role === 'tool' && !m.ok).length, 4);
  assert.ok(messages.some(m => m.role === 'tool' && m.content.includes('Source evidence')));
  assert.ok(messages.at(-1).content.includes('https://example.org/'));
  assert.ok(progress.includes('Searching the web...'));
  assert.ok(progress.includes('Reading the webpage...'));
});

test('a workspace-only answer makes no web requests', async (t) => {
  const previousFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = previousFetch; });
  globalThis.fetch = async url => {
    if (url.includes('/api/agent/context')) return Response.json({ context_tokens: 128000, reply_tokens: 8192 });
    assert.ok(url.endsWith('/api/agent/turn'));
    return new Response('data: {"type":"text","delta":"Here is your workspace."}\n\ndata: {"type":"done","finish_reason":"stop"}\n\n');
  };
  const messages = [{ role: 'user', content: 'Explain this workspace' }];
  await runAgentLoop({ messages, credentialId: 'model', runtime: {}, workspaceSummary: 'No pipelines' });
  assert.equal(messages.at(-1).content, 'Here is your workspace.');
});

test('caller cancellation aborts web fetches and provider failures remain tool errors', async (t) => {
  const previousFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = previousFetch; });
  const controller = new AbortController();
  globalThis.fetch = (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    controller.abort();
  });
  const result = await executeAgentTool('web_search', { query: 'x' }, { signal: controller.signal });
  assert.equal(result.ok, false);
  globalThis.fetch = async () => Response.json({ error: 'Provider blocked this request.' });
  assert.equal((await executeAgentTool('web_search', { query: 'x' }, {})).ok, false);
});

test('source links render safely and code examples remain literal', () => {
  assert.match(formatAgentText('Read [Official docs](https://example.org/a?q=1&x=2).'), /href="https:\/\/example.org\/a\?q=1&amp;x=2"/);
  assert.match(formatAgentText('Source: https://example.org/a.'), />https:\/\/example.org\/a<\/a>\./);
  for (const text of ['[click](javascript:alert(1))', 'https://user:pass@example.org/', 'http://127.0.0.1/',
      '`https://example.org/`', '```python\nurl="https://example.org/"\n```']) {
    assert.doesNotMatch(formatAgentText(text), /<a /);
  }
  assert.doesNotMatch(formatAgentText('<img src=x onerror=alert(1)>'), /<img/);
  assert.match(formatAgentText('**bold** and `code`'), /<strong>bold<\/strong> and <code>code<\/code>/);
});

test('desktop source clicks open through a dedicated bridge and web keeps normal anchors', async (t) => {
  const previousWindow = globalThis.window;
  t.after(() => { globalThis.window = previousWindow; });
  const handlers = {};
  const opened = [];
  globalThis.window = { electronAPI: { openWebSource: async url => opened.push(url) } };
  attachWebSourceLinks({ addEventListener: (name, fn) => { handlers[name] = fn; } });
  let prevented = 0;
  const event = { type: 'click', target: { closest: () => ({ href: 'https://example.org/' }) }, preventDefault: () => { prevented += 1; } };
  handlers.click(event);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(opened, ['https://example.org/']);
  globalThis.window = {};
  handlers.click(event);
  assert.equal(prevented, 1);
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'https://user:pass@example.org/', 'http://localhost/', 'https://example.org:8443/']) {
    assert.equal(allowedWebSourceUrl(url), null);
  }
});
