/**
 * "Add a new agent" modal: choose agent type, LLM, then Add this agent.
 */

export function openAddAgentModal() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'new-agent-title');
  overlay.innerHTML = `
    <div class="modal-panel modal-panel--agent">
      <div class="modal-header">
        <h2 id="new-agent-title" class="modal-title">Add a new agent</h2>
        <button type="button" class="modal-close" aria-label="Close">×</button>
      </div>
      <div class="modal-body modal-body--agent">
        <div class="agent-form">
          <div class="agent-form-field">
            <label class="dataset-meta-label" for="agent-type-select">Agent type</label>
            <select id="agent-type-select" class="credentials-select" aria-label="Select agent type">
              <option value="">Select an agent type...</option>
              <option value="task-executor">Task executor</option>
              <option value="result-analyzer">Result analyzer</option>
              <option value="prompt-modifier">Prompt modifier</option>
            </select>
          </div>
          <div class="agent-form-field">
            <label class="dataset-meta-label" for="agent-llm-select">LLM</label>
            <select id="agent-llm-select" class="credentials-select" aria-label="Select LLM">
              <option value="">Select an LLM...</option>
              <option value="openai">OpenAI (GPT)</option>
              <option value="anthropic">Anthropic (Claude)</option>
              <option value="other">Other</option>
            </select>
          </div>
          <div class="agent-form-actions">
            <button type="button" class="btn btn-secondary agent-add-btn">Add this agent</button>
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
  overlay.querySelector('.agent-add-btn').addEventListener('click', () => {
    const typeSelect = overlay.querySelector('#agent-type-select');
    const llmSelect = overlay.querySelector('#agent-llm-select');
    const type = typeSelect.value;
    const llm = llmSelect.value;
    // TODO: add agent (type, llm) and close
    console.log('Add agent:', { type, llm });
    close();
  });

  document.body.style.overflow = 'hidden';
  document.body.appendChild(overlay);
}
