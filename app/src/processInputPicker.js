/**
 * The Process window's Input datasets field: the Run window's Dataset picker (nodePicker.js) with a
 * check per canvas Dataset, so a Process can read several. The first one chosen is `df`; any other
 * input can be made `df` instead. Each Dataset shows the Python name it has in the code, which a
 * click copies. A Dataset the code names stays chosen until the code stops naming it.
 */
import { selectPlaceholderLabel } from './displayTextNormalize.js';

/** Datasets beyond which the list gets a search box. */
const SEARCH_THRESHOLD = 8;

function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = String(value ?? '');
  return div.innerHTML;
}

/** @param {{ id: string, placeholder: string, ariaLabel: string }} options */
export function processInputPickerHtml({ id, placeholder, ariaLabel }) {
  return `<div class="run-detail-ws-picker process-input-picker" id="${escapeHtml(id)}">
    <div class="run-detail-ws-trigger process-input-picker__trigger" tabindex="0" role="combobox" aria-expanded="false" aria-haspopup="listbox" aria-controls="${escapeHtml(id)}-list" aria-label="${escapeHtml(ariaLabel)}">
      <span class="process-input-picker__chips"><span class="run-detail-ws-trigger-text">${escapeHtml(selectPlaceholderLabel(placeholder))}</span></span>
      <span class="run-detail-ws-trigger-arrow" aria-hidden="true">⌵</span>
    </div>
    <div class="run-detail-ws-dropdown process-input-picker__dropdown" hidden>
      <input type="search" class="process-input-picker__search" placeholder="Find a dataset or variable…" aria-label="Find a dataset or variable" hidden>
      <div class="process-input-picker__list" id="${escapeHtml(id)}-list" role="listbox" aria-multiselectable="true" aria-label="${escapeHtml(ariaLabel)}"></div>
      <p class="process-input-picker__empty" hidden>No matching datasets.</p>
    </div>
  </div>`;
}

/**
 * @param {HTMLElement} pickerEl the element made from processInputPickerHtml
 * @param {{ placeholder: string,
 *   getInputs: () => { bindings: Array<{nodeId: string, name: string, color?: string, alias: string, primary: boolean, input: boolean, referenced: boolean}>, primaryDatasetId: string },
 *   onChange: (inputs: { primaryDatasetId: string, inputIds: string[] }) => void,
 *   isLocked?: () => boolean, closeWithin?: HTMLElement }} options
 *   closeWithin: clicks elsewhere in it close the list (the window's overlay)
 * @returns {{ render: () => void, setLocked: (locked: boolean) => void, focus: () => void }}
 */
