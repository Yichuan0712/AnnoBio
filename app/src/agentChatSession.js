import { AGENT_TITLE_MAX_CHARS, clampAgentTitle } from './agentTitleLimits.js';
import { BACKEND_API_BASE, waitForBackend } from './backendConfig.js';
import { answerQuestion, findPendingInteraction, resolveProposal, resolveRunRequest, runAgentLoop } from './agent/agentLoop.js';
import { buildWorkspaceSummary } from './agent/context/workspaceSummary.js';
import { formatAgentText } from './agent/formatAgentText.js';
import { diffLines } from './agent/lineDiff.js';
import { executeRunRequest, previewRunRequest } from './agent/execution/runJobs.js';
import { applyProposal, previewProposal } from './agent/operations/proposals.js';
import { ASK_USER_TOOL, PROPOSE_CHANGES_TOOL, RUN_NODES_TOOL, USER_TOOLS } from './agent/tools/agentTools.js';

const API_BASE = BACKEND_API_BASE;
const TITLE_SUMMARY_MAX_ROUNDS = 3;

function deriveConversationTitle(text) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return 'New Agent';
  return clampAgentTitle(normalized);
}

function textRounds(messages) {
  return (Array.isArray(messages) ? messages : []).filter(
    (m) => (m?.role === 'user' || m?.role === 'assistant') && String(m.content || '').trim(),
  );
}

function getTitleSummarySourceMessages(messages) {
  const source = [];
  let assistantRounds = 0;
  for (const message of textRounds(messages)) {
    source.push({ role: message.role, content: String(message.content).trim() });
    if (message.role === 'assistant') {
      assistantRounds += 1;
      if (assistantRounds >= TITLE_SUMMARY_MAX_ROUNDS) break;
    }
  }
  return source;
}

function shouldRefreshGeneratedTitle(messages) {
  const assistantRounds = textRounds(messages).filter((m) => m.role === 'assistant').length;
  return assistantRounds >= 1 && assistantRounds <= TITLE_SUMMARY_MAX_ROUNDS;
}

function buildTitleSummaryPrompt(messages) {
  const transcript = messages
    .map((message) => `${message.role === 'assistant' ? 'Assistant' : 'User'}: ${message.content}`)
    .join('\n');
  return [
    {
      role: 'system',
      content:
        'You generate concise chat titles. Return only the title text with no quotes, no markdown, and no ending punctuation.',
    },
    {
      role: 'user',
      content: `Summarize this conversation into a short title.\nRequirements:\n- Use the first three rounds of the conversation only\n- Maximum ${AGENT_TITLE_MAX_CHARS} characters total (including spaces), single line, no line breaks\n- Prefer about 4–6 words in English when it fits; be concise\n- Clear and specific; do not end with punctuation\n\nConversation:\n${transcript}`,
    },
  ];
}

