function createPaneToggleIcon(collapsed) {
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

  if (collapsed) {
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

export function attachModalPaneToggle({
  overlay,
  isCollapsed,
  onToggle,
  expandedLabel = 'Hide left panel',
  collapsedLabel = 'Show left panel',
}) {
  const header = overlay.querySelector('.modal-header');
  const closeBtn = overlay.querySelector('.modal-close');
  if (!header || !closeBtn || typeof isCollapsed !== 'function' || typeof onToggle !== 'function') {
    return { update() {} };
  }

  const actions = ensureHeaderActions(header, closeBtn);
  let button = actions.querySelector('.modal-pane-toggle');
  if (!button) {
    button = document.createElement('button');
    button.type = 'button';
    button.className = 'modal-pane-toggle';
    button.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      onToggle();
    });
    actions.insertBefore(button, actions.firstChild);
  }

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
