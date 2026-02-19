/**
 * Adds a maximize/restore button to modal headers. Toggles fullscreen-style size (no panel strip).
 */

const ICON_SIZE = 12;
const ICON_DISPLAY_SIZE = 10;
const ICON_STROKE = 1.5;

function svgIcon(pathOrPaths, viewBox = `0 0 ${ICON_SIZE} ${ICON_SIZE}`) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', viewBox);
  svg.setAttribute('width', String(ICON_DISPLAY_SIZE));
  svg.setAttribute('height', String(ICON_DISPLAY_SIZE));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', String(ICON_STROKE));
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const paths = Array.isArray(pathOrPaths) ? pathOrPaths : [pathOrPaths];
  paths.forEach((d) => {
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', d);
    svg.appendChild(p);
  });
  return svg;
}

const iconMaximize = () => svgIcon('M1 1h10v10H1z');
const iconRestore = () => svgIcon(['M1 1h10v10H1z', 'M4 4h10v10H4z']);
/** Half-window icon: left half of a rectangle */
const iconHalf = () => svgIcon('M1 1h4v10H1z M6 1h4v10H6z', `0 0 ${ICON_SIZE} ${ICON_SIZE}`);

function isMaximized(overlay) {
  return overlay.classList.contains('modal-overlay--maximized');
}

/** Returns 'left' | 'right' | null */
function getHalfSide(overlay) {
  if (overlay.classList.contains('modal-overlay--half-left')) return 'left';
  if (overlay.classList.contains('modal-overlay--half-right')) return 'right';
  return null;
}

function setMaximized(overlay, maximized) {
  const btn = overlay.querySelector('.modal-maximize');
  if (maximized) {
    overlay.classList.remove('modal-overlay--half-left', 'modal-overlay--half-right');
    overlay.classList.add('modal-overlay--maximized');
    if (btn) {
      btn.setAttribute('aria-label', 'Restore size');
      btn.innerHTML = '';
      btn.appendChild(iconRestore());
    }
    updateHalfButton(overlay);
  } else {
    overlay.classList.remove('modal-overlay--maximized');
    if (btn) {
      btn.setAttribute('aria-label', 'Maximize');
      btn.innerHTML = '';
      btn.appendChild(iconMaximize());
    }
    updateHalfButton(overlay);
  }
}

/** Set half-screen side: null = exit half, 'left' = left half, 'right' = right half */
function setHalfSide(overlay, side) {
  overlay.classList.remove('modal-overlay--half-left', 'modal-overlay--half-right');
  if (side === 'left') overlay.classList.add('modal-overlay--half-left');
  if (side === 'right') overlay.classList.add('modal-overlay--half-right');
  if (side) {
    overlay.classList.remove('modal-overlay--maximized');
    const maxBtn = overlay.querySelector('.modal-maximize');
    if (maxBtn) {
      maxBtn.setAttribute('aria-label', 'Maximize');
      maxBtn.innerHTML = '';
      maxBtn.appendChild(iconMaximize());
    }
  }
  clearHalfPanelPosition(overlay);
  updateHalfButton(overlay);
}

/** Half button: normal <-> right half only (no left in cycle). From half, click -> normal. When going to half, pick side: default right, or left if right taken, or right if left taken. */
function cycleHalf(overlay) {
  const side = getHalfSide(overlay);
  if (side !== null) {
    setHalfSide(overlay, null);
    return;
  }
  const existingLeft = document.querySelector('.modal-overlay[data-modal-half="true"].modal-overlay--half-left');
  const existingRight = document.querySelector('.modal-overlay[data-modal-half="true"].modal-overlay--half-right');
  const targetSide = existingRight ? 'left' : existingLeft ? 'right' : 'right';
  setHalfSide(overlay, targetSide);
}

