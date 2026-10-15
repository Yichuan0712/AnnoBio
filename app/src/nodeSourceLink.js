/**
 * The line in a node's window that names what the node reads (docs/design/NODE_PORTS_PLAN.md step 6).
 * Inputs are connected by dragging on the canvas, so a window only shows them: a source is a link
 * that closes the window and shows that node on the canvas; a missing one says how to connect it.
 */

/**
 * @param {HTMLElement} container emptied and filled
 * @param {{ label?: string, color?: string, hint: string, onReveal?: () => void }} source
 *   label: the source's name, or empty when nothing is connected; hint: what to do then
 */
export function renderSourceLink(container, { label = '', color = '', hint = '', onReveal } = {}) {
  container.replaceChildren();
  if (!label) {
    const empty = document.createElement('span');
    empty.className = 'node-source-link node-source-link--empty';
    empty.textContent = hint;
    container.append(empty);
    return;
  }
  const link = document.createElement('button');
  link.type = 'button';
  link.className = 'node-source-link';
  link.title = `Show "${label}" on the canvas`;
  const swatch = document.createElement('span');
  swatch.className = 'run-detail-ws-trigger-color';
  swatch.setAttribute('aria-hidden', 'true');
  if (color) swatch.style.background = color;
  else swatch.style.display = 'none';
  const text = document.createElement('span');
  text.className = 'node-source-link__label';
  text.textContent = label;
  link.append(swatch, text);
  link.addEventListener('click', (event) => {
    event.preventDefault();
    onReveal?.();
  });
  container.append(link);
}
