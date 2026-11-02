import { mountModalDialog } from './modalDialog.js';
import { attachExternalBrowserLink } from './externalLinks.js';
import { showAlert } from './alertModal.js';

export function openAboutModal() {
  const existing = document.querySelector('.modal-overlay--about');
  if (existing) {
    existing.querySelector('.modal-close')?.focus();
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
        <p class="about-version" aria-live="polite">Loading version…</p>
        <p>A visual workspace for building, running, evaluating, and improving biomedical AI workflows.</p>
        <div class="about-links">
          <a href="https://annobio.org" target="_blank" rel="noopener" tabindex="0">Website</a>
          <a href="https://github.com/Yichuan0712/AnnoBio" target="_blank" rel="noopener" tabindex="0">Source code</a>
          <a href="https://github.com/Yichuan0712/AnnoBio/releases" target="_blank" rel="noopener" tabindex="0">Releases</a>
        </div>
        <h3>Institution</h3>
        <p>Digital Biology Lab, Health Informatics Institute, Morsani College of Medicine,
          University of South Florida, Tampa, Florida, USA</p>
        <h3>Contact</h3>
        <p>Yichuan Zhang — yichuan@usf.edu<br>Duolin Wang — duolinwang@usf.edu</p>
        <h3>License</h3>
        <p>© 2026 Yichuan Zhang. Licensed under
          <a href="https://polyformproject.org/licenses/noncommercial/1.0.0" target="_blank" rel="noopener" tabindex="0">PolyForm Noncommercial 1.0.0</a>.
          Commercial uses outside the license's permitted purposes require separate authorization.
          Third-party software and data retain their own licenses.</p>
        <h3>Paper</h3>
        <p>Paper coming soon.</p>
      </div>
      <div class="modal-alert-footer"><button type="button" class="btn btn-primary about-close">Close</button></div>
    </div>`;
  const close = mountModalDialog(overlay);
  overlay.querySelector('.modal-close').addEventListener('click', close);
  overlay.querySelector('.about-close').addEventListener('click', close);
  overlay.addEventListener('click', (event) => { if (event.target === overlay) close(); });
  overlay.querySelectorAll('a').forEach((link) => attachExternalBrowserLink(link,
    (message) => showAlert(message, { title: 'Open link' })));
  overlay.querySelector('.modal-close').focus();
  const version = overlay.querySelector('.about-version');
  Promise.resolve().then(() => window.electronAPI?.getAppInfo?.()).then((info) => {
    version.textContent = typeof info?.version === 'string' && info.version.trim()
      ? `Version ${info.version.trim()}` : 'Version unavailable';
  }).catch(() => { version.textContent = 'Version unavailable'; });
}