function normalizeGeneratedTitle(title, fallbackText = '') {
  const normalized = String(title || '')
    .replace(/^["'\s]+|["'\s]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return deriveConversationTitle(fallbackText);
  return clampAgentTitle(normalized);
}

function autoResizeTextarea(textareaEl) {
  if (!textareaEl) return;
  textareaEl.style.height = 'auto';
  textareaEl.style.height = `${textareaEl.scrollHeight}px`;
}

function getSendIconSvg() {
  return `
    <svg class="agent-window__button-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 13.5a.75.75 0 0 1-.75-.75V5.56L4.78 8.03a.75.75 0 1 1-1.06-1.06l3.75-3.75a.75.75 0 0 1 1.06 0l3.75 3.75a.75.75 0 0 1-1.06 1.06L8.75 5.56v7.19a.75.75 0 0 1-.75.75Z"></path>
    </svg>
  `;
}

function createMessageShell(role) {
  const wrapper = document.createElement('div');
  wrapper.className = `agent-window__message agent-window__message--${role}`;
  const roleEl = document.createElement('div');
  roleEl.className = 'agent-window__message-role';
  roleEl.textContent = role === 'assistant' ? 'Agent' : 'You';
  const bubbleEl = document.createElement('div');
  bubbleEl.className = 'agent-window__message-bubble';
  wrapper.append(roleEl, bubbleEl);
  return { wrapper, bubbleEl };
}

function createUserMessageNode(content, { actionDisabled = false, onEdit = null } = {}) {
  const { wrapper, bubbleEl } = createMessageShell('user');
  const contentEl = document.createElement('div');
  contentEl.className = 'agent-window__message-content';
  contentEl.textContent = content;
  bubbleEl.appendChild(contentEl);
  if (typeof onEdit === 'function') {
    const editButtonEl = document.createElement('button');
    editButtonEl.type = 'button';
    editButtonEl.className = 'agent-window__message-action';
    if (actionDisabled) editButtonEl.classList.add('is-disabled');
    editButtonEl.textContent = '↩';
    editButtonEl.setAttribute('aria-label', 'Edit this message');
    editButtonEl.title = 'Edit';
    editButtonEl.disabled = actionDisabled;
    editButtonEl.addEventListener('click', onEdit);
    bubbleEl.appendChild(editButtonEl);
  }
  return wrapper;
}

function createAssistantTextNode(text) {
  const { wrapper, bubbleEl } = createMessageShell('assistant');
  const contentEl = document.createElement('div');
  contentEl.className = 'agent-window__message-content';
  contentEl.innerHTML = formatAgentText(text);
  bubbleEl.appendChild(contentEl);
  return wrapper;
}

function createActivityNode(items) {
  const listEl = document.createElement('ul');
  listEl.className = 'agent-window__activity';
  for (const item of items) {
    const itemEl = document.createElement('li');
    // A proposal that failed validation went back to the Agent to fix: part of the flow, not an error.
    const isCheck = (item.name === PROPOSE_CHANGES_TOOL || item.name === RUN_NODES_TOOL) && !item.outcome;
    itemEl.className = `agent-window__activity-item${isCheck ? ' is-check' : item.ok === false ? ' is-error' : ''}`;
    itemEl.textContent = item.label || item.name;
    listEl.appendChild(itemEl);
  }
  return listEl;
}

function createQuestionNode({ question, options, answer, active, onAnswer }) {
  const cardEl = document.createElement('div');
  cardEl.className = 'agent-window__question';
  const textEl = document.createElement('div');
  textEl.className = 'agent-window__question-text';
  textEl.textContent = question;
  cardEl.appendChild(textEl);
  if (answer != null) {
    const answerEl = document.createElement('div');
    answerEl.className = 'agent-window__question-answer';
    answerEl.textContent = answer;
    cardEl.appendChild(answerEl);
    return cardEl;
  }
  const optionsEl = document.createElement('div');
  optionsEl.className = 'agent-window__question-options';
  for (const option of options) {
    const buttonEl = document.createElement('button');
    buttonEl.type = 'button';
    buttonEl.className = 'btn btn-secondary agent-window__question-option';
    buttonEl.textContent = option;
    buttonEl.disabled = !active;
    buttonEl.addEventListener('click', () => onAnswer(option));
    optionsEl.appendChild(buttonEl);
  }
  cardEl.appendChild(optionsEl);
  if (active) {
    const hintEl = document.createElement('div');
    hintEl.className = 'agent-window__question-hint';
    hintEl.textContent = 'Or type your own answer below.';
    cardEl.appendChild(hintEl);
  }
  return cardEl;
}

function createDiffNode({ label, before, after }) {
  const detailsEl = document.createElement('details');
  detailsEl.className = 'agent-window__diff';
  const lines = diffLines(before, after);
  detailsEl.open = lines.length <= 40;
  const summaryEl = document.createElement('summary');
  summaryEl.textContent = label;
  const preEl = document.createElement('pre');
  preEl.className = 'agent-window__diff-body';
  for (const line of lines) {
    const lineEl = document.createElement('div');
    lineEl.className = `agent-window__diff-line is-${line.type}`;
    lineEl.textContent = `${line.type === 'added' ? '+ ' : line.type === 'removed' ? '- ' : '  '}${line.text}`;
    preEl.appendChild(lineEl);
  }
  detailsEl.append(summaryEl, preEl);
  return detailsEl;
}

/**
 * The card for one propose_changes call: every change with its details and diffs; Apply / Reject
 * while it is the open proposal, or how it ended once resolved.
 */
function createProposalNode({
  summary, preview, outcome, active, onApply, onReject, onHighlight,
  applyLabel = 'Apply', rejectLabel = 'Reject', hint = null,
}) {
  const cardEl = document.createElement('div');
  cardEl.className = 'agent-window__proposal';
  const headEl = document.createElement('div');
  headEl.className = 'agent-window__proposal-summary';
  headEl.textContent = summary || 'Proposed changes';
  cardEl.appendChild(headEl);

  const listEl = document.createElement('ol');
  listEl.className = 'agent-window__proposal-items';
  for (const item of preview?.items || []) {
    const itemEl = document.createElement('li');
    itemEl.className = `agent-window__proposal-item is-${item.kind}`;
    const titleEl = document.createElement('div');
    titleEl.className = 'agent-window__proposal-title';
    titleEl.textContent = item.title;
    itemEl.appendChild(titleEl);
    for (const line of item.lines || []) {
      const lineEl = document.createElement('div');
      lineEl.className = 'agent-window__proposal-line';
      lineEl.textContent = line;
      itemEl.appendChild(lineEl);
    }
    for (const diff of item.diffs || []) itemEl.appendChild(createDiffNode(diff));
    if (item.nodeIds?.length && typeof onHighlight === 'function') {
      itemEl.addEventListener('mouseenter', () => onHighlight(item.nodeIds));
      itemEl.addEventListener('mouseleave', () => onHighlight([]));
    }
    listEl.appendChild(itemEl);
  }
  cardEl.appendChild(listEl);

  for (const warning of preview?.warnings || []) {
    const warningEl = document.createElement('div');
    warningEl.className = 'agent-window__proposal-warning';
    warningEl.textContent = warning;
    cardEl.appendChild(warningEl);
  }
  if (preview?.total) {
    const totalEl = document.createElement('div');
    totalEl.className = 'agent-window__proposal-total';
    totalEl.textContent = preview.total;
    cardEl.appendChild(totalEl);
  }

  if (outcome != null) {
    const outcomeEl = document.createElement('div');
    outcomeEl.className = `agent-window__proposal-outcome${/^(Applied|Completed)\b/.test(outcome) ? ' is-applied' : ''}`;
    outcomeEl.textContent = outcome;
    cardEl.appendChild(outcomeEl);
    return cardEl;
  }

  const actionsEl = document.createElement('div');
  actionsEl.className = 'agent-window__proposal-actions';
  const applyBtn = document.createElement('button');
  applyBtn.type = 'button';
  applyBtn.className = 'btn btn-primary';
  applyBtn.textContent = applyLabel;
  applyBtn.disabled = !active;
  applyBtn.addEventListener('click', onApply);
  const rejectBtn = document.createElement('button');
  rejectBtn.type = 'button';
  rejectBtn.className = 'btn btn-secondary';
  rejectBtn.textContent = rejectLabel;
  rejectBtn.disabled = !active;
  rejectBtn.addEventListener('click', () => onReject(''));
  actionsEl.append(applyBtn, rejectBtn);
  cardEl.appendChild(actionsEl);
  if (active) {
    const hintEl = document.createElement('div');
    hintEl.className = 'agent-window__question-hint';
    hintEl.textContent = hint || 'Nothing changes until you apply, and one undo reverts the whole proposal. To ask for something different, type it below.';
    cardEl.appendChild(hintEl);
  }
  return cardEl;
}

/** Where the model's view of the conversation starts: the messages above reach it only as this summary. */
function createSummaryDividerNode(text) {
  const node = document.createElement('details');
  node.className = 'agent-chat-summary';
  const label = document.createElement('summary');
  label.textContent = "Earlier messages were summarized to fit the model's context";
  const body = document.createElement('div');
  body.className = 'agent-chat-summary__text';
  body.textContent = text;
  node.append(label, body);
  return node;
}

function createPendingNode({ text, status, onStop }) {
  const fragment = document.createDocumentFragment();
  if (text) fragment.appendChild(createAssistantTextNode(text));
  const statusEl = document.createElement('div');
  statusEl.className = 'agent-window__status';
  const spinnerEl = document.createElement('span');
  spinnerEl.className = 'agent-window__spinner';
  spinnerEl.setAttribute('aria-hidden', 'true');
  const statusTextEl = document.createElement('span');
  statusTextEl.className = 'agent-window__loading-text';
  statusTextEl.textContent = status || 'Thinking...';
  const stopBtn = document.createElement('button');
  stopBtn.type = 'button';
  stopBtn.className = 'agent-window__loading-stop';
  stopBtn.textContent = 'Click to Stop';
  stopBtn.setAttribute('aria-label', 'Click to stop generating');
  stopBtn.addEventListener('click', (e) => {
    e.preventDefault();
    onStop();
  });
  statusEl.append(spinnerEl, statusTextEl, stopBtn);
  fragment.appendChild(statusEl);
  return fragment;
}

function createEditingMessageNode(content, options = {}) {
  const { onInput = null, onSave = null, onCancel = null, saveDisabled = false } = options;
  const wrapper = document.createElement('div');
  wrapper.className = 'agent-window__message agent-window__message--user agent-window__message--editing';

  const roleEl = document.createElement('div');
  roleEl.className = 'agent-window__message-role';
  roleEl.textContent = 'You';

  const bubbleEl = document.createElement('div');
  bubbleEl.className = 'agent-window__message-bubble';

  const actionsEl = document.createElement('div');
  actionsEl.className = 'agent-window__message-editor-actions';

  const saveButtonEl = document.createElement('button');
  saveButtonEl.type = 'button';
  saveButtonEl.className = 'agent-window__composer-send agent-window__message-editor-save';
  saveButtonEl.innerHTML = getSendIconSvg();
  saveButtonEl.setAttribute('aria-label', 'Save edited message');
  saveButtonEl.title = 'Save';
  saveButtonEl.disabled = saveDisabled;
  saveButtonEl.addEventListener('click', () => {
    if (!saveButtonEl.disabled && typeof onSave === 'function') onSave();
  });

  const textareaEl = document.createElement('textarea');
  textareaEl.className = 'agent-window__message-editor';
  textareaEl.value = String(content || '');
  textareaEl.rows = 1;
  textareaEl.setAttribute('aria-label', 'Edit message');
  textareaEl.addEventListener('input', (event) => {
    autoResizeTextarea(textareaEl);
    saveButtonEl.disabled = !String(event.target.value || '').trim();
    if (typeof onInput === 'function') onInput(event.target.value);
  });
  textareaEl.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      if (typeof onCancel === 'function') onCancel();
      return;
    }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      if (!saveButtonEl.disabled && typeof onSave === 'function') onSave();
    }
  });

  actionsEl.appendChild(saveButtonEl);
  bubbleEl.appendChild(textareaEl);
  bubbleEl.appendChild(actionsEl);
  wrapper.appendChild(roleEl);
  wrapper.appendChild(bubbleEl);

  queueMicrotask(() => {
    autoResizeTextarea(textareaEl);
    textareaEl.focus();
    textareaEl.setSelectionRange(textareaEl.value.length, textareaEl.value.length);
  });

  return wrapper;
}

