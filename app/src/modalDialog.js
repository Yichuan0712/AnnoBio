/** Mount a child modal without letting focus or edits reach its parent. */
export function mountModalDialog(overlay, onClose, options = {}) {
  const previousFocus = document.activeElement;
  const parent = options.parent ?? previousFocus?.closest('.modal-overlay');
  const wasInert = parent?.inert;
  const previousOverflow = document.body.style.overflow;
  let closed = false;
  if (parent) {
    overlay.style.zIndex = String((Number(getComputedStyle(parent).zIndex) || 1000) + 1);
    parent.inert = true;
  }
  function close() {
    if (closed || (options.canClose && !options.canClose())) return;
    closed = true;
    overlay.remove();
    if (parent) parent.inert = wasInert;
    document.body.style.overflow = previousOverflow;
    onClose?.();
    if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    else parent?.querySelector('.prompt-output-add-key, .prompt-detail-schema-btn-edit, button')?.focus({ preventScroll: true });
  }
  overlay.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === 'Tab') {
      const controls = [...overlay.querySelectorAll('button, input, select, textarea, [tabindex="0"]')]
        .filter((el) => !el.disabled && !el.closest('[hidden]') && el.getClientRects().length);
      const first = controls[0];
      const last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
  });
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  document.body.style.overflow = 'hidden';
  document.body.appendChild(overlay);
  return close;
}
