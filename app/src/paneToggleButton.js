function createPaneToggleIcon(singlePane) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '14');
  svg.setAttribute('height', '14');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.4');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');

  const outer = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  outer.setAttribute('x', '2');
  outer.setAttribute('y', '3');
  outer.setAttribute('width', '12');
  outer.setAttribute('height', '10');
  outer.setAttribute('rx', '0.6');
  svg.appendChild(outer);

  if (singlePane) {
    const line1 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    line1.setAttribute('d', 'M5.5 6.25h5');
    svg.appendChild(line1);
    const line2 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    line2.setAttribute('d', 'M5.5 9.75h5');
    svg.appendChild(line2);
  } else {
    const divider = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    divider.setAttribute('d', 'M5.5 3.75v8.5');
    svg.appendChild(divider);
    const line1 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    line1.setAttribute('d', 'M8 6.25h3.5');
    svg.appendChild(line1);
    const line2 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    line2.setAttribute('d', 'M8 9.75h3.5');
    svg.appendChild(line2);
  }

  return svg;
}

function ensureHeaderActions(header, closeBtn) {
  let actions = header.querySelector('.modal-header-actions');
  if (!actions) {
    actions = document.createElement('div');
    actions.className = 'modal-header-actions';
    header.appendChild(actions);
  }
  if (closeBtn && closeBtn.parentElement !== actions) {
    actions.appendChild(closeBtn);
  }
  return actions;
}

function ensurePaneToggleButton(overlay, onClick) {
  const header = overlay.querySelector('.modal-header');
  const closeBtn = overlay.querySelector('.modal-close');
  if (!header || !closeBtn) return null;
  const actions = ensureHeaderActions(header, closeBtn);
  let button = actions.querySelector('.modal-pane-toggle');
  if (!button) {
    button = document.createElement('button');
    button.type = 'button';
    button.className = 'modal-pane-toggle';
    button.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      onClick();
    });
    actions.insertBefore(button, actions.firstChild);
  }
  return button;
}

/** Legacy 2-state pane toggle (collapsed/expanded). Used where there's no meaningful "hide the other side too" state. */
export function attachModalPaneToggle({
  overlay,
  isCollapsed,
  onToggle,
  expandedLabel = 'Hide left panel',
  collapsedLabel = 'Show left panel',
}) {
  if (typeof isCollapsed !== 'function' || typeof onToggle !== 'function') {
    return { update() {} };
  }
  const button = ensurePaneToggleButton(overlay, onToggle);
  if (!button) return { update() {} };

  function update() {
    const collapsed = !!isCollapsed();
    button.innerHTML = '';
    button.appendChild(createPaneToggleIcon(collapsed));
    const label = collapsed ? collapsedLabel : expandedLabel;
    button.setAttribute('aria-label', label);
    button.setAttribute('aria-pressed', collapsed ? 'true' : 'false');
    button.title = label;
  }

  update();
  return { update };
}

/**
 * 3-state pane cycle for a genuine left/right split: both panes shown → left only → right only → both …
 * State is tracked via two overlay classes: `modal-overlay--right-pane-collapsed` (left pane only visible)
 * and `modal-overlay--left-pane-collapsed` (right pane only visible). Neither class = both panes shown.
 */
export function attachModalPaneCycle({
  overlay,
  bothLabel = 'Show both panels',
  leftOnlyLabel = 'Show left panel only',
  rightOnlyLabel = 'Show right panel only',
}) {
  function getState() {
    if (overlay.classList.contains('modal-overlay--right-pane-collapsed')) return 'left';
    if (overlay.classList.contains('modal-overlay--left-pane-collapsed')) return 'right';
    return 'both';
  }
  function setState(state) {
    overlay.classList.toggle('modal-overlay--right-pane-collapsed', state === 'left');
    overlay.classList.toggle('modal-overlay--left-pane-collapsed', state === 'right');
  }

  const button = ensurePaneToggleButton(overlay, () => {
    const current = getState();
    const next = current === 'both' ? 'left' : (current === 'left' ? 'right' : 'both');
    setState(next);
    update();
  });
  if (!button) return { update() {} };

  function update() {
    const state = getState();
    button.innerHTML = '';
    button.appendChild(createPaneToggleIcon(state !== 'both'));
    const label = state === 'both' ? bothLabel : (state === 'left' ? leftOnlyLabel : rightOnlyLabel);
    button.setAttribute('aria-label', label);
    button.title = label;
  }

  update();
  return { update, getState, setState };
}
