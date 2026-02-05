/**
 * Sampler detail modal: read-only view of sampler settings (name, sampling type, sample size).
 * @param {{ node: HTMLElement }} options
 */

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

export function openSamplerDetailModal({ node }) {
  const name = (node?.dataset?.samplerName ?? '').trim() || 'Sampler';
  const samplingType = node?.dataset?.samplerSamplingType || 'without-replacement';
  const isSpecifyRows = samplingType === 'specify-rows';
  const sampleSizeType = node?.dataset?.samplerSampleSizeType || 'rows';
  const sampleSize = node?.dataset?.samplerSampleSize != null ? parseInt(node.dataset.samplerSampleSize, 10) : 100;
  const rowSpec = (node?.dataset?.samplerRowSpec ?? '').trim();

  const samplingLabel = isSpecifyRows ? 'Specify rows' : (samplingType === 'with-replacement' ? 'With replacement' : 'Without replacement');
  const sizeLabel = isSpecifyRows ? (rowSpec || '(none)') : (sampleSizeType === 'rows' ? `${sampleSize} rows` : `${sampleSize}%`);
  const sizeRowLabel = isSpecifyRows ? 'Row numbers' : 'Sample size';

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'sampler-detail-title');
  overlay.innerHTML = `
    <div class="modal-panel modal-panel--sampler-detail">
      <div class="modal-header">
        <h2 id="sampler-detail-title" class="modal-title">Sampler details: ${escapeHtml(name)}</h2>
        <button type="button" class="modal-close" aria-label="Close">×</button>
      </div>
      <div class="modal-body sampler-detail-body">
        <div class="dataset-detail-card sampler-detail-card">
          <div class="dataset-detail-row sampler-detail-row">
            <span class="dataset-detail-label">Sampler name</span>
            <span class="sampler-detail-value">${escapeHtml(name)}</span>
          </div>
          <div class="dataset-detail-row sampler-detail-row">
            <span class="dataset-detail-label">Sampling</span>
            <span class="sampler-detail-value">${escapeHtml(samplingLabel)}</span>
          </div>
          <div class="dataset-detail-row sampler-detail-row">
            <span class="dataset-detail-label">${escapeHtml(sizeRowLabel)}</span>
            <span class="sampler-detail-value">${escapeHtml(sizeLabel)}</span>
          </div>
          <div class="dataset-detail-footer">
            <button type="button" class="btn btn-secondary sampler-detail-btn-create-subset">Create working dataset</button>
          </div>
        </div>
      </div>
    </div>
  `;

  overlay.querySelector('.modal-close').addEventListener('click', close);

  const btnCreateSubset = overlay.querySelector('.sampler-detail-btn-create-subset');
  if (btnCreateSubset) {
    btnCreateSubset.addEventListener('click', () => {
      const samplerNodeId = node?.dataset?.nodeId ?? '';
      const colorIndex = node?.dataset?.samplerColorIndex != null ? parseInt(node.dataset.samplerColorIndex, 10) : undefined;
      document.dispatchEvent(new CustomEvent('workflow:add-subset-node', { detail: { samplerNodeId, colorIndex } }));
    });
  }

  function close() {
    overlay.remove();
    document.body.style.overflow = '';
  }

  document.body.style.overflow = 'hidden';
  document.body.appendChild(overlay);
}