/** Falls back to the Review default when no Agent default is set, so upgrading doesn't silently
 * break chats that were already relying on the old Review-default behavior. */
async function loadAgentCredential() {
  // Opened right after launch, the window can beat the backend; without this the missing
  // credential would read as "no Agent model selected".
  await waitForBackend();
  const [credentials, settings] = await Promise.all([
    fetch(`${API_BASE}/api/credentials`).then((res) => (res.ok ? res.json() : [])),
    fetch(`${API_BASE}/api/settings`).then((res) => (res.ok ? res.json() : null)),
  ]);
  const agentId = String(settings?.default_agent_credential_id || '').trim()
    || String(settings?.default_review_credential_id || '').trim();
  const credential = Array.isArray(credentials)
    ? credentials.find((item) => item && item.id === agentId)
    : null;
  return credential || null;
}

async function loadCredentialContext() {
  const [credentials, settings] = await Promise.all([
    fetch(`${API_BASE}/api/credentials`).then((res) => (res.ok ? res.json() : [])).catch(() => []),
    fetch(`${API_BASE}/api/settings`).then((res) => (res.ok ? res.json() : null)).catch(() => null),
  ]);
  const credentialsById = new Map((Array.isArray(credentials) ? credentials : []).map((c) => [c.id, c]));
  const defaultRunCredential = credentialsById.get(String(settings?.default_run_credential_id || '').trim()) || null;
  return { credentialsById, defaultRunCredential };
}

