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

/**
 * Scrollable monospace body (e.g. JSON). Message may be non-English.
 * @param {string} title
 * @param {string} bodyText
 */
export function showAlertPreformatted(title, bodyText) {
  const t = title != null && title !== '' ? String(title) : 'Details';
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay modal-overlay--alert';
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'alert-pre-modal-title');
  overlay.innerHTML = `
    <div class="modal-panel modal-panel--alert modal-panel--alert-wide">
      <div class="modal-header">
        <h2 id="alert-pre-modal-title" class="modal-title">${escapeHtml(t)}</h2>
        <button type="button" class="modal-close" aria-label="Close">×</button>
      </div>
      <div class="modal-body modal-body--alert">
        <pre class="alert-modal-pre" tabindex="0"></pre>
      </div>
      <div class="modal-alert-footer">
        <button type="button" class="btn btn-secondary alert-modal-ok">OK</button>
      </div>
    </div>
  `;
  const pre = overlay.querySelector('.alert-modal-pre');
  pre.textContent = String(bodyText ?? '');
  pre.style.whiteSpace = 'pre-wrap';
  pre.style.maxHeight = '70vh';
  pre.style.overflow = 'auto';
  pre.style.fontSize = '12px';
  pre.style.margin = '0';
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

/**
 * Confirm modal (same style as alert): title, message, Cancel + primary action.
 * @param {string} message - Body text.
 * @param {{ title?: string, confirmText?: string }} [options] - title (default "Confirm"), confirmText (default "OK").
 * @returns {Promise<boolean>} - true if user clicked confirm, false if Cancel/Close/Escape.
 */
export function showConfirm(message, options = {}) {
  const title = (options.title != null && options.title !== '') ? String(options.title) : 'Confirm';
  const confirmText = (options.confirmText != null && options.confirmText !== '') ? String(options.confirmText) : 'OK';
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay modal-overlay--alert';
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'confirm-modal-title');
  overlay.innerHTML = `
    <div class="modal-panel modal-panel--alert">
      <div class="modal-header">
        <h2 id="confirm-modal-title" class="modal-title">${escapeHtml(title)}</h2>
        <button type="button" class="modal-close" aria-label="Close">×</button>
      </div>
      <div class="modal-body modal-body--alert">
        <p class="alert-modal-message">${escapeHtml(message)}</p>
      </div>
      <div class="modal-alert-footer">
        <button type="button" class="btn btn-secondary confirm-modal-cancel">Cancel</button>
        <button type="button" class="btn btn-secondary confirm-modal-ok">${escapeHtml(confirmText)}</button>
      </div>
    </div>
  `;

  let resolved = false;
  const promise = new Promise((resolve) => {
    function done(ok) {
      if (resolved) return;
      resolved = true;
      overlay.remove();
      document.body.style.overflow = '';
      document.removeEventListener('keydown', onKeyDown);
      resolve(ok);
    }
    function close() {
      done(false);
    }
    function confirm() {
      done(true);
    }
    function onKeyDown(e) {
      if (e.key === 'Escape') close();
    }
    overlay.querySelector('.modal-close').addEventListener('click', close);
    overlay.querySelector('.confirm-modal-cancel').addEventListener('click', close);
    overlay.querySelector('.confirm-modal-ok').addEventListener('click', confirm);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });
    document.addEventListener('keydown', onKeyDown);
  });

  document.body.style.overflow = 'hidden';
  document.body.appendChild(overlay);
  return promise;
}
