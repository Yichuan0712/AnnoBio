/**
 * Draws a native <select> as a dropdown whose options can carry a status pill, which a native
 * option cannot show. Give an option data-pill (its text) and data-pill-kind (ok | error |
 * warning). The select stays in the DOM, hidden, as the value the rest of the code reads, sets
 * and listens to: picking an option here sets select.value and fires 'change' on it. After
 * setting select.value in code, call refresh().
 */
export function mountPillSelect(select) {
  const picker = document.createElement('div');
  picker.className = 'pill-select';
  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.id = `${select.id}-trigger`;
  trigger.className = 'pill-select__trigger dataset-meta-input';
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  if (select.getAttribute('aria-label')) trigger.setAttribute('aria-label', select.getAttribute('aria-label'));
  const list = document.createElement('div');
  list.className = 'pill-select__list';
  list.id = `${select.id}-listbox`;
  list.setAttribute('role', 'listbox');
  list.hidden = true;
  trigger.setAttribute('aria-controls', list.id);
  picker.append(trigger, list);
  select.hidden = true;
  select.after(picker);
  // The select may not be in the document yet (a dialog built before it is shown), so look for its
  // label from the top of its own tree.
  let root = select;
  while (root.parentElement) root = root.parentElement;
  const label = select.id ? root.querySelector(`label[for="${select.id}"]`) : null;
  if (label) label.htmlFor = trigger.id;

  let active = -1;

  function content(option) {
    const text = document.createElement('span');
    text.className = 'pill-select__text';
    text.textContent = option ? option.textContent : '';
    const parts = [text];
    if (option?.dataset.pill) {
      const pill = document.createElement('span');
      pill.className = `pill-select__pill pill-select__pill--${option.dataset.pillKind || 'neutral'}`;
      pill.textContent = option.dataset.pill;
      parts.push(pill);
    }
    return parts;
  }

  function refresh() {
    const arrow = document.createElement('span');
    arrow.className = 'pill-select__arrow';
    arrow.setAttribute('aria-hidden', 'true');
    arrow.textContent = '⌵';
    trigger.replaceChildren(...content(select.selectedOptions[0]), arrow);
    list.replaceChildren(...[...select.options].map((option, index) => {
      const item = document.createElement('div');
      item.className = 'pill-select__option';
      item.id = `${list.id}-${index}`;
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', String(option.selected));
      item.dataset.index = String(index);
      item.append(...content(option));
      return item;
    }));
    setActive(active);
  }

  function setActive(index) {
    active = Math.max(-1, Math.min(select.options.length - 1, index));
    list.querySelectorAll('.pill-select__option').forEach((item, i) => item.classList.toggle('is-active', i === active));
    const item = list.children[active];
    if (item) {
      trigger.setAttribute('aria-activedescendant', item.id);
      // Scroll only the list: scrollIntoView would also scroll the dialog around it.
      if (item.offsetTop < list.scrollTop) list.scrollTop = item.offsetTop;
      else if (item.offsetTop + item.offsetHeight > list.scrollTop + list.clientHeight) {
        list.scrollTop = item.offsetTop + item.offsetHeight - list.clientHeight;
      }
    } else {
      trigger.removeAttribute('aria-activedescendant');
    }
  }

  function onOutside(event) {
    if (!picker.contains(event.target)) close();
  }

  /** Fits the list into the nearest scrolling ancestor (it would be clipped there): below the
   * trigger, or above it when there is more room above. */
  function place() {
    let clip = { top: 0, bottom: window.innerHeight };
    for (let el = picker.parentElement; el; el = el.parentElement) {
      if (/(auto|scroll|hidden)/.test(getComputedStyle(el).overflowY)) {
        const box = el.getBoundingClientRect();
        clip = { top: Math.max(clip.top, box.top), bottom: Math.min(clip.bottom, box.bottom) };
        break;
      }
    }
    const box = trigger.getBoundingClientRect();
    const below = clip.bottom - box.bottom - 8;
    const above = box.top - clip.top - 8;
    const natural = Math.min(260, list.scrollHeight);
    const up = natural > below && above > below;
    list.classList.toggle('pill-select__list--up', up);
    list.style.maxHeight = `${Math.max(120, Math.min(260, up ? above : below))}px`;
  }

  function open() {
    if (!list.hidden) return;
    refresh();
    list.hidden = false;
    place();
    trigger.setAttribute('aria-expanded', 'true');
    setActive(select.selectedIndex);
    document.addEventListener('pointerdown', onOutside, true);
  }

  function close() {
    list.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    trigger.removeAttribute('aria-activedescendant');
    document.removeEventListener('pointerdown', onOutside, true);
  }

  function choose(index) {
    close();
    if (index < 0 || index === select.selectedIndex) return;
    select.selectedIndex = index;
    refresh();
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }

  trigger.addEventListener('click', () => (list.hidden ? open() : close()));
  list.addEventListener('click', (event) => {
    const item = event.target.closest('.pill-select__option');
    if (item) {
      choose(Number(item.dataset.index));
      trigger.focus();
    }
  });
  trigger.addEventListener('keydown', (event) => {
    const { key } = event;
    if (list.hidden) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(key)) {
        event.preventDefault();
        open();
      }
      return;
    }
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      event.preventDefault();
      setActive(active + (key === 'ArrowDown' ? 1 : -1));
    } else if (key === 'Home' || key === 'End') {
      event.preventDefault();
      setActive(key === 'Home' ? 0 : select.options.length - 1);
    } else if (key === 'Enter' || key === ' ') {
      event.preventDefault();
      choose(active);
    } else if (key === 'Escape') {
      // Closes only the list, not the dialog it sits in.
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (key === 'Tab') {
      close();
    }
  });

  refresh();
  return { refresh };
}
