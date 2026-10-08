/**
 * The Process window's Input field: the Run window's picker (nodePicker.js) with a check per
 * source, so a Process can read several. Sources are Datasets and other steps' outputs, listed in
 * two groups (docs/design/DATA_FLOW_DESIGN.md §5.3) and told apart by their key (stepInputs.js
 * sourceKey). The first one chosen is `df`; any other input can be made `df` instead. Each source
 * shows the Python name it has in the code, its process() parameter, which a click copies. A source
 * the code uses beyond that parameter stays chosen until the code stops using it. An input can read
 * another source under the same name ("Change source…"), so the code needs no change.
 */
import { selectPlaceholderLabel } from './displayTextNormalize.js';
import { candidateGroups } from './stepInputs.js';

/** Sources beyond which the list gets a search box. */
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
      <input type="search" class="process-input-picker__search" placeholder="Find an input or variable…" aria-label="Find an input or variable" hidden>
      <div class="process-input-picker__replacing" hidden></div>
      <div class="process-input-picker__list" id="${escapeHtml(id)}-list" role="listbox" aria-multiselectable="true" aria-label="${escapeHtml(ariaLabel)}"></div>
      <p class="process-input-picker__empty" hidden>No matching inputs.</p>
    </div>
  </div>`;
}

/**
 * @param {HTMLElement} pickerEl the element made from processInputPickerHtml
 * @param {{ placeholder: string,
 *   getInputs: () => { bindings: Array<{key: string, nodeId: string, kind: string, name: string, label: string, color?: string, alias: string, primary: boolean, input: boolean, used: boolean, parameter: number}>, primaryDatasetId: string },
 *   onChange: (inputs: { primaryDatasetId: string, inputIds: string[] }) => void,
 *   onReplace?: (change: { fromKey: string, toKey: string }) => void,
 *   isLocked?: () => boolean, closeWithin?: HTMLElement }} options
 *   primaryDatasetId and inputIds are source keys
 *   closeWithin: clicks elsewhere in it close the list (the window's overlay)
 * @returns {{ render: () => void, setLocked: (locked: boolean) => void, focus: () => void }}
 */
export function bindProcessInputPicker(pickerEl, { placeholder, getInputs, onChange, onReplace, isLocked = () => false, closeWithin }) {
  const trigger = pickerEl.querySelector('.process-input-picker__trigger');
  const chips = pickerEl.querySelector('.process-input-picker__chips');
  const dropdown = pickerEl.querySelector('.process-input-picker__dropdown');
  const search = pickerEl.querySelector('.process-input-picker__search');
  const replacingEl = pickerEl.querySelector('.process-input-picker__replacing');
  const list = pickerEl.querySelector('.process-input-picker__list');
  const empty = pickerEl.querySelector('.process-input-picker__empty');
  let active = -1;
  let order = new Map(); // source key -> its place in the open list
  let replacing = ''; // the key of the input whose source is being changed
  const labelOf = (binding) => binding.label || binding.name;

  function swatch(className, color) {
    const el = document.createElement('span');
    el.className = className;
    el.style.background = color || 'transparent';
    el.setAttribute('aria-hidden', 'true');
    return el;
  }

  function button(className, action, text, ariaLabel) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = className;
    el.dataset.action = action;
    el.textContent = text;
    if (ariaLabel) el.setAttribute('aria-label', ariaLabel);
    return el;
  }

  function renderChips(bindings) {
    // df, then the parameters after it in the code's order, then inputs the code only uses.
    const place = (binding) => (binding.primary ? -1 : binding.parameter < 0 ? Infinity : binding.parameter);
    const inputs = bindings.filter((binding) => binding.input).sort((a, b) => place(a) - place(b));
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
      name.textContent = labelOf(binding);
      const alias = document.createElement('code');
      alias.className = 'process-input-chip__alias';
      alias.textContent = binding.alias;
      chip.append(swatch('run-detail-ws-trigger-color', binding.color), name, alias);
      chip.title = `${labelOf(binding)} is ${binding.alias} in the code`;
      return chip;
    }));
  }

  function optionFor(binding, index) {
    const option = document.createElement('div');
    option.className = 'run-detail-ws-option process-input-option';
    option.id = `${list.id}-${index}`;
    option.dataset.key = binding.key;
    option.setAttribute('role', 'option');
    option.setAttribute('aria-selected', replacing ? 'false' : String(binding.input));
    option.classList.toggle('is-fixed', !replacing && binding.used);
    if (!replacing && binding.used) option.title = `The code uses ${binding.alias}. Remove that use to stop reading this input.`;
    const check = document.createElement('span');
    check.className = 'process-input-option__check';
    check.setAttribute('aria-hidden', 'true');
    const text = document.createElement('span');
    text.className = 'run-detail-ws-option-text';
    text.textContent = labelOf(binding);
    option.append(check, swatch('run-detail-ws-option-color', binding.color), text);
    if (replacing) return option;
    // An input the code uses as df_<name> keeps that name, so it is not offered as df.
    if (binding.input && !binding.primary && !binding.used) {
      option.append(button('process-input-option__make-df', 'primary', 'Use as df', `Use ${labelOf(binding)} as df`));
    }
    if (binding.input && onReplace) {
      option.append(button('process-input-option__change', 'change', 'Change source…', `Read ${binding.alias} from another input`));
    }
    const alias = button('process-input-option__alias', 'copy', binding.alias, `Copy variable ${binding.alias}`);
    alias.dataset.alias = binding.alias;
    alias.title = `Copy ${binding.alias}`;
    option.append(alias);
    return option;
  }

  function renderList(bindings) {
    const query = search.hidden ? '' : search.value.trim().toLowerCase();
    const rank = (binding) => (order.has(binding.key) ? order.get(binding.key) : order.size);
    const from = replacing ? bindings.find((binding) => binding.key === replacing) : null;
    replacingEl.hidden = !from;
    if (from) {
      replacingEl.replaceChildren(
        Object.assign(document.createElement('span'), { textContent: `Read ${from.alias} from:` }),
        button('process-input-picker__cancel', 'cancel', 'Cancel'),
      );
    }
    // While changing a source, the choices are the sources that are not inputs yet.
    const shown = bindings.filter((binding) => !from || !binding.input)
      .filter((binding) => `${labelOf(binding)} ${binding.alias}`.toLowerCase().includes(query))
      .sort((a, b) => rank(a) - rank(b));
    let index = 0;
    const children = [];
    for (const group of candidateGroups(shown)) {
      const heading = document.createElement('div');
      heading.className = 'run-detail-ws-group';
      heading.setAttribute('role', 'presentation');
      heading.textContent = group.label;
      children.push(heading);
      for (const binding of group.items) children.push(optionFor(binding, index++));
    }
    list.replaceChildren(...children);
    empty.hidden = shown.length > 0;
    empty.textContent = bindings.length ? 'No matching inputs.' : 'No inputs are available on this canvas.';
    setActive(Math.min(active, shown.length - 1));
  }

  function render() {
    const { bindings } = getInputs();
    renderChips(bindings);
    if (!dropdown.hidden) renderList(bindings);
  }

  const options = () => [...list.querySelectorAll('.process-input-option')];

  function setActive(index) {
    const all = options();
    active = Math.max(-1, Math.min(all.length - 1, index));
    all.forEach((option, i) => option.classList.toggle('is-active', i === active));
    const option = all[active];
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
      .map(([binding], index) => [binding.key, index]));
    replacing = '';
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
    replacing = '';
    dropdown.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    trigger.removeAttribute('aria-activedescendant');
  }

  function toggle(key) {
    const { bindings, primaryDatasetId } = getInputs();
    const binding = bindings.find((item) => item.key === key);
    if (!binding || binding.used) return;
    const inputIds = bindings.filter((item) => item.input && item.key !== key).map((item) => item.key);
    if (binding.input) {
      // The next input becomes df, preferring one the code does not already use as df_<name>.
      const next = bindings.find((item) => inputIds.includes(item.key) && !item.used)?.key || inputIds[0] || '';
      onChange({ primaryDatasetId: binding.primary ? next : primaryDatasetId, inputIds });
    } else {
      onChange({ primaryDatasetId: primaryDatasetId || key, inputIds: [...inputIds, key] });
    }
    render();
  }

  function makePrimary(key) {
    const { bindings } = getInputs();
    onChange({ primaryDatasetId: key, inputIds: bindings.filter((item) => item.input).map((item) => item.key) });
    render();
    // Its button is gone with the old list; keep focus in the picker.
    (search.hidden ? trigger : search).focus();
  }

  function choose(key) {
    if (!replacing) {
      toggle(key);
      return;
    }
    const fromKey = replacing;
    replacing = '';
    onReplace?.({ fromKey, toKey: key });
    render();
    (search.hidden ? trigger : search).focus();
  }

  function startReplacing(key) {
    replacing = key;
    active = -1;
    renderList(getInputs().bindings);
    (search.hidden ? trigger : search).focus();
  }

  function cancelReplacing() {
    replacing = '';
    renderList(getInputs().bindings);
    (search.hidden ? trigger : search).focus();
  }

  async function copy(copyButton) {
    const alias = copyButton.dataset.alias;
    const copied = await copyText(alias, pickerEl);
    copyButton.textContent = copied ? 'Copied' : 'Copy failed';
    setTimeout(() => { if (copyButton.isConnected) copyButton.textContent = alias; }, 1200);
  }

  trigger.addEventListener('click', () => (dropdown.hidden ? open() : close()));
  list.addEventListener('click', (event) => {
    const option = event.target.closest('.process-input-option');
    if (!option) return;
    const action = event.target.closest('button')?.dataset.action;
    if (action === 'copy') void copy(event.target.closest('button'));
    else if (action === 'primary') makePrimary(option.dataset.key);
    else if (action === 'change') startReplacing(option.dataset.key);
    else choose(option.dataset.key);
  });
  replacingEl.addEventListener('click', (event) => {
    if (event.target.closest('button')?.dataset.action === 'cancel') cancelReplacing();
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
      if (event.target.closest('.process-input-option, .process-input-picker__replacing')) return; // a button
      event.preventDefault();
      const option = options()[active];
      if (option) choose(option.dataset.key);
    } else if (key === 'Escape') {
      // Closes only the change of source, or the list, not the window it sits in.
      event.preventDefault();
      event.stopPropagation();
      if (replacing) {
        cancelReplacing();
        return;
      }
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
