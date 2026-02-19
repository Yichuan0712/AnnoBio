/**
 * In-app alert modal using the same design as other modals (no browser alert()).
 * Message must be in English.
 * @param {string} message - Body text (English).
 * @param {{ title?: string }} [options] - Optional title (default "Message").
 */
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

export function showAlert(message, options = {}) {
  const title = (options.title != null && options.title !== '') ? String(options.title) : 'Message';
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay modal-overlay--alert';
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'alert-modal-title');
  overlay.innerHTML = `
    <div class="modal-panel modal-panel--alert">
      <div class="modal-header">
        <h2 id="alert-modal-title" class="modal-title">${escapeHtml(title)}</h2>
        <button type="button" class="modal-close" aria-label="Close">×</button>
      </div>
      <div class="modal-body modal-body--alert">
        <p class="alert-modal-message">${escapeHtml(message)}</p>
      </div>
      <div class="modal-alert-footer">
        <button type="button" class="btn btn-secondary alert-modal-ok">OK</button>
      </div>
    </div>
  `;

  function close() {
    overlay.remove();
    document.body.style.overflow = '';
    document.removeEventListener('keydown', onKeyDown);
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') close();
  }

  overlay.querySelector('.modal-close').addEventListener('click', close);
  overlay.querySelector('.alert-modal-ok').addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener('keydown', onKeyDown);

  document.body.style.overflow = 'hidden';
  document.body.appendChild(overlay);
}
