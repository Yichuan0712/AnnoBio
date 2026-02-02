/**
 * This file will automatically be loaded by vite and run in the "renderer" context.
 * Node.js integration is disabled (recommended). We'll just use fetch().
 */

import './index.css';

async function checkBackend() {
  const el = document.getElementById('backend-status');

  try {
    const r = await fetch('http://127.0.0.1:8000/health');
    const data = await r.json();
    el.textContent = 'Backend OK: ' + JSON.stringify(data, null, 2);
  } catch (e) {
    el.textContent = 'Backend FAILED: ' + (e?.message || String(e));
  }
}

window.addEventListener('DOMContentLoaded', () => {
  const root = document.getElementById('app') || document.body;

  const wrap = document.createElement('div');
  wrap.style.padding = '16px';
  wrap.style.fontFamily = 'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial';
  wrap.innerHTML = `
    <h2 style="margin: 0 0 12px;">Electron + Python backend</h2>
    <button id="btn" style="padding: 8px 12px; cursor: pointer;">Check /health</button>
    <pre id="backend-status" style="margin-top: 12px; background: rgba(0,0,0,0.06); padding: 12px; border-radius: 8px;">Not checked</pre>
    <p style="opacity: 0.7; margin-top: 10px;">
      If this shows {"ok": true}, Electron ⇄ Python is working.
    </p>
  `;
  root.appendChild(wrap);

  document.getElementById('btn').addEventListener('click', checkBackend);

  // 启动后自动检查一次（可删）
  checkBackend();
});