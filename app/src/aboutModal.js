import { mountModalDialog } from './modalDialog.js';
import { attachExternalBrowserLink } from './externalLinks.js';
import { showAlert } from './alertModal.js';
import { ABOUT_AFFILIATION, ABOUT_COPYRIGHT, appInfoRows } from './aboutInfo.js';

const logoUrl = new URL('../../images/logo.png', import.meta.url).href;

export function openAboutModal() {
  const existing = document.querySelector('.modal-overlay--about');
  if (existing) {
    existing.querySelector('.about-close')?.focus();
    return;
  }
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay modal-overlay--about';
  overlay.setAttribute('aria-labelledby', 'about-title');
  overlay.innerHTML = `
    <div class="modal-panel modal-panel--about">
      <div class="modal-header">
        <h2 id="about-title" class="modal-title">About AnnoBio</h2>
        <button type="button" class="modal-close" aria-label="Close">×</button>
      </div>
      <div class="modal-body about-content">
        <div class="about-product">
          <img class="about-logo" src="${logoUrl}" width="40" height="40" alt="">
          <div><div class="about-product-name">AnnoBio</div><div class="about-tagline">Biomedical AI workflows</div></div>
        </div>
        <div class="about-details">
          <dl class="about-build-info" aria-live="polite"><dt>Version:</dt><dd>Loading…</dd></dl>
          <div class="about-meta">
            <p>${ABOUT_AFFILIATION}</p>
            <p>${ABOUT_COPYRIGHT} · <a href="https://github.com/Yichuan0712/AnnoBio/blob/main/LICENSE" target="_blank" rel="noopener" tabindex="0">AnnoBio Non-Commercial License</a></p>
            <p>Paper coming soon.</p>
          </div>
        </div>
      </div>
      <div class="modal-alert-footer about-footer">
        <span class="about-copy-status" role="status"></span>
        <button type="button" class="btn btn-secondary about-copy" disabled>Copy</button>
        <button type="button" class="btn btn-primary about-close">OK</button>
      </div>
    </div>`;
  const close = mountModalDialog(overlay);
  overlay.querySelector('.modal-close').addEventListener('click', close);
  overlay.querySelector('.about-close').addEventListener('click', close);
  overlay.addEventListener('click', (event) => { if (event.target === overlay) close(); });
  overlay.querySelectorAll('a').forEach((link) => attachExternalBrowserLink(link,
    (message) => showAlert(message, { title: 'Open link' })));
  overlay.querySelector('.about-close').focus();
  const details = overlay.querySelector('.about-build-info');
  const copy = overlay.querySelector('.about-copy');
  const status = overlay.querySelector('.about-copy-status');
  function showInfo(info) {
    details.replaceChildren(...appInfoRows(info).flatMap(([label, value]) => {
      const term = document.createElement('dt');
      const description = document.createElement('dd');
      term.textContent = `${label}:`;
      description.textContent = value;
      return [term, description];
    }));
  }
  Promise.resolve().then(() => window.electronAPI?.getAppInfo?.()).then((info) => {
    showInfo(info);
    copy.disabled = !info || !window.electronAPI?.copyAppInfo;
  }).catch(() => { showInfo(null); });
  copy.addEventListener('click', async () => {
    copy.disabled = true;
    try {
      const result = await window.electronAPI.copyAppInfo();
      if (!result?.ok) throw new Error('Copy failed');
      status.textContent = 'Copied.';
    } catch {
      status.textContent = 'Could not copy information.';
    } finally {
      copy.disabled = false;
    }
  });
}