async function requestTitle(credentialId, messages) {
  const res = await fetch(`${API_BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ credential_id: credentialId, messages }),
  });
  const payload = await res.json().catch(() => ({}));
  return res.ok ? String(payload?.content || '').trim() : '';
}

/**
 * @param {object} options
 * @param {{getCanvasState: Function, inspectNode: (id: string, options?: object) => Promise<object>,
 *   getScoreComparisonRows: (id: string) => Promise<object[]>, getSelectedNodeIds: () => string[],
 *   extractInputFields: Function}} options.workspace read access to the live canvas
 */
export function mountAgentChatSession({
  overlay,
  messagesEl,
  inputEl,
  sendButtonEl,
  autoResizeComposer,
  onConversationUpdated,
  onConversationDraftChanged,
  resolveConversation,
  workspace,
}) {
  if (!overlay || !messagesEl || !inputEl || !sendButtonEl || !workspace) {
    return {
      setConversation() {},
      destroy() {},
      stopAssistant() {},
    };
  }

  let credentialId = '';
  // Set when the Agent model's check (Settings → Agent defaults) found it cannot call tools.
  let credentialWarning = '';
  let sendInFlight = false;
  let activeAssistantAbortController = null;
  let activeConversationId = '';
  let editingMessageIndex = -1;
  let editingDraft = '';
  let renderScheduled = false;
  const titleRequestSerialByConversation = new Map();

  function isMounted() {
    return overlay.isConnected;
  }

  function ensureConversationMessages(conversation) {
    if (!conversation) return [];
    if (!Array.isArray(conversation.messages)) conversation.messages = [];
    return conversation.messages;
  }

  function getActiveConversation() {
    if (!activeConversationId || typeof resolveConversation !== 'function') return null;
    return resolveConversation(activeConversationId) || null;
  }

  function scrollToBottom() {
    const scrollContainer =
      messagesEl.closest('.agent-window__content') ||
      messagesEl.parentElement ||
      messagesEl;
    scrollContainer.scrollTop = scrollContainer.scrollHeight;
  }

  function notifyConversationUpdated(conversation) {
    if (typeof onConversationUpdated === 'function' && conversation) {
      onConversationUpdated(conversation);
    }
  }

  function notifyConversationDraftChanged(conversation) {
    if (typeof onConversationDraftChanged === 'function' && conversation) {
      onConversationDraftChanged(conversation);
    }
  }

  function isActive(conversation) {
    return isMounted() && activeConversationId === conversation?.id;
  }

  /** Coalesces streaming re-renders to one per frame. */
  function scheduleRender(conversation) {
    if (!isActive(conversation) || renderScheduled) return;
    renderScheduled = true;
    requestAnimationFrame(() => {
      renderScheduled = false;
      if (isActive(conversation)) renderActiveConversation();
    });
  }

  function stopAssistant() {
    activeAssistantAbortController?.abort();
  }

  // ---------- rendering ----------

  function renderActiveConversation() {
    const conversation = getActiveConversation();
    messagesEl.innerHTML = '';
    const messages = ensureConversationMessages(conversation);
    const busy = conversation?.pending || sendInFlight;
    const pendingInteraction = busy ? null : findPendingInteraction(messages);
    const responses = new Map(messages.filter((m) => m.role === 'tool' && USER_TOOLS.has(m.name)).map((m) => [m.toolCallId, m]));
    const summary = conversation?.contextSummary;
    const summaryAt = summary?.text && summary.covered <= messages.length ? summary.covered : -1;
    let activity = [];

    function flushActivity() {
      if (activity.length) messagesEl.appendChild(createActivityNode(activity));
      activity = [];
    }

    messages.forEach((message, index) => {
      if (index === summaryAt) {
        flushActivity();
        messagesEl.appendChild(createSummaryDividerNode(summary.text));
      }
      if (message.role === 'tool') {
        // Answers and proposal outcomes show on their cards; a proposal sent back to the model to
        // fix never got a card, so that one stays in the activity list.
        if (!USER_TOOLS.has(message.name) || (message.name !== ASK_USER_TOOL && !message.outcome)) activity.push(message);
        return;
      }
      flushActivity();
      if (message.role === 'user') {
        if (index === editingMessageIndex) {
          messagesEl.appendChild(createEditingMessageNode(editingDraft, {
            saveDisabled: !String(editingDraft || '').trim() || busy,
            onInput: (value) => { editingDraft = value; },
            onSave: submitEditedMessage,
            onCancel: cancelEditingMessage,
          }));
        } else {
          messagesEl.appendChild(createUserMessageNode(message.content, {
            actionDisabled: busy || editingMessageIndex !== -1,
            onEdit: () => startEditingMessage(index),
          }));
        }
        return;
      }
      if (String(message.content || '').trim()) messagesEl.appendChild(createAssistantTextNode(message.content));
      for (const call of message.toolCalls || []) {
        if (!USER_TOOLS.has(call.name)) continue;
        let args = {};
        try { args = JSON.parse(call.arguments || '{}'); } catch (_) {}
        const response = responses.get(call.id);
        if (call.name === ASK_USER_TOOL) {
          messagesEl.appendChild(createQuestionNode({
            question: String(args.question || ''),
            options: Array.isArray(args.options) ? args.options.map(String) : [],
            answer: response ? response.answer : null,
            active: pendingInteraction?.toolCallId === call.id,
            onAnswer: (answer) => submitAnswer(answer),
          }));
        } else if (call.preview) {
          const isRun = call.name === RUN_NODES_TOOL;
          messagesEl.appendChild(createProposalNode({
            summary: String(args.summary || ''),
            preview: call.preview,
            outcome: response ? (response.outcome || 'Resolved') : null,
            active: pendingInteraction?.toolCallId === call.id,
            onApply: () => (isRun ? submitRunDecision({ run: true }) : submitProposalDecision({ apply: true })),
            onReject: (feedback) => (isRun ? submitRunDecision({ run: false, feedback }) : submitProposalDecision({ apply: false, feedback })),
            onHighlight: workspace.highlightNodes,
            ...(isRun ? {
              applyLabel: 'Run',
              rejectLabel: 'Cancel',
              hint: 'Nothing runs until you start it. You can stop it while it runs. To change the plan, type below.',
            } : {}),
          }));
        }
      }
    });
    flushActivity();

    if (conversation?.pending) {
      messagesEl.appendChild(createPendingNode({
        text: conversation.streamingText || '',
        status: conversation.pendingStatus,
        onStop: stopAssistant,
      }));
    }
    scrollToBottom();
  }

  function updateComposerState() {
    const conversation = getActiveConversation();
    const hasText = Boolean((inputEl.value || '').trim());
    const composerLocked = sendInFlight || editingMessageIndex !== -1;
    inputEl.disabled = !credentialId || composerLocked || !conversation;
    sendButtonEl.disabled = !credentialId || composerLocked || !conversation || !hasText;
    const awaiting = conversation && findPendingInteraction(ensureConversationMessages(conversation));
    inputEl.placeholder = editingMessageIndex !== -1
      ? 'Finish editing this message first'
      : !conversation
        ? 'Select a chat first'
        : !credentialId
          ? 'Select an Agent model in Settings first'
          : sendInFlight
            ? 'Waiting for response...'
            : awaiting?.kind === 'question'
              ? 'Pick an option above or type your own answer...'
              : awaiting?.kind === 'proposal'
                ? 'Apply or reject the proposal above, or type what to change...'
                : awaiting?.kind === 'run'
                  ? 'Run or cancel the jobs above, or type what to change...'
                  : credentialWarning || 'Send a message...';
  }

  function syncComposerDraftFromConversation() {
    const conversation = getActiveConversation();
    inputEl.value = String(conversation?.unsentDraft || '');
    if (typeof autoResizeComposer === 'function') autoResizeComposer();
  }

  // ---------- editing ----------

  function startEditingMessage(messageIndex) {
    const conversation = getActiveConversation();
    if (!conversation || sendInFlight || conversation.pending) return;
    const targetMessage = ensureConversationMessages(conversation)[messageIndex];
    if (!targetMessage || targetMessage.role !== 'user') return;
    editingMessageIndex = messageIndex;
    editingDraft = String(targetMessage.content || '');
    renderActiveConversation();
    updateComposerState();
  }

  function cancelEditingMessage() {
    if (editingMessageIndex === -1) return;
    editingMessageIndex = -1;
    editingDraft = '';
    renderActiveConversation();
    updateComposerState();
  }

  function handleOutsidePointerDown(event) {
    if (editingMessageIndex === -1) return;
    const editingNode = messagesEl.querySelector('.agent-window__message--editing');
    if (!editingNode || editingNode.contains(event.target)) return;
    cancelEditingMessage();
  }

  // ---------- the agent turn ----------

  async function buildToolRuntime() {
    const { credentialsById, defaultRunCredential } = await loadCredentialContext();
    const inspectOptions = { credentialsById, defaultRunCredential };
    const inspectNode = (nodeId) => workspace.inspectNode(nodeId, inspectOptions);
    const buildSummary = () => buildWorkspaceSummary(workspace.getCanvasState(), {
      extractInputFields: workspace.extractInputFields,
      inspectNode,
      credentialsById,
      defaultRunCredential,
      selectedNodeIds: workspace.getSelectedNodeIds?.() || [],
    });
    const proposalWorkspace = {
      getCanvasState: workspace.getCanvasState,
      extractInputFields: workspace.extractInputFields,
      applyCanvasState: workspace.applyCanvasState,
      getContentLocks: workspace.getContentLocks,
      credentialsById,
    };
    const runWorkspace = {
      ...workspace,
      credentialsById,
      inspectNode,
    };
    return {
      getCanvasState: workspace.getCanvasState,
      inspectNode,
      getScoreComparisonRows: workspace.getScoreComparisonRows,
      buildSummary,
      getDatasetBindings: workspace.getDatasetBindings,
      previewProposal: (proposal) => previewProposal(proposal, proposalWorkspace),
      applyProposal: (proposal, options) => applyProposal(proposal, proposalWorkspace, options),
      previewRunRequest: (request) => previewRunRequest(request, runWorkspace),
      executeRunRequest: (request, options) => executeRunRequest(request, runWorkspace, options),
    };
  }

  async function refreshConversationTitle(conversation) {
    if (!conversation?.id || !credentialId) return;
    const fullMessages = ensureConversationMessages(conversation);
    if (!shouldRefreshGeneratedTitle(fullMessages)) return;
    const sourceMessages = getTitleSummarySourceMessages(fullMessages);
    const requestId = (titleRequestSerialByConversation.get(conversation.id) || 0) + 1;
    titleRequestSerialByConversation.set(conversation.id, requestId);
    try {
      const content = await requestTitle(credentialId, buildTitleSummaryPrompt(sourceMessages));
      if (!content || titleRequestSerialByConversation.get(conversation.id) !== requestId) return;
      const fallbackText = sourceMessages.find((m) => m.role === 'user')?.content || conversation.title;
      conversation.title = normalizeGeneratedTitle(content, fallbackText);
      conversation.generatedTitle = true;
      conversation.updatedAt = Date.now();
      notifyConversationUpdated(conversation);
    } catch (error) {
      console.error('Generate conversation title:', error);
    } finally {
      if (titleRequestSerialByConversation.get(conversation.id) === requestId) {
        titleRequestSerialByConversation.delete(conversation.id);
      }
    }
  }

  /**
   * Run the agent until it answers or waits for the user. On Stop, the conversation is rolled back
   * to `turn.baseline` messages and `restoreText` goes back into the composer. `prelude` runs first
   * (applying a proposal) and may raise turn.baseline once its result must survive a Stop.
   */
  async function runTurn(conversation, { baseline, restoreText = '', prelude = null }) {
    const turn = { baseline };
    const messages = ensureConversationMessages(conversation);
    sendInFlight = true;
    activeAssistantAbortController = new AbortController();
    const { signal } = activeAssistantAbortController;
    conversation.pending = true;
    conversation.pendingStatus = 'Reading the workspace...';
    conversation.streamingText = '';
    conversation.updatedAt = Date.now();
    notifyConversationUpdated(conversation);
    if (isActive(conversation)) renderActiveConversation();
    updateComposerState();

    let answered = false;
    try {
      const runtime = await buildToolRuntime();
      if (prelude) {
        await prelude({
          runtime,
          signal,
          turn,
          setStatus: (status) => {
            conversation.pendingStatus = status;
            scheduleRender(conversation);
          },
        });
        conversation.pendingStatus = 'Reading the workspace...';
      }
      const workspaceSummary = await runtime.buildSummary();
      const outcome = await runAgentLoop({
        messages,
        credentialId,
        runtime,
        workspaceSummary,
        contextSummary: conversation.contextSummary || null,
        onSummary: (summary) => {
          conversation.contextSummary = summary;
          conversation.updatedAt = Date.now();
          notifyConversationUpdated(conversation);
        },
        signal,
        onProgress: ({ status, text }) => {
          if (status != null && status !== conversation.pendingStatus) {
            conversation.pendingStatus = status;
          }
          if (text != null) conversation.streamingText = text;
          scheduleRender(conversation);
        },
        onMessage: () => {
          conversation.streamingText = '';
          conversation.updatedAt = Date.now();
          notifyConversationUpdated(conversation);
        },
      });
      answered = outcome === 'answered';
    } catch (error) {
      if (signal.aborted || error?.name === 'AbortError') {
        messages.splice(turn.baseline);
        if ((conversation.contextSummary?.covered || 0) > messages.length) delete conversation.contextSummary;
        conversation.unsentDraft = restoreText;
        notifyConversationDraftChanged(conversation);
        if (isActive(conversation) && restoreText) {
          inputEl.value = restoreText;
          if (typeof autoResizeComposer === 'function') autoResizeComposer();
        }
        if (messages.length === 0) {
          conversation.title = 'New Agent';
          conversation.generatedTitle = true;
        }
      } else {
        console.error('Agent turn:', error);
        messages.push({ role: 'assistant', content: `Error: ${error instanceof Error ? error.message : 'Request failed'}` });
      }
    } finally {
      conversation.pending = false;
      conversation.pendingStatus = '';
      conversation.streamingText = '';
      conversation.updatedAt = Date.now();
      sendInFlight = false;
      activeAssistantAbortController = null;
      notifyConversationUpdated(conversation);
      if (isActive(conversation)) renderActiveConversation();
      if (isMounted()) updateComposerState();
    }
    if (answered) void refreshConversationTitle(conversation);
  }

  async function submitAnswer(answer, restoreText = '') {
    const conversation = getActiveConversation();
    const text = String(answer || '').trim();
    if (!conversation || !text || !credentialId || sendInFlight) return;
    const messages = ensureConversationMessages(conversation);
    const question = findPendingInteraction(messages);
    if (question?.kind !== 'question') return;
    const baseline = messages.length;
    answerQuestion(messages, question, text);
    // The model may have asked several things at once; collect every response before continuing.
    if (findPendingInteraction(messages)) {
      conversation.updatedAt = Date.now();
      notifyConversationUpdated(conversation);
      renderActiveConversation();
      updateComposerState();
      return;
    }
    await runTurn(conversation, { baseline, restoreText });
  }

  /** Apply the open proposal, or reject it (optionally with the user's feedback), then continue. */
  async function submitProposalDecision({ apply, feedback = '' }, restoreText = '') {
    const conversation = getActiveConversation();
    if (!conversation || !credentialId || sendInFlight) return;
    const messages = ensureConversationMessages(conversation);
    const proposal = findPendingInteraction(messages);
    if (proposal?.kind !== 'proposal') return;
    const baseline = messages.length;
    if (!apply) {
      resolveProposal(messages, proposal, { status: 'rejected', ...(feedback ? { feedback } : {}) });
      if (findPendingInteraction(messages)) {
        conversation.updatedAt = Date.now();
        notifyConversationUpdated(conversation);
        renderActiveConversation();
        updateComposerState();
        return;
      }
      await runTurn(conversation, { baseline, restoreText });
      return;
    }
    await runTurn(conversation, {
      baseline,
      prelude: async ({ runtime, signal, turn, setStatus }) => {
        setStatus('Applying the proposal...');
        let result;
        try {
          result = await runtime.applyProposal(proposal.request, { signal, onStatus: setStatus });
        } catch (error) {
          if (signal.aborted || error?.name === 'AbortError') throw error;
          result = { status: 'failed', error: error instanceof Error ? error.message : String(error) };
        }
        resolveProposal(messages, proposal, result);
        // The canvas has changed (or the failure is recorded); a Stop from here on keeps it.
        turn.baseline = messages.length;
        conversation.updatedAt = Date.now();
        notifyConversationUpdated(conversation);
      },
    });
  }

  /**
   * Start the open run request, or cancel it (optionally with the user's feedback), then continue.
   * A Stop while it runs stops the jobs; what finished is recorded and the turn ends there.
   */
  async function submitRunDecision({ run, feedback = '' }, restoreText = '') {
    const conversation = getActiveConversation();
    if (!conversation || !credentialId || sendInFlight) return;
    const messages = ensureConversationMessages(conversation);
    const request = findPendingInteraction(messages);
    if (request?.kind !== 'run') return;
    const baseline = messages.length;
    if (!run) {
      resolveRunRequest(messages, request, { status: 'cancelled', ...(feedback ? { feedback } : {}) });
      if (findPendingInteraction(messages)) {
        conversation.updatedAt = Date.now();
        notifyConversationUpdated(conversation);
        renderActiveConversation();
        updateComposerState();
        return;
      }
      await runTurn(conversation, { baseline, restoreText });
      return;
    }
    await runTurn(conversation, {
      baseline,
      prelude: async ({ runtime, signal, turn, setStatus }) => {
        setStatus('Starting...');
        let result;
        try {
          result = await runtime.executeRunRequest(request.request, { signal, onStatus: setStatus });
        } catch (error) {
          result = { status: 'failed', error: error instanceof Error ? error.message : String(error), results: [] };
        }
        resolveRunRequest(messages, request, result);
        // Jobs have run (or were stopped); a Stop from here on keeps that record.
        turn.baseline = messages.length;
        conversation.updatedAt = Date.now();
        notifyConversationUpdated(conversation);
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      },
    });
  }

  async function submitEditedMessage() {
    const text = String(editingDraft || '').trim();
    const conversation = getActiveConversation();
    if (!text || !credentialId || sendInFlight || !conversation || editingMessageIndex === -1) return;
    const messages = ensureConversationMessages(conversation);
    const messageIndex = editingMessageIndex;
    const targetMessage = messages[messageIndex];
    if (!targetMessage || targetMessage.role !== 'user') return;
    editingMessageIndex = -1;
    editingDraft = '';
    targetMessage.content = text;
    messages.splice(messageIndex + 1);
    // A summary that covers the edited message describes a conversation that no longer exists.
    if ((conversation.contextSummary?.covered || 0) > messageIndex) delete conversation.contextSummary;
    if (messageIndex === 0) {
      conversation.title = deriveConversationTitle(text);
      conversation.generatedTitle = true;
    }
    await runTurn(conversation, { baseline: messageIndex + 1, restoreText: '' });
  }

  async function sendMessage() {
    const text = String(inputEl.value || '').trim();
    const conversation = getActiveConversation();
    if (!text || !credentialId || sendInFlight || !conversation || editingMessageIndex !== -1) return;
    const messages = ensureConversationMessages(conversation);
    conversation.unsentDraft = '';
    notifyConversationDraftChanged(conversation);
    inputEl.value = '';
    if (typeof autoResizeComposer === 'function') autoResizeComposer();

    // A typed reply to an open question is its answer; to an open proposal, a request for changes.
    const pending = findPendingInteraction(messages);
    if (pending?.kind === 'question') {
      await submitAnswer(text, text);
      return;
    }
    if (pending?.kind === 'proposal') {
      await submitProposalDecision({ apply: false, feedback: text }, text);
      return;
    }
    if (pending?.kind === 'run') {
      await submitRunDecision({ run: false, feedback: text }, text);
      return;
    }
    if (messages.length === 0) {
      conversation.title = deriveConversationTitle(text);
      conversation.generatedTitle = true;
    }
    const baseline = messages.length;
    messages.push({ role: 'user', content: text });
    await runTurn(conversation, { baseline, restoreText: text });
  }

  async function initializeCredential() {
    try {
      const credential = await loadAgentCredential();
      if (!isMounted()) return;
      credentialId = credential ? String(credential.id || '').trim() : '';
      credentialWarning = credential?.agent_check_ok === false
        ? `${credential.model} cannot call tools, so the Agent will not work well with it. Choose another model in Settings → Agent defaults.`
        : '';
    } catch (error) {
      credentialId = '';
      console.error('Load Agent model:', error);
    }
    updateComposerState();
  }

  function handleInput() {
    const conversation = getActiveConversation();
    if (conversation) {
      conversation.unsentDraft = String(inputEl.value || '');
      notifyConversationDraftChanged(conversation);
    }
    if (typeof autoResizeComposer === 'function') autoResizeComposer();
    updateComposerState();
  }

  function handleKeyDown(event) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendMessage();
    }
  }

  function handleSendClick() {
    sendMessage();
  }

  function setConversation(conversation) {
    activeConversationId = String(conversation?.id || '').trim();
    editingMessageIndex = -1;
    editingDraft = '';
    syncComposerDraftFromConversation();
    renderActiveConversation();
    updateComposerState();
  }

  messagesEl.innerHTML = '';
  inputEl.addEventListener('input', handleInput);
  inputEl.addEventListener('keydown', handleKeyDown);
  sendButtonEl.addEventListener('click', handleSendClick);
  document.addEventListener('pointerdown', handleOutsidePointerDown);
  updateComposerState();
  initializeCredential();

  return {
    setConversation,
    stopAssistant,
    destroy() {
      // Do not abort in-flight agent requests: closing the window lets the turn finish and save.
      // Abort is only for an explicit stopAssistant().
      inputEl.removeEventListener('input', handleInput);
      inputEl.removeEventListener('keydown', handleKeyDown);
      sendButtonEl.removeEventListener('click', handleSendClick);
      document.removeEventListener('pointerdown', handleOutsidePointerDown);
    },
  };
}
