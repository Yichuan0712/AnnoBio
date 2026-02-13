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

function isMaximized(overlay) {
  return overlay.classList.contains('modal-overlay--maximized');
}

function setMaximized(overlay, maximized) {
  const btn = overlay.querySelector('.modal-maximize');
  if (maximized) {
    overlay.classList.add('modal-overlay--maximized');
    if (btn) {
      btn.setAttribute('aria-label', 'Restore size');
      btn.innerHTML = '';
      btn.appendChild(iconRestore());
    }
  } else {
    overlay.classList.remove('modal-overlay--maximized');
    if (btn) {
      btn.setAttribute('aria-label', 'Maximize');
      btn.innerHTML = '';
      btn.appendChild(iconMaximize());
    }
  }
}

function addMaximizeButton(overlay) {
  const header = overlay.querySelector('.modal-header');
  const closeBtn = overlay.querySelector('.modal-close');
  if (!header || !closeBtn || overlay.querySelector('.modal-maximize')) return;

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

  const actions = document.createElement('div');
  actions.className = 'modal-header-actions';
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
