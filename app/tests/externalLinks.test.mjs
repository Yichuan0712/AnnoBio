import test from 'node:test';
import assert from 'node:assert/strict';
import { allowedExternalUrl, attachExternalBrowserLink } from '../src/externalLinks.js';

const screenUrl = 'https://console.wenglab.org/docs/getting-started/auth';

test('credential documentation and existing OpenRouter OAuth can open externally', () => {
  for (const url of [screenUrl, 'https://api.iucnredlist.org/',
    'https://www.guidetopharmacology.org/webServices.jsp', 'https://www.synapse.org/PersonalAccessTokens',
    'https://openrouter.ai/auth?callback_url=http%3A%2F%2F127.0.0.1%3A8000%2Fcallback']) {
    assert.equal(allowedExternalUrl(url), url);
  }
  for (const url of ['javascript:alert(1)', 'file:///C:/Windows/system32/cmd.exe',
    'http://console.wenglab.org/docs/getting-started/auth', 'https://console.wenglab.org.evil.test/docs/getting-started/auth',
    'https://openrouter.ai@evil.test/auth', 'https://user:pass@openrouter.ai/auth',
    'https://openrouter.ai:8443/auth', 'https://console.wenglab.org/unrelated', null]) {
    assert.equal(allowedExternalUrl(url), null);
  }
});

test('desktop clicks and middle clicks use the system-browser bridge; web keeps new-tab behavior', async () => {
  const original = globalThis.window;
  const handlers = {};
  const link = { href: screenUrl, addEventListener: (name, fn) => { handlers[name] = fn; } };
  const calls = [];
  let prevented = 0;
  try {
    globalThis.window = { electronAPI: { openExternal: async (url) => { calls.push(url); return { ok: true }; } } };
    attachExternalBrowserLink(link);
    handlers.click({ type: 'click', preventDefault: () => { prevented++; } });
    handlers.auxclick({ type: 'auxclick', button: 1, preventDefault: () => { prevented++; } });
    handlers.auxclick({ type: 'auxclick', button: 2, preventDefault: () => { prevented++; } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, [screenUrl, screenUrl]);
    assert.equal(prevented, 2);
    globalThis.window = {};
    handlers.click({ type: 'click', preventDefault: () => { prevented++; } });
    assert.equal(prevented, 2);
  } finally {
    if (original === undefined) delete globalThis.window;
    else globalThis.window = original;
  }
});
