/**
 * Sampler detail modal: view/edit sampler settings (name, sampling type, sample size, row spec).
 * @param {{ node: HTMLElement, isSamplerNameAlreadyUsedForSource?: (name: string, sourceNodeId: string, excludeNodeId?: string | null) => boolean }} options
 */

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/** Parse rowSpec string "1 3 5-10 15" into items for chip list */
function parseRowSpecToItems(spec) {
  const items = [];
  const s = (spec || '').trim();
  if (!s) return items;
  const tokens = s.split(/\s+/);
  for (const t of tokens) {
    const dash = t.indexOf('-');
    if (dash >= 0) {
      const from = parseInt(t.slice(0, dash), 10);
      const to = parseInt(t.slice(dash + 1), 10);
      if (Number.isFinite(from) && Number.isFinite(to) && from >= 1 && to >= 1) {
        items.push({ type: 'range', from: Math.min(from, to), to: Math.max(from, to) });
      }
    } else {
      const n = parseInt(t, 10);
      if (Number.isFinite(n) && n >= 1) items.push({ type: 'single', value: n });
    }
  }
  return items;
}

export function openSamplerDetailModal({ node, isSamplerNameAlreadyUsedForSource }) {
  const nodeId = node?.dataset?.nodeId ?? '';
  const sourceNodeId = (node?.dataset?.sourceNodeId ?? '').trim();
  const name = (node?.dataset?.samplerName ?? '').trim() || 'Sample';
  const samplingType = node?.dataset?.samplerSamplingType || 'without-replacement';
  const sampleSizeType = node?.dataset?.samplerSampleSizeType || 'rows';
  const sampleSize = node?.dataset?.samplerSampleSize != null ? parseInt(node.dataset.samplerSampleSize, 10) : 100;
  const rowSpec = (node?.dataset?.samplerRowSpec ?? '').trim();
  const rowSpecItems = parseRowSpecToItems(rowSpec);

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'sampler-detail-title');
  overlay.innerHTML = `
    <div class="modal-panel modal-panel--sampler-detail">
      <div class="modal-header">
        <h2 id="sampler-detail-title" class="modal-title">Sample: ${escapeHtml(name)}</h2>
        <button type="button" class="modal-close" aria-label="Close">×</button>
      </div>
      <div class="modal-body modal-body--sampler">
        <div class="sampler-main">
          <div class="dataset-meta-wrap prompt-meta-wrap sampler-meta-wrap">
            <div class="dataset-meta-field">
              <span class="dataset-meta-label">Sampling method</span>
              <div class="sampler-radio-group">
                <label class="sampler-radio-label"><input type="radio" name="sampler-replacement" value="with-replacement" /> With replacement</label>
                <label class="sampler-radio-label"><input type="radio" name="sampler-replacement" value="without-replacement" /> Without replacement</label>
                <label class="sampler-radio-label"><input type="radio" name="sampler-replacement" value="specify-rows" /> Specify rows</label>
              </div>
            </div>
            <div class="sampler-size-wrap dataset-meta-field">
              <span class="dataset-meta-label">Sample size</span>
              <div class="sampler-radio-group">
                <label class="sampler-radio-label"><input type="radio" name="sampler-size-type" value="rows" /> Rows</label>
                <label class="sampler-radio-label"><input type="radio" name="sampler-size-type" value="ratio" /> Ratio</label>
              </div>
              <div class="sampler-size-rows-wrap dataset-meta-field">
                <label class="dataset-meta-label" for="sampler-rows-inp">Rows</label>
                <input type="number" id="sampler-rows-inp" class="dataset-meta-input" min="1" placeholder="e.g. 100" />
              </div>
              <div class="sampler-size-ratio-wrap dataset-meta-field" style="display: none;">
                <label class="dataset-meta-label" for="sampler-ratio-inp">Ratio (%)</label>
                <input type="number" id="sampler-ratio-inp" class="dataset-meta-input" min="1" max="100" placeholder="1–100" aria-label="Ratio percentage (1–100)" />
              </div>
            </div>
            <div class="sampler-specify-rows-wrap" style="display: none;">
              <div class="dataset-meta-field sampler-row-spec-block">
                <span class="dataset-meta-label">Add row</span>
                <div class="sampler-row-spec-add-row">
                  <input type="number" id="sampler-add-number-inp" class="dataset-meta-input sampler-add-number-inp" min="1" placeholder="#" aria-label="Row number (1-based)" />
                  <button type="button" class="btn btn-secondary sampler-add-number-btn">Add</button>
                </div>
              </div>
              <div class="dataset-meta-field sampler-row-spec-block">
                <span class="dataset-meta-label">Add range</span>
                <div class="sampler-row-spec-add-row">
                  <input type="number" id="sampler-add-range-from" class="dataset-meta-input sampler-add-range-inp" min="1" placeholder="From #" aria-label="From row" />
                  <span class="sampler-row-spec-to-label">to</span>
                  <input type="number" id="sampler-add-range-to" class="dataset-meta-input sampler-add-range-inp" min="1" placeholder="To #" aria-label="To row" />
                  <button type="button" class="btn btn-secondary sampler-add-range-btn">Add range</button>
                </div>
              </div>
              <div class="dataset-meta-field">
                <span class="dataset-meta-label">Selected rows</span>
                <div class="sampler-row-spec-list" role="list" aria-label="Selected row numbers and ranges"></div>
              </div>
            </div>
          </div>
          <div class="prompt-form-error prompt-modal-error sampler-form-error" role="alert" aria-live="polite" hidden></div>
          <div class="prompt-actions sampler-actions">
            <button type="button" class="btn btn-secondary dataset-detail-btn-save">Save</button>
            <button type="button" class="btn btn-secondary sampler-detail-btn-create-subset">Create dataset</button>
          </div>
        </div>
      </div>
    </div>
  `;

  const titleEl = overlay.querySelector('#sampler-detail-title');
  const samplerRowsInp = overlay.querySelector('#sampler-rows-inp');
  const samplerRatioInp = overlay.querySelector('#sampler-ratio-inp');
  const samplerSizeWrap = overlay.querySelector('.sampler-size-wrap');
  const samplerSizeRowsWrap = overlay.querySelector('.sampler-size-rows-wrap');
  const samplerSizeRatioWrap = overlay.querySelector('.sampler-size-ratio-wrap');
  const samplerSpecifyRowsWrap = overlay.querySelector('.sampler-specify-rows-wrap');
  const samplerRowSpecList = overlay.querySelector('.sampler-row-spec-list');
  const samplerAddNumberInp = overlay.querySelector('#sampler-add-number-inp');
  const samplerAddNumberBtn = overlay.querySelector('.sampler-add-number-btn');
  const samplerAddRangeFrom = overlay.querySelector('#sampler-add-range-from');
  const samplerAddRangeTo = overlay.querySelector('#sampler-add-range-to');
  const samplerAddRangeBtn = overlay.querySelector('.sampler-add-range-btn');
  const samplerFormErrorEl = overlay.querySelector('.sampler-form-error');
  const btnSave = overlay.querySelector('.dataset-detail-btn-save');
  const btnCreateSubset = overlay.querySelector('.sampler-detail-btn-create-subset');

  const editRowSpecItems = [];
  function renderRowSpecList() {
    if (!samplerRowSpecList) return;
    samplerRowSpecList.innerHTML = '';
    editRowSpecItems.forEach((item, idx) => {
      const chip = document.createElement('span');
      chip.className = 'sampler-row-spec-chip';
      chip.setAttribute('role', 'listitem');
      if (item.type === 'single') {
        chip.textContent = String(item.value);
      } else {
        chip.textContent = `${item.from}–${item.to}`;
      }
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'sampler-row-spec-chip-remove';
      remove.setAttribute('aria-label', 'Remove');
      remove.textContent = '×';
      remove.addEventListener('click', () => {
        editRowSpecItems.splice(idx, 1);
        renderRowSpecList();
      });
      chip.appendChild(remove);
      samplerRowSpecList.appendChild(chip);
    });
  }
  function buildRowSpecString() {
    return editRowSpecItems.map((item) => (item.type === 'single' ? String(item.value) : `${item.from}-${item.to}`)).join(' ');
  }

  /** Current form state for dirty check (normalized). */
  function getFormState() {
    const samplingTypeVal = overlay.querySelector('input[name="sampler-replacement"]:checked')?.value || 'without-replacement';
    const isSpecify = samplingTypeVal === 'specify-rows';
    const sampleSizeTypeVal = overlay.querySelector('input[name="sampler-size-type"]:checked')?.value || 'rows';
    const rowsVal = samplerRowsInp?.value != null ? samplerRowsInp.value.trim() : '';
    const ratioVal = samplerRatioInp?.value != null ? samplerRatioInp.value.trim() : '';
    const sizeNum = sampleSizeTypeVal === 'rows' ? parseInt(rowsVal, 10) : parseInt(ratioVal, 10);
    const sampleSize = sampleSizeTypeVal === 'rows'
      ? (Number.isFinite(sizeNum) && sizeNum >= 1 ? sizeNum : 100)
      : (Number.isFinite(sizeNum) && sizeNum >= 1 && sizeNum <= 100 ? sizeNum : 100);
    return {
      name: (node?.dataset?.samplerName ?? '').trim() || 'Sample',
      samplingType: samplingTypeVal,
      sampleSizeType: isSpecify ? 'rows' : sampleSizeTypeVal,
      sampleSize: isSpecify ? 100 : sampleSize,
      rowSpec: isSpecify ? buildRowSpecString() : '',
    };
  }

  function isDirty() {
    const cur = getFormState();
    const initialName = (node?.dataset?.samplerName ?? '').trim() || '';
    const initialSt = node?.dataset?.samplerSamplingType || 'without-replacement';
    const initialSst = node?.dataset?.samplerSampleSizeType || 'rows';
    const initialSize = node?.dataset?.samplerSampleSize != null ? parseInt(node.dataset.samplerSampleSize, 10) : 100;
    const initialRowSpec = (node?.dataset?.samplerRowSpec ?? '').trim();
    if ((cur.name || 'Sample') !== (initialName || 'Sample')) return true;
    if (cur.samplingType !== initialSt) return true;
    if (initialSt === 'specify-rows') {
      if (cur.rowSpec !== initialRowSpec) return true;
    } else {
      if (cur.sampleSizeType !== initialSst) return true;
      if (String(cur.sampleSize) !== String(initialSize)) return true;
    }
    return false;
  }

  function populateForm() {
    const st = node?.dataset?.samplerSamplingType || 'without-replacement';
    overlay.querySelector(`input[name="sampler-replacement"][value="${st}"]`)?.click();
    const sst = node?.dataset?.samplerSampleSizeType || 'rows';
    overlay.querySelector(`input[name="sampler-size-type"][value="${sst}"]`)?.click();
    const size = node?.dataset?.samplerSampleSize != null ? parseInt(node.dataset.samplerSampleSize, 10) : 100;
    if (samplerRowsInp) samplerRowsInp.value = sst === 'rows' ? String(size) : '';
    if (samplerRatioInp) samplerRatioInp.value = sst === 'ratio' ? String(size) : '';
    editRowSpecItems.length = 0;
    rowSpecItems.forEach((item) => editRowSpecItems.push({ ...item }));
    renderRowSpecList();
    if (samplerFormErrorEl) samplerFormErrorEl.hidden = true;
    updateSamplerModeVisibility();
  }

  function updateSamplerModeVisibility() {
    const samplingType = overlay.querySelector('input[name="sampler-replacement"]:checked')?.value || 'without-replacement';
    const isSpecify = samplingType === 'specify-rows';
    if (samplerSizeWrap) samplerSizeWrap.style.display = isSpecify ? 'none' : '';
    if (samplerSpecifyRowsWrap) samplerSpecifyRowsWrap.style.display = isSpecify ? 'flex' : 'none';
  }
  overlay.querySelectorAll('input[name="sampler-replacement"]').forEach((radio) => {
    radio.addEventListener('change', updateSamplerModeVisibility);
  });

  overlay.querySelectorAll('input[name="sampler-size-type"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      const isRows = overlay.querySelector('input[name="sampler-size-type"]:checked')?.value === 'rows';
      if (samplerSizeRowsWrap) samplerSizeRowsWrap.style.display = isRows ? '' : 'none';
      if (samplerSizeRatioWrap) samplerSizeRatioWrap.style.display = isRows ? 'none' : '';
    });
  });

  function addSingleRow() {
    if (!samplerAddNumberInp) return;
    const n = parseInt(samplerAddNumberInp.value, 10);
    if (!Number.isFinite(n) || n < 1) return;
    editRowSpecItems.push({ type: 'single', value: n });
    renderRowSpecList();
    samplerAddNumberInp.value = '';
    samplerAddNumberInp.focus();
  }
  if (samplerAddNumberBtn && samplerAddNumberInp) {
    samplerAddNumberBtn.addEventListener('click', addSingleRow);
    samplerAddNumberInp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addSingleRow(); } });
  }
  if (samplerAddRangeBtn && samplerAddRangeFrom && samplerAddRangeTo) {
    samplerAddRangeBtn.addEventListener('click', () => {
      const from = parseInt(samplerAddRangeFrom.value, 10);
      const to = parseInt(samplerAddRangeTo.value, 10);
      if (!Number.isFinite(from) || !Number.isFinite(to) || from < 1 || to < 1) return;
      const low = Math.min(from, to);
      const high = Math.max(from, to);
      editRowSpecItems.push({ type: 'range', from: low, to: high });
      renderRowSpecList();
      samplerAddRangeFrom.value = '';
      samplerAddRangeTo.value = '';
    });
  }

  /** Validate form and apply to node. Returns true if saved, false if validation failed (error shown). */
  function performSave() {
    if (samplerFormErrorEl) samplerFormErrorEl.hidden = true;
    const newName = (node?.dataset?.samplerName ?? '').trim() || 'Sample';
    const samplingTypeVal = overlay.querySelector('input[name="sampler-replacement"]:checked')?.value || 'without-replacement';
    const isSpecifyRowsVal = samplingTypeVal === 'specify-rows';
    const rowSpecVal = isSpecifyRowsVal ? buildRowSpecString() : '';
    const sampleSizeTypeVal = overlay.querySelector('input[name="sampler-size-type"]:checked')?.value || 'rows';
    const rowsValue = samplerRowsInp?.value != null ? samplerRowsInp.value.trim() : '';
    const rowsNum = sampleSizeTypeVal === 'rows' ? parseInt(rowsValue, 10) : NaN;
    const ratioValue = samplerRatioInp?.value != null ? samplerRatioInp.value.trim() : '';
    const ratioNum = sampleSizeTypeVal === 'ratio' ? parseInt(ratioValue, 10) : NaN;
    const sampleSizeVal = sampleSizeTypeVal === 'rows'
      ? (Number.isFinite(rowsNum) && rowsNum >= 1 ? rowsNum : 100)
      : (Number.isFinite(ratioNum) && ratioNum >= 1 && ratioNum <= 100 ? ratioNum : 100);

    if (!newName) {
      if (samplerFormErrorEl) {
        samplerFormErrorEl.textContent = 'Sample name is required.';
        samplerFormErrorEl.hidden = false;
      }
      return false;
    }
    if (isSpecifyRowsVal && editRowSpecItems.length === 0) {
      if (samplerFormErrorEl) {
        samplerFormErrorEl.textContent = 'Add at least one row number or range.';
        samplerFormErrorEl.hidden = false;
      }
      return false;
    }
    if (!isSpecifyRowsVal && sampleSizeTypeVal === 'rows' && (!Number.isFinite(rowsNum) || rowsNum < 1)) {
      if (samplerFormErrorEl) {
        samplerFormErrorEl.textContent = 'Sample size (rows) is required. Enter at least 1 row.';
        samplerFormErrorEl.hidden = false;
      }
      return false;
    }
    if (!isSpecifyRowsVal && sampleSizeTypeVal === 'ratio' && (!Number.isFinite(ratioNum) || ratioNum < 1 || ratioNum > 100)) {
      if (samplerFormErrorEl) {
        samplerFormErrorEl.textContent = 'Ratio is required. Enter a number between 1 and 100.';
        samplerFormErrorEl.hidden = false;
      }
      return false;
    }
    if (sourceNodeId && typeof isSamplerNameAlreadyUsedForSource === 'function' && isSamplerNameAlreadyUsedForSource(newName, sourceNodeId, nodeId)) {
      if (samplerFormErrorEl) {
        samplerFormErrorEl.textContent = 'This sample name is already used for this dataset. Please choose another.';
        samplerFormErrorEl.hidden = false;
      }
      return false;
    }

    if (node) {
      node.dataset.samplerName = newName;
      node.dataset.samplerSamplingType = samplingTypeVal;
      if (isSpecifyRowsVal) {
        node.dataset.samplerRowSpec = rowSpecVal;
        delete node.dataset.samplerSampleSizeType;
        delete node.dataset.samplerSampleSize;
      } else {
        node.dataset.samplerSampleSizeType = sampleSizeTypeVal;
        node.dataset.samplerSampleSize = String(sampleSizeVal);
        delete node.dataset.samplerRowSpec;
      }
      const titleElNode = node.querySelector('.workflow-node__title');
      if (titleElNode) titleElNode.textContent = newName || 'Sample';
    }
    document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
    return true;
  }

  btnSave.addEventListener('click', () => {
    if (performSave()) close();
  });

  function requestClose() {
    if (!isDirty()) {
      close();
      return;
    }
    const panel = overlay.querySelector('.modal-panel');
    const saveDialog = document.createElement('div');
    saveDialog.className = 'working-dataset-save-dialog-overlay';
    saveDialog.setAttribute('role', 'dialog');
    saveDialog.setAttribute('aria-labelledby', 'sampler-save-dialog-title');
    saveDialog.innerHTML = `
      <div class="working-dataset-save-dialog">
        <p id="sampler-save-dialog-title" class="working-dataset-save-dialog-title">Save changes before closing?</p>
        <div class="working-dataset-save-dialog-btns">
          <button type="button" class="btn btn-secondary wd-save-dialog-save">Save</button>
          <button type="button" class="btn btn-secondary wd-save-dialog-dont">Don't save</button>
          <button type="button" class="btn btn-secondary wd-save-dialog-cancel">Cancel</button>
        </div>
      </div>
    `;
    const removeDialog = () => saveDialog.remove();
    saveDialog.querySelector('.wd-save-dialog-save').addEventListener('click', () => {
      removeDialog();
      if (performSave()) close();
    });
    saveDialog.querySelector('.wd-save-dialog-dont').addEventListener('click', () => {
      removeDialog();
      close();
    });
    saveDialog.querySelector('.wd-save-dialog-cancel').addEventListener('click', removeDialog);
    panel.appendChild(saveDialog);
  }

  overlay.querySelector('.modal-close').addEventListener('click', requestClose);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) requestClose();
  });

  if (btnCreateSubset) {
    btnCreateSubset.addEventListener('click', () => {
      if (!performSave()) return;
      const samplerNodeId = node?.dataset?.nodeId ?? '';
      const colorIndex = node?.dataset?.samplerColorIndex != null ? parseInt(node.dataset.samplerColorIndex, 10) : undefined;
      document.dispatchEvent(new CustomEvent('workflow:add-subset-node', { detail: { samplerNodeId, colorIndex } }));
      close();
    });
  }

  function close() {
    overlay.remove();
    document.body.style.overflow = '';
  }

  populateForm();
  const sst = sampleSizeType;
  if (samplerSizeRowsWrap) samplerSizeRowsWrap.style.display = sst === 'rows' ? '' : 'none';
  if (samplerSizeRatioWrap) samplerSizeRatioWrap.style.display = sst === 'ratio' ? '' : 'none';

  document.body.style.overflow = 'hidden';
  document.body.appendChild(overlay);
}
