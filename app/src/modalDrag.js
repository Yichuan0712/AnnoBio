/**
 * Makes all modal panels draggable by header and resizable by corner handle.
 */

function ensureResizeHandle(panel) {
  if (panel.querySelector('.modal-resize-handle')) return;
  const h = document.createElement('div');
  h.className = 'modal-resize-handle';
  h.setAttribute('aria-label', 'Resize');
  panel.appendChild(h);
}

function clampModalPosition(left, top, panelRect, headerRect) {
  const visibleEdge = 80;
  const visibleHeader = Math.max(40, headerRect?.height || 0);
  const minLeft = visibleEdge - panelRect.width;
  const maxLeft = window.innerWidth - visibleEdge;
  const minTop = 0;
  const maxTop = window.innerHeight - visibleHeader;
  return {
    left: Math.min(maxLeft, Math.max(minLeft, left)),
    top: Math.min(maxTop, Math.max(minTop, top)),
  };
}

export function initModalDrag() {
  const observer = new MutationObserver((list) => {
    list.forEach((m) => {
      m.addedNodes.forEach((node) => {
        if (node.nodeType !== 1) return;
        const overlay = node.classList?.contains('modal-overlay') ? node : node.querySelector?.('.modal-overlay');
        overlay?.querySelectorAll?.('.modal-panel').forEach(ensureResizeHandle);
      });
    });
  });
  observer.observe(document.body, { childList: true, subtree: true });

  document.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const panel = e.target.closest('.modal-panel');
    if (!panel) return;
    const overlay = panel.closest('.modal-overlay');
    if (!overlay) return;
    if (overlay.classList.contains('modal-overlay--maximized')) return;

    if (e.target.closest('.modal-resize-handle')) {
      e.preventDefault();
      const rect = panel.getBoundingClientRect();
      let startW = rect.width;
      let startH = rect.height;
      /* Run detail：与 CSS 一致，避免首次按下时宽高跳动 */
      if (panel.classList.contains('modal-panel--run-detail')) {
        const maxW = window.innerWidth * 0.88;
        const minW = Math.min(960, window.innerWidth * 0.85);
        startW = Math.max(rect.width, minW);
        startW = Math.min(startW, maxW);
        const maxH = window.innerHeight * 0.98;
        const minH = Math.min(520, window.innerHeight * 0.85);
        startH = Math.max(rect.height, minH);
        startH = Math.min(startH, maxH);
      }
      const startX = e.clientX;
      const startY = e.clientY;
      panel.style.width = startW + 'px';
      panel.style.height = startH + 'px';
      const onMove = (e2) => {
        const w = Math.max(280, Math.min(window.innerWidth * 0.9, startW + e2.clientX - startX));
        const h = Math.max(200, Math.min(window.innerHeight * 0.9, startH + e2.clientY - startY));
        panel.style.width = w + 'px';
        panel.style.height = h + 'px';
      };
      const onUp = () => {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        const stopNextClick = (e2) => {
          e2.stopPropagation();
          e2.preventDefault();
          document.removeEventListener('click', stopNextClick, true);
        };
        document.addEventListener('click', stopNextClick, true);
      };
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp, { once: true });
      return;
    }

    const header = e.target.closest('.modal-header');
    if (!header || e.target.closest('.modal-close') || e.target.closest('.modal-maximize') || e.target.closest('.modal-header-actions')) return;
    e.preventDefault();
    const rect = panel.getBoundingClientRect();
    const headerRect = header.getBoundingClientRect();
    const clampedStart = clampModalPosition(rect.left, rect.top, rect, headerRect);
    let x = e.clientX, y = e.clientY, left = clampedStart.left, top = clampedStart.top;
    /* Freeze the panel's current on-screen size BEFORE switching to fixed positioning.
       Without an explicit width/height, a `position:fixed` box with only `left`/`top` set
       falls back to shrink-to-fit sizing against its new (out-of-flow) containing block,
       which for wide multi-column layouts (e.g. Model Settings) can resolve to a narrower
       width than the original flex-centered layout -- looking like the whole panel shrank. */
    panel.style.width = rect.width + 'px';
    panel.style.height = rect.height + 'px';
    panel.style.position = 'fixed';
    panel.style.left = left + 'px';
    panel.style.top = top + 'px';
    panel.style.transform = 'none';
    panel.style.margin = '0';
    const onMove = (e2) => {
      const dx = e2.clientX - x, dy = e2.clientY - y;
      left += dx; top += dy; x = e2.clientX; y = e2.clientY;
      const clamped = clampModalPosition(left, top, rect, headerRect);
      left = clamped.left;
      top = clamped.top;
      panel.style.left = left + 'px';
      panel.style.top = top + 'px';
    };
    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      const stopNextClick = (e2) => {
        e2.stopPropagation();
        e2.preventDefault();
        document.removeEventListener('click', stopNextClick, true);
      };
      document.addEventListener('click', stopNextClick, true);
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp, { once: true });
  });
}
