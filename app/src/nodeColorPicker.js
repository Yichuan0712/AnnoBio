import { mountModalDialog } from './modalDialog.js';
import { normalizeNodeColor } from './workflowNodeColors.js';

const clamp = (value) => Math.max(0, Math.min(1, value));

function toHsv(hex) {
  const [r, g, b] = hex.slice(1).match(/../g).map((channel) => parseInt(channel, 16) / 255);
  const high = Math.max(r, g, b);
  const low = Math.min(r, g, b);
  const delta = high - low;
  const hue = !delta ? 0 : high === r ? ((g - b) / delta + 6) % 6
    : high === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  return { h: hue * 60, s: high ? delta / high : 0, v: high };
}

function toHex({ h, s, v }) {
  const channel = (offset) => {
    const k = (offset + h / 60) % 6;
    return Math.round((v - v * s * Math.max(0, Math.min(k, 4 - k, 1))) * 255)
      .toString(16).padStart(2, '0');
  };
  return '#' + channel(5) + channel(3) + channel(1);
}

/** Full saturation/brightness palette and hue control, embedded in the app dialog. */
export function openNodeColorPicker({ color, onApply, onReset }) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay modal-overlay--node-color';
  overlay.setAttribute('aria-labelledby', 'node-color-title');
  overlay.innerHTML = `
    <div class="modal-panel modal-panel--node-color">
      <div class="modal-header">
        <h2 id="node-color-title" class="modal-title">Change color</h2>
        <button type="button" class="modal-close" aria-label="Close">&times;</button>
      </div>
      <form class="node-color-form">
        <div class="node-color-fields">
          <div class="node-color-palette" tabindex="0" role="slider" aria-label="Saturation and brightness"
            aria-description="Use Left and Right to change saturation, Up and Down to change brightness."
            aria-valuemin="0" aria-valuemax="100">
            <span class="node-color-cursor" aria-hidden="true"></span>
          </div>
          <input type="range" class="node-color-hue" min="0" max="360" step="1" aria-label="Hue" />
          <div class="node-color-value">
            <span class="node-color-swatch" aria-hidden="true"></span>
            <label class="node-color-field">Hex
              <input type="text" class="dataset-meta-input node-color-hex" spellcheck="false" autocomplete="off" aria-label="Hex color" />
            </label>
          </div>
        </div>
        <div class="modal-alert-footer">
          <button type="button" class="btn btn-secondary node-color-reset" title="Restore automatic color">Reset</button>
          <button type="submit" class="btn btn-primary node-color-apply">Apply</button>
        </div>
      </form>
    </div>`;
  const palette = overlay.querySelector('.node-color-palette');
  const cursor = overlay.querySelector('.node-color-cursor');
  const hue = overlay.querySelector('.node-color-hue');
  const swatch = overlay.querySelector('.node-color-swatch');
  const hex = overlay.querySelector('.node-color-hex');
  let hsv = toHsv(normalizeNodeColor(color) || '#2563eb');
  const close = mountModalDialog(overlay);
  function render(updateText = true) {
    const selected = toHex(hsv);
    palette.style.setProperty('--picker-hue', `hsl(${hsv.h} 100% 50%)`);
    cursor.style.left = `${hsv.s * 100}%`;
    cursor.style.top = `${(1 - hsv.v) * 100}%`;
    palette.setAttribute('aria-valuenow', String(Math.round(hsv.s * 100)));
    palette.setAttribute('aria-valuetext', `Saturation ${Math.round(hsv.s * 100)}%, brightness ${Math.round(hsv.v * 100)}%`);
    hue.value = String(hsv.h);
    swatch.style.background = selected;
    if (updateText) {
      hex.value = selected;
      hex.setCustomValidity('');
    }
  }
  function selectPoint(event) {
    const rect = palette.getBoundingClientRect();
    hsv.s = clamp((event.clientX - rect.left) / rect.width);
    hsv.v = 1 - clamp((event.clientY - rect.top) / rect.height);
    render();
  }
  palette.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    palette.focus();
    palette.setPointerCapture(event.pointerId);
    selectPoint(event);
  });
  palette.addEventListener('pointermove', (event) => {
    if (palette.hasPointerCapture(event.pointerId)) selectPoint(event);
  });
  palette.addEventListener('keydown', (event) => {
    const step = event.shiftKey ? 0.1 : 0.01;
    if (event.key === 'ArrowLeft') hsv.s = clamp(hsv.s - step);
    else if (event.key === 'ArrowRight') hsv.s = clamp(hsv.s + step);
    else if (event.key === 'ArrowDown') hsv.v = clamp(hsv.v - step);
    else if (event.key === 'ArrowUp') hsv.v = clamp(hsv.v + step);
    else return;
    event.preventDefault();
    render();
  });
  hue.addEventListener('input', () => { hsv.h = Number(hue.value); render(); });
  hex.addEventListener('input', () => {
    const selected = normalizeNodeColor(hex.value);
    hex.setCustomValidity(selected ? '' : 'Enter a hex color such as #2563eb.');
    if (selected) { hsv = toHsv(selected); render(false); }
  });
  overlay.querySelector('form').addEventListener('submit', (event) => {
    event.preventDefault();
    const selected = normalizeNodeColor(hex.value);
    if (!selected) return;
    onApply(selected);
    close();
  });
  overlay.querySelector('.modal-close').addEventListener('click', close);
  overlay.querySelector('.node-color-reset').addEventListener('click', () => {
    const resetColor = normalizeNodeColor(onReset?.());
    if (resetColor) {
      hsv = toHsv(resetColor);
      render();
    }
  });
  overlay.addEventListener('click', (event) => { if (event.target === overlay) close(); });
  render();
  palette.focus();
  return close;
}
