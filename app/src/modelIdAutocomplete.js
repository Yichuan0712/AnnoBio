/**
 * Model ID field with suggestions: as the user types, a list under the field shows the closest model
 * ids from a catalog (and first, any the user's own endpoint reported), to pick with the mouse or the
 * arrow keys and Enter. The field stays free text, so any id can still be typed and saved.
 */
import { placeDropdown } from './pillSelect.js';

const MAX_SUGGESTIONS = 8;

/**
 * Text as matching sees it: lower case, with "." and "_" read as "-", so "sonnet 4.5" finds
 * "claude-sonnet-4-5" and the other way round. Keeps the length, so positions map back to the original.
 */
function normalize(text) {
  return String(text || '').toLowerCase().replace(/[._]/g, '-');
}

/** How closely `id` matches `query` (both normalized, spaces in the query read as "-"); lower is closer. */
function idMatchRank(id, query) {
  if (id === query) return 0;
  const name = id.slice(id.search(/[^/:]*$/)); // the id without a provider prefix such as "openai/" or "ft:"
  if (name === query) return 1;
  if (id.startsWith(query) || name.startsWith(query)) return 2;
  if (id.includes(query)) return 3;
  return 4; // only the separate words match, or only the name / provider does
}

/**
 * The models matching `query`, closest first: every word of the query must appear in the model's id,
 * name or provider; then an exact id, the id (or its part after a provider prefix) starting with the
 * query, the query anywhere in the id, and the rest; then where the first word appears in the id, and
 * shorter ids. Separators don't matter (see {@link normalize}). `models` are { id, name?, label?, provider? }.
 */
export function rankModelMatches(models, query, limit = MAX_SUGGESTIONS) {
  const q = normalize(query).trim();
  if (!q) return [];
  const words = q.split(/\s+/);
  const asId = words.join('-');
  const scored = [];
  models.forEach((model, order) => {
    const id = normalize(model.id);
    const text = `${id} ${normalize(model.name || model.label)} ${normalize(model.provider)}`;
    if (!id || !words.every((word) => text.includes(word))) return;
    const at = id.indexOf(words[0]);
    scored.push({ model, rank: idMatchRank(id, asId), at: at < 0 ? Infinity : at, order });
  });
  scored.sort((a, b) => a.rank - b.rank || a.at - b.at || a.model.id.length - b.model.id.length || a.order - b.order);
  return scored.slice(0, limit).map((s) => s.model);
}

/** The id as text nodes, with the first occurrence of `word` (normalized) wrapped in <mark>. */
function highlighted(id, word) {
  const at = word ? normalize(id).indexOf(word) : -1;
  if (at < 0) return [document.createTextNode(id)];
  const mark = document.createElement('mark');
  mark.textContent = id.slice(at, at + word.length);
  return [document.createTextNode(id.slice(0, at)), mark, document.createTextNode(id.slice(at + word.length))];
}

/**
 * Attaches the suggestion list to `input`, whose parent must be positioned (the list is placed under
 * the input inside it). `loadCatalog()` resolves to the models to search, loaded on first focus;
 * `getEndpointModels()` returns models the user's endpoint reported (listed first, and shown even
 * before anything is typed); `describe(model)` is the line of detail shown under each id.
 */
export function attachModelIdAutocomplete(input, { loadCatalog, getEndpointModels = () => [], describe }) {
  const list = document.createElement('div');
  list.className = 'model-id-autocomplete__list';
  list.id = `${input.id}-suggestions`;
  list.setAttribute('role', 'listbox');
  list.hidden = true;
  input.parentElement.appendChild(list);
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-controls', list.id);

  let catalog = [];
  let catalogRequested = false;
  let suggestions = [];
  let active = -1;

  function loadCatalogOnce() {
    if (catalogRequested) return;
    catalogRequested = true;
    loadCatalog()
      .then((models) => {
        catalog = models;
        if (document.activeElement === input) update();
      })
      .catch(() => { catalogRequested = false; }); // try again on the next focus
  }

  function setActive(index) {
    active = suggestions.length ? Math.max(-1, Math.min(suggestions.length - 1, index)) : -1;
    [...list.children].forEach((option, i) => option.classList.toggle('is-active', i === active));
    const option = list.children[active];
    if (option) {
      input.setAttribute('aria-activedescendant', option.id);
      // Scroll only the list: scrollIntoView would also scroll the dialog around it.
      if (option.offsetTop < list.scrollTop) list.scrollTop = option.offsetTop;
      else if (option.offsetTop + option.offsetHeight > list.scrollTop + list.clientHeight) {
        list.scrollTop = option.offsetTop + option.offsetHeight - list.clientHeight;
      }
    } else {
      input.removeAttribute('aria-activedescendant');
    }
  }

  function close() {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    setActive(-1);
  }

  function update() {
    const query = input.value.trim();
    const endpointModels = getEndpointModels();
    const ranked = query ? [...rankModelMatches(endpointModels, query), ...rankModelMatches(catalog, query)] : endpointModels;
    const seen = new Set();
    suggestions = ranked.filter((model) => {
      if (seen.has(model.id)) return false;
      seen.add(model.id);
      return true;
    }).slice(0, MAX_SUGGESTIONS);
    if (suggestions.length === 0) {
      close();
      return;
    }
    const firstWord = normalize(query).split(/\s+/)[0];
    list.replaceChildren(...suggestions.map((model, i) => {
      const option = document.createElement('div');
      option.className = 'model-id-autocomplete__option';
      option.id = `${list.id}-${i}`;
      option.setAttribute('role', 'option');
      option.dataset.index = String(i);
      const idEl = document.createElement('span');
      idEl.className = 'model-id-autocomplete__id';
      idEl.append(...highlighted(model.id, firstWord));
      const detailEl = document.createElement('span');
      detailEl.className = 'model-id-autocomplete__detail';
      detailEl.textContent = describe(model);
      option.append(idEl, detailEl);
      return option;
    }));
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    placeDropdown(list, input, 'model-id-autocomplete__list--up');
    setActive(-1);
  }

  function choose(index) {
    const model = suggestions[index];
    if (!model) return;
    input.value = model.id;
    close();
  }

  input.addEventListener('focus', () => {
    loadCatalogOnce();
    update();
  });
  input.addEventListener('input', update);
  input.addEventListener('blur', close);
  input.addEventListener('keydown', (event) => {
    const { key } = event;
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      if (list.hidden) update();
      if (list.hidden) return;
      event.preventDefault();
      setActive(key === 'ArrowDown' ? active + 1 : (active < 0 ? suggestions.length - 1 : active - 1));
    } else if (key === 'Enter' && !list.hidden && active >= 0) {
      event.preventDefault();
      choose(active);
    } else if (key === 'Escape' && !list.hidden) {
      // Closes only the list, not the dialog it sits in.
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  });
  // Keep focus in the field while an option is pressed, so its blur doesn't close the list first.
  list.addEventListener('pointerdown', (event) => event.preventDefault());
  list.addEventListener('click', (event) => {
    const option = event.target.closest('.model-id-autocomplete__option');
    if (option) choose(Number(option.dataset.index));
  });
}