export function bindProcessInputPicker(pickerEl, { placeholder, getInputs, onChange, isLocked = () => false, closeWithin }) {
  const trigger = pickerEl.querySelector('.process-input-picker__trigger');
  const chips = pickerEl.querySelector('.process-input-picker__chips');
  const dropdown = pickerEl.querySelector('.process-input-picker__dropdown');
  const search = pickerEl.querySelector('.process-input-picker__search');
  const list = pickerEl.querySelector('.process-input-picker__list');
  const empty = pickerEl.querySelector('.process-input-picker__empty');
  let active = -1;
  let order = new Map(); // node ID -> its place in the open list

  function swatch(className, color) {
    const el = document.createElement('span');
    el.className = className;
    el.style.background = color || 'transparent';
    el.setAttribute('aria-hidden', 'true');
    return el;
  }

  function renderChips(bindings) {
    const inputs = bindings.filter((binding) => binding.input)
      .sort((a, b) => Number(b.primary) - Number(a.primary));
    if (!inputs.length) {
      const text = document.createElement('span');
      text.className = 'run-detail-ws-trigger-text';
      text.textContent = selectPlaceholderLabel(placeholder);
      chips.replaceChildren(text);
      return;
    }
    chips.replaceChildren(...inputs.map((binding) => {
      const chip = document.createElement('span');
      chip.className = 'process-input-chip';
      const name = document.createElement('span');
      name.className = 'process-input-chip__name';
      name.textContent = binding.name;
      const alias = document.createElement('code');
      alias.className = 'process-input-chip__alias';
      alias.textContent = binding.alias;
      chip.append(swatch('run-detail-ws-trigger-color', binding.color), name, alias);
      chip.title = `${binding.name} is ${binding.alias} in the code`;
      return chip;
    }));
  }

  function renderList(bindings) {
    const query = search.hidden ? '' : search.value.trim().toLowerCase();
    const rank = (binding) => (order.has(binding.nodeId) ? order.get(binding.nodeId) : order.size);
    const shown = bindings.filter((binding) => `${binding.name} ${binding.alias}`.toLowerCase().includes(query))
      .sort((a, b) => rank(a) - rank(b));
    list.replaceChildren(...shown.map((binding, index) => {
      const option = document.createElement('div');
      option.className = 'run-detail-ws-option process-input-option';
      option.id = `${list.id}-${index}`;
      option.dataset.nodeId = binding.nodeId;
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', String(binding.input));
      option.classList.toggle('is-fixed', binding.referenced);
      if (binding.referenced) option.title = `The code uses ${binding.alias}. Remove it from the code to stop reading this dataset.`;
      const check = document.createElement('span');
      check.className = 'process-input-option__check';
      check.setAttribute('aria-hidden', 'true');
      const text = document.createElement('span');
      text.className = 'run-detail-ws-option-text';
      text.textContent = binding.name;
      option.append(check, swatch('run-detail-ws-option-color', binding.color), text);
      if (binding.input && !binding.primary) {
        const makePrimary = document.createElement('button');
        makePrimary.type = 'button';
        makePrimary.className = 'process-input-option__make-df';
        makePrimary.dataset.action = 'primary';
        makePrimary.textContent = 'Use as df';
        makePrimary.setAttribute('aria-label', `Use ${binding.name} as df`);
        option.append(makePrimary);
      }
      const alias = document.createElement('button');
      alias.type = 'button';
      alias.className = 'process-input-option__alias';
      alias.dataset.action = 'copy';
      alias.dataset.alias = binding.alias;
      alias.textContent = binding.alias;
      alias.title = `Copy ${binding.alias}`;
      alias.setAttribute('aria-label', `Copy variable ${binding.alias}`);
      option.append(alias);
      return option;
    }));
    empty.hidden = shown.length > 0;
    empty.textContent = bindings.length ? 'No matching datasets.' : 'No datasets are available on this canvas.';
    setActive(Math.min(active, shown.length - 1));
  }

  function render() {
    const { bindings } = getInputs();
    renderChips(bindings);
    if (!dropdown.hidden) renderList(bindings);
  }

  function setActive(index) {
    const options = [...list.children];
    active = Math.max(-1, Math.min(options.length - 1, index));
    options.forEach((option, i) => option.classList.toggle('is-active', i === active));
    const option = options[active];
    const owner = search.hidden ? trigger : search;
    if (!option) {
      owner.removeAttribute('aria-activedescendant');
      return;
    }
    owner.setAttribute('aria-activedescendant', option.id);
    // Scroll only the list: scrollIntoView would also scroll the window around it.
    if (option.offsetTop < list.scrollTop) list.scrollTop = option.offsetTop;
    else if (option.offsetTop + option.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = option.offsetTop + option.offsetHeight - list.clientHeight;
    }
  }

  function open() {
    if (isLocked() || !dropdown.hidden) return;
    const { bindings } = getInputs();
    // The inputs come first, df at the top. The order holds while the list is open, so a row does
    // not move away from the pointer when it is checked.
    const group = (binding) => (binding.primary ? 0 : binding.input ? 1 : 2);
    order = new Map(bindings.map((binding, index) => [binding, index])
      .sort(([a, i], [b, j]) => group(a) - group(b) || i - j)
      .map(([binding], index) => [binding.nodeId, index]));
    search.hidden = bindings.length <= SEARCH_THRESHOLD;
    search.value = '';
    active = -1;
    dropdown.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    renderList(bindings);
    if (!search.hidden) search.focus();
  }

  function close() {
    if (dropdown.hidden) return;
    dropdown.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    trigger.removeAttribute('aria-activedescendant');
  }

  function toggle(nodeId) {
    const { bindings, primaryDatasetId } = getInputs();
    const binding = bindings.find((item) => item.nodeId === nodeId);
    if (!binding || binding.referenced) return;
    const inputIds = bindings.filter((item) => item.input && item.nodeId !== nodeId).map((item) => item.nodeId);
    if (binding.input) {
      // The next input becomes df, preferring one the code does not already name as df_<name>.
      const next = bindings.find((item) => inputIds.includes(item.nodeId) && !item.referenced)?.nodeId || inputIds[0] || '';
      onChange({ primaryDatasetId: binding.primary ? next : primaryDatasetId, inputIds });
    } else {
      onChange({ primaryDatasetId: primaryDatasetId || nodeId, inputIds: [...inputIds, nodeId] });
    }
    render();
  }

  function makePrimary(nodeId) {
    const { bindings } = getInputs();
    onChange({ primaryDatasetId: nodeId, inputIds: bindings.filter((item) => item.input).map((item) => item.nodeId) });
    render();
    // Its button is gone with the old list; keep focus in the picker.
    (search.hidden ? trigger : search).focus();
  }

  async function copy(button) {
    const alias = button.dataset.alias;
    const copied = await copyText(alias, pickerEl);
    button.textContent = copied ? 'Copied' : 'Copy failed';
    setTimeout(() => { if (button.isConnected) button.textContent = alias; }, 1200);
  }

  trigger.addEventListener('click', () => (dropdown.hidden ? open() : close()));
  list.addEventListener('click', (event) => {
    const option = event.target.closest('.process-input-option');
    if (!option) return;
    const action = event.target.closest('button')?.dataset.action;
    if (action === 'copy') void copy(event.target.closest('button'));
    else if (action === 'primary') makePrimary(option.dataset.nodeId);
    else toggle(option.dataset.nodeId);
  });
  search.addEventListener('input', () => {
    active = -1;
    renderList(getInputs().bindings);
  });
  pickerEl.addEventListener('keydown', (event) => {
    const { key } = event;
    const typing = event.target === search;
    if (dropdown.hidden) {
      if (event.target === trigger && ['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(key)) {
        event.preventDefault();
        open();
      }
      return;
    }
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      event.preventDefault();
      setActive(active + (key === 'ArrowDown' ? 1 : -1));
    } else if (key === 'Enter' || (key === ' ' && !typing)) {
      if (event.target.closest('.process-input-option')) return; // a button inside an option
      event.preventDefault();
      const option = list.children[active];
      if (option) toggle(option.dataset.nodeId);
    } else if (key === 'Escape') {
      // Closes only the list, not the window it sits in.
      event.preventDefault();
      event.stopPropagation();
      close();
      trigger.focus();
    }
  });
  // Clicking an option keeps focus where it is (the search box or the trigger), so the list stays open.
  list.addEventListener('mousedown', (event) => {
    if (!event.target.closest('button')) event.preventDefault();
  });
  pickerEl.addEventListener('focusout', () => {
    setTimeout(() => { if (!pickerEl.contains(document.activeElement)) close(); });
  });
  closeWithin?.addEventListener('click', (event) => { if (!pickerEl.contains(event.target)) close(); });
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

async function copyText(value, container) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch (_) { /* Fall back for desktop or browsers without clipboard permission. */ }
  const focused = document.activeElement;
  const input = document.createElement('textarea');
  input.value = value;
  input.readOnly = true;
  input.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
  container.appendChild(input);
  try {
    input.select();
    return document.execCommand('copy');
  } catch (_) {
    return false;
  } finally {
    input.remove();
    focused?.focus();
  }
}
