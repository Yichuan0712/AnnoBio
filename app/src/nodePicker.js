/**
 * The canvas-node picker of the node windows: a trigger showing the chosen node (with its colour,
 * when it has one) and a list of canvas nodes to choose from. It uses the markup and classes of the
 * Run window's input Dataset picker, so the Run window's Prompt picker and the Process window's
 * Dataset picker look and behave the same.
 */
import { selectPlaceholderLabel } from './displayTextNormalize.js';

function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = String(value ?? '');
  return div.innerHTML;
}

/** @param {{ id: string, placeholder: string, ariaLabel: string }} options */
export function nodePickerHtml({ id, placeholder, ariaLabel }) {
  return `<div class="run-detail-ws-picker" id="${escapeHtml(id)}" role="combobox" aria-expanded="false" aria-haspopup="listbox" aria-label="${escapeHtml(ariaLabel)}">
    <div class="run-detail-ws-trigger" tabindex="0">
      <span class="run-detail-ws-trigger-color"></span>
      <span class="run-detail-ws-trigger-text">${escapeHtml(selectPlaceholderLabel(placeholder))}</span>
      <span class="run-detail-ws-trigger-arrow" aria-hidden="true">⌵</span>
    </div>
    <div class="run-detail-ws-dropdown" role="listbox" hidden></div>
  </div>`;
}

/**
 * @param {HTMLElement} pickerEl the element made from nodePickerHtml
 * @param {{ placeholder: string, getOptions: () => Array<{nodeId: string, name: string, color?: string}>,
 *   getValue: () => string, onSelect: (nodeId: string) => void, isLocked?: () => boolean, closeWithin?: HTMLElement }} options
 *   closeWithin: clicks elsewhere in it close the list (the window's overlay)
 * @returns {{ render: () => void, setLocked: (locked: boolean) => void, focus: () => void }}
 */
export function bindNodePicker(pickerEl, { placeholder, getOptions, getValue, onSelect, isLocked = () => false, closeWithin }) {
  const trigger = pickerEl.querySelector('.run-detail-ws-trigger');
  const colorEl = pickerEl.querySelector('.run-detail-ws-trigger-color');
  const textEl = pickerEl.querySelector('.run-detail-ws-trigger-text');
  const dropdown = pickerEl.querySelector('.run-detail-ws-dropdown');

  function render() {
    const option = getOptions().find((item) => item.nodeId === getValue());
    colorEl.style.background = option?.color || '';
    colorEl.style.display = option?.color ? '' : 'none';
    textEl.textContent = option ? option.name : selectPlaceholderLabel(placeholder);
  }
  function close() {
    dropdown.hidden = true;
    pickerEl.setAttribute('aria-expanded', 'false');
  }
  function populate() {
    dropdown.innerHTML = '';
    const value = getValue();
    const add = (option) => {
      const nodeId = option?.nodeId || '';
      const item = document.createElement('div');
      item.className = 'run-detail-ws-option';
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', nodeId === value ? 'true' : 'false');
      item.dataset.nodeId = nodeId;
      item.innerHTML = option
        ? `<span class="run-detail-ws-option-color" style="background:${escapeHtml(option.color || 'transparent')}"></span><span class="run-detail-ws-option-text">${escapeHtml(option.name)}</span>`
        : `<span class="run-detail-ws-option-color run-detail-ws-option-color--empty"></span><span class="run-detail-ws-option-text">${escapeHtml(selectPlaceholderLabel(placeholder))}</span>`;
      item.addEventListener('click', () => {
        close();
        if (nodeId !== getValue()) onSelect(nodeId);
        render();
      });
      dropdown.appendChild(item);
    };
    add(null);
    getOptions().forEach(add);
  }
  function toggle() {
    if (isLocked()) return;
    if (dropdown.hidden) {
      populate();
      dropdown.hidden = false;
      pickerEl.setAttribute('aria-expanded', 'true');
    } else {
      close();
    }
  }

  trigger.addEventListener('click', (e) => {
    e.preventDefault();
    toggle();
  });
  trigger.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggle();
    }
  });
  closeWithin?.addEventListener('click', (e) => { if (!pickerEl.contains(e.target)) close(); });
  render();

  return {
    render,
    setLocked(locked) {
      pickerEl.classList.toggle('run-detail-ws-picker--locked', locked);
      if (locked) {
        pickerEl.setAttribute('aria-disabled', 'true');
        close();
      } else {
        pickerEl.removeAttribute('aria-disabled');
      }
    },
    focus() {
      trigger.focus();
    },
  };
}
