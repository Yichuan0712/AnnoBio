// Regenerates the user guide screenshots in hub/templates/guide_images from the real front end.
//   node scripts/guide-screenshots/capture.mjs [--out <dir>] [scene ...]
// Needs app/node_modules (vite) and a local Chrome or Edge.
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const { createServer } = await import(pathToFileURL(path.join(root, 'app/node_modules/vite/dist/node/index.js')).href);
const { scenes } = await import(pathToFileURL(path.join(here, 'scenes.mjs')).href);

const args = process.argv.slice(2);
const outFlag = args.indexOf('--out');
const outDir = outFlag >= 0 ? path.resolve(args.splice(outFlag, 2)[1]) : path.join(root, 'hub/templates/guide_images');
const only = new Set(args);

const VIEWPORT = { width: 1280, height: 800, deviceScaleFactor: 2 };

const page = `<!doctype html><html><head><meta charset="utf-8"><title>AnnoBio guide</title>
<link rel="stylesheet" href="/src/index.css"><link rel="stylesheet" href="/src/topBar.css">
<link rel="stylesheet" href="/src/workflowCanvas.css"><link rel="stylesheet" href="/src/modals.css">
<link rel="stylesheet" href="/src/agentWindow.css">
<style>html,body,#app{margin:0;width:100%;height:100%;overflow:hidden}#app{display:flex;flex-direction:column}
#surface{flex:1;min-height:0;display:flex;flex-direction:column}.workflow-workspace{flex:1;min-height:0}</style>
</head><body><div id="app"><div id="bar"></div><div id="surface"></div></div>
<script type="module" src="/__guide/harness.js"></script></body></html>`;

const server = await createServer({
  root: path.join(root, 'app'),
  configFile: false,
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, fs: { allow: [root] } },
  plugins: [{
    name: 'guide-harness',
    configureServer(s) {
      s.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url, 'http://localhost');
        if (url.pathname === '/__guide/') {
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.end(page);
        } else if (url.pathname === '/__guide/harness.js') {
          const result = await s.transformRequest('/@fs/' + path.join(here, 'harness.js').replace(/\\/g, '/'));
          res.setHeader('Content-Type', 'application/javascript');
          res.end(result.code);
        } else if (url.pathname.startsWith('/images/')) {
          const file = path.join(root, url.pathname);
          if (!file.startsWith(path.join(root, 'images') + path.sep) || !existsSync(file)) return next();
          res.setHeader('Content-Type', file.endsWith('.webp') ? 'image/webp' : 'image/png');
          res.end(await fs.readFile(file));
        } else next();
      });
    },
  }],
});
await server.listen();
const origin = server.resolvedUrls.local[0].replace(/\/$/, '');

const browserPath = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
].find((p) => existsSync(p));
if (!browserPath) throw new Error('Chrome or Edge was not found.');
const profile = await fs.mkdtemp(path.join(root, '.cache', 'guide-browser-'));
const browser = spawn(browserPath, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
  '--font-render-hinting=none', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });

let ws;
try {
  const endpoint = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Browser startup timeout')), 20000);
    browser.stderr.on('data', (chunk) => {
      output += chunk;
      const match = output.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    browser.on('error', reject);
  });
  const targets = await (await fetch(new URL(endpoint).origin.replace('ws:', 'http:') + '/json/list')).json();
  ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  let seq = 0;
  const pending = new Map();
  ws.addEventListener('message', (event) => {
    const m = JSON.parse(event.data);
    const p = m.id && pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.error) p.reject(new Error(JSON.stringify(m.error))); else p.resolve(m.result);
  });
  const cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const evaluate = async (expression) => {
    const r = await cdp('Runtime.evaluate', { expression: `(async () => { ${expression} })()`, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails));
    return r.result?.value;
  };
  const until = async (expression, timeoutMs = 15000) => {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if (await evaluate(`return !!(${expression});`)) return;
      await wait(100);
    }
    throw new Error(`Timed out waiting for ${expression}; errors: ${JSON.stringify(await evaluate('return window.errors;'))}`);
  };
  const open = async (query = '') => {
    await cdp('Page.navigate', { url: `${origin}/__guide/${query}` });
    await wait(300);
    await until('window.ready === true', 30000);
  };
  const shot = async (name) => {
    await evaluate('document.activeElement?.blur?.(); return true;');
    await wait(400);
    const errors = await evaluate('return window.errors;');
    if (errors.length) throw new Error(`${name}: page errors ${JSON.stringify(errors)}`);
    const { data } = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await fs.writeFile(path.join(outDir, `${name}.png`), Buffer.from(data, 'base64'));
    console.log('saved', name);
  };
  const click = (selector) => evaluate(`const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('Missing ' + ${JSON.stringify(selector)}); el.click(); return true;`);

  await cdp('Page.enable');
  await cdp('Runtime.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { ...VIEWPORT, mobile: false });
  await cdp('Emulation.setFocusEmulationEnabled', { enabled: true });
  await fs.mkdir(outDir, { recursive: true });

  const ctx = { evaluate, until, wait, open, shot, click, cdp };
  for (const scene of scenes) {
    if (only.size && !only.has(scene.name)) continue;
    await scene.run(ctx);
  }
} finally {
  ws?.close();
  browser.kill();
  await server.close();
  await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
}
