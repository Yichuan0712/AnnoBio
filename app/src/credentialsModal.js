/**
 * "My credentials" modal: table of LLM credentials, add form (shell only).
 */

export function openCredentialsModal() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'my-credentials-title');
  overlay.innerHTML = `
    <div class="modal-panel modal-panel--credentials">
      <div class="modal-header">
        <h2 id="my-credentials-title" class="modal-title">My credentials</h2>
        <button type="button" class="modal-close" aria-label="Close">×</button>
      </div>
      <div class="modal-body modal-body--credentials">
        <div class="credentials-table-wrap">
          <h3 class="credentials-section-title">LLMs you can use</h3>
          <div class="credentials-table-scroll">
            <table class="credentials-table" aria-label="LLM credentials">
              <thead>
                <tr>
                  <th>LLM</th>
                  <th>API key</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                <tr class="credentials-table-empty">
                  <td colspan="3">No credentials added yet.</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
        <div class="credentials-add">
          <h3 class="credentials-section-title">Create credential</h3>
          <div class="credentials-add-row">
            <div class="credentials-add-field">
              <label class="dataset-meta-label" for="credentials-llm-select">LLM</label>
              <select id="credentials-llm-select" class="credentials-select" aria-label="Select LLM">
                <option value="">Select an LLM...</option>
                <option value="openai">OpenAI (GPT)</option>
                <option value="anthropic">Anthropic (Claude)</option>
                <option value="other">Other</option>
              </select>
            </div>
            <div class="credentials-add-field credentials-add-field--grow">
              <label class="dataset-meta-label" for="credentials-api-key">API key</label>
              <input type="password" id="credentials-api-key" class="dataset-meta-input" placeholder="Enter your API key" autocomplete="off" />
            </div>
            <div class="credentials-add-field credentials-add-field--btn">
              <label class="dataset-meta-label" aria-hidden="true">&nbsp;</label>
              <button type="button" class="btn btn-secondary credentials-add-btn">Create and add to table</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  const close = () => {
    overlay.remove();
    document.body.style.overflow = '';
  };
  overlay.querySelector('.modal-close').addEventListener('click', close);
  overlay.querySelector('.credentials-add-btn').addEventListener('click', () => {
    // TODO: add credential to table
  });

  document.body.style.overflow = 'hidden';
  document.body.appendChild(overlay);
}
