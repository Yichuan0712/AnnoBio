/** Keeps the static startup page usable while the editor and local services load. */
export function createStartupScreen(root = document) {
  const overlay = root.querySelector('.app-startup');
  if (!overlay) return { status() {}, fail() {}, finish() {} };
  const status = overlay.querySelector('.app-startup-status');
  const detail = overlay.querySelector('.app-startup-detail');
  const retry = overlay.querySelector('.app-startup-retry');
  let ended = false;
  const covered = new Map();
  const lockWorkspace = () => {
    for (const child of overlay.parentElement?.children || []) {
      if (child === overlay || covered.has(child)) continue;
      covered.set(child, child.inert);
      child.inert = true;
    }
  };
  const observer = new MutationObserver(lockWorkspace);
  observer.observe(overlay.parentElement, { childList: true });
  lockWorkspace();
  const slowTimer = setTimeout(() => {
    detail.textContent = 'This is taking longer than usual. The workspace is still starting.';
    detail.hidden = false;
    retry.hidden = false;
  }, 12000);
  retry.addEventListener('click', () => window.location.reload());
  return {
    status(text) { if (!ended) status.textContent = text; },
    fail(error) {
      if (ended) return;
      ended = true;
      clearTimeout(slowTimer);
      overlay.classList.add('app-startup--error');
      overlay.setAttribute('aria-busy', 'false');
      status.textContent = 'Could not open workspace';
      detail.textContent = error?.message || 'Please try again.';
      detail.hidden = false;
      retry.hidden = false;
      retry.focus();
    },
    finish() {
      if (ended) return;
      ended = true;
      clearTimeout(slowTimer);
      observer.disconnect();
      for (const [element, wasInert] of covered) element.inert = wasInert;
      overlay.setAttribute('aria-busy', 'false');
      // Give the completed workspace a frame to paint before revealing it. No minimum wait.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        overlay.classList.add('app-startup--leaving');
        const remove = () => overlay.remove();
        overlay.addEventListener('transitionend', (event) => { if (event.target === overlay) remove(); });
        setTimeout(remove, 220);
      }));
    },
  };
}