function updateHalfButton(overlay) {
  const btn = overlay.querySelector('.modal-half');
  if (!btn) return;
  const side = getHalfSide(overlay);
  if (side === 'right') {
    btn.setAttribute('aria-label', 'Exit half-screen');
    btn.classList.add('modal-half--active');
  } else if (side === 'left') {
    btn.setAttribute('aria-label', 'Exit half-screen');
    btn.classList.add('modal-half--active');
  } else {
    btn.setAttribute('aria-label', 'Half-screen: right');
    btn.classList.remove('modal-half--active');
  }
}

/** Clear panel inline position/positioning so half-left/half-right CSS can take over. */
function clearHalfPanelPosition(overlay) {
  const panel = overlay.querySelector('.modal-panel');
  if (panel) {
    panel.style.left = '';
    panel.style.top = '';
    panel.style.position = '';
    panel.style.transform = '';
    panel.style.margin = '';
  }
}

/** After drag in half mode: snap to left or right by panel center. If target side has another half-screen modal, swap. */
export function snapHalfToSide(overlay) {
  if (!overlay.classList.contains('modal-overlay--half-left') && !overlay.classList.contains('modal-overlay--half-right')) return;
  const panel = overlay.querySelector('.modal-panel');
  if (!panel) return;
  const rect = panel.getBoundingClientRect();
  const centerX = rect.left + rect.width / 2;
  const targetSide = centerX < window.innerWidth / 2 ? 'left' : 'right';
  const fromSide = overlay.classList.contains('modal-overlay--half-left') ? 'left' : 'right';

  const others = [...document.querySelectorAll('.modal-overlay[data-modal-half="true"]')].filter(
    (el) => el !== overlay && (el.classList.contains('modal-overlay--half-left') || el.classList.contains('modal-overlay--half-right'))
  );
  const onTargetSide = others.find((el) => getHalfSide(el) === targetSide);
  if (onTargetSide) {
    setHalfSide(onTargetSide, fromSide);
  }
  setHalfSide(overlay, targetSide);
}

function addMaximizeButton(overlay) {
  if (overlay.classList.contains('modal-overlay--alert')) return;
  const header = overlay.querySelector('.modal-header');
  const closeBtn = overlay.querySelector('.modal-close');
  if (!header || !closeBtn || overlay.querySelector('.modal-maximize')) return;

  const actions = document.createElement('div');
  actions.className = 'modal-header-actions';

  const hasHalf = overlay.dataset.modalHalf === 'true';
  if (hasHalf) {
    const halfBtn = document.createElement('button');
    halfBtn.type = 'button';
    halfBtn.className = 'modal-half';
    halfBtn.setAttribute('aria-label', 'Half-screen: right or left');
    halfBtn.appendChild(iconHalf());
    halfBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      cycleHalf(overlay);
    });
    actions.appendChild(halfBtn);
    updateHalfButton(overlay);
  }

  const maximizeBtn = document.createElement('button');
  maximizeBtn.type = 'button';
  maximizeBtn.className = 'modal-maximize';
  maximizeBtn.setAttribute('aria-label', 'Maximize');
  maximizeBtn.appendChild(iconMaximize());
  maximizeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    setMaximized(overlay, !isMaximized(overlay));
  });
  actions.appendChild(maximizeBtn);
  actions.appendChild(closeBtn);
  header.appendChild(actions);
}

export function initModalMaximize() {
  const observer = new MutationObserver((mutations) => {
    const toProcess = new Set();
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.classList?.contains('modal-overlay')) toProcess.add(node);
        node.querySelectorAll?.('.modal-overlay').forEach((o) => toProcess.add(o));
      }
    }
    toProcess.forEach((overlay) => {
      if (document.body.contains(overlay)) {
        requestAnimationFrame(() => addMaximizeButton(overlay));
      }
    });
  });

  observer.observe(document.body, { childList: true, subtree: true });

  requestAnimationFrame(() => {
    document.querySelectorAll('.modal-overlay').forEach(addMaximizeButton);
  });
}
