import { AGENT_TITLE_MAX_CHARS, clampAgentTitle } from './agentTitleLimits.js';
import { BACKEND_API_BASE } from './backendConfig.js';
import { requestAgentChat, requestAgentPlan, requestSimpleChat } from './agent/api/agentChatClient.js';
import { AGENT_SKILL_REGISTRY, getAgentSkillByName } from './agent/skills/registry.js';
const API_BASE = BACKEND_API_BASE;
const CHAT_MAX_MESSAGES = 40;
const TITLE_SUMMARY_MAX_ROUNDS = 3;
const AGENT_SKILL_NAMES = new Set(
  AGENT_SKILL_REGISTRY.map((skill) => String(skill?.name || '').trim()).filter(Boolean)
);
const AGENT_LOOP_MAX_RUNTIME_MS = 7 * 60 * 1000;
const AGENT_LOOP_REPEAT_WARNING_THRESHOLD = 2;
const AGENT_LOOP_REPEAT_CRITICAL_THRESHOLD = 3;
const AGENT_LOOP_STALL_WARNING_THRESHOLD = 2;
const AGENT_LOOP_STALL_CRITICAL_THRESHOLD = 3;
const AGENT_RUN_WAIT_HEARTBEAT_MS = 2000;
const AGENT_RUN_WAIT_MAX_MS = 10 * 60 * 1000;
const AGENT_RUN_WAIT_STALL_WARNING_MS = 60 * 1000;
const AGENT_SINGLE_EXECUTION_SKILLS = new Set([
  'create_prompt_node',
  'add_prompt_version',
  'create_run_node',
  'create_score_node',
  'create_sampler_node',
  'create_sampled_dataset_node',
  'create_synthetic_dataset_node',
  'create_and_run_review_node',
  'apply_review_suggestions',
]);

function sliceChatHistoryForApi(messages) {
  if (!Array.isArray(messages) || messages.length <= CHAT_MAX_MESSAGES) {
    return Array.isArray(messages) ? messages.slice() : [];
  }
  let sliced = messages.slice(-CHAT_MAX_MESSAGES);
  while (sliced.length > 1 && sliced[0].role !== 'user') {
    sliced = sliced.slice(1);
  }
  return sliced;
}

function deriveConversationTitle(text) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return 'New Agent';
  return clampAgentTitle(normalized);
}

function getTitleSummarySourceMessages(messages) {
  const source = [];
  let assistantRounds = 0;
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || (message.role !== 'user' && message.role !== 'assistant')) continue;
    source.push({
      role: message.role,
      content: String(message.content || '').trim(),
    });
    if (message.role === 'assistant') {
      assistantRounds += 1;
      if (assistantRounds >= TITLE_SUMMARY_MAX_ROUNDS) break;
    }
  }
  return source.filter((message) => message.content);
}

function shouldRefreshGeneratedTitle(messages) {
  const assistantRounds = (Array.isArray(messages) ? messages : []).filter(
    (message) => message?.role === 'assistant' && String(message.content || '').trim()
  ).length;
  return assistantRounds >= 1 && assistantRounds <= TITLE_SUMMARY_MAX_ROUNDS;
}

function buildTitleSummaryPrompt(messages) {
  const transcript = (Array.isArray(messages) ? messages : [])
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

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, ms | 0));
  });
}

function getSendIconSvg() {
  return `
    <svg class="agent-window__button-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 13.5a.75.75 0 0 1-.75-.75V5.56L4.78 8.03a.75.75 0 1 1-1.06-1.06l3.75-3.75a.75.75 0 0 1 1.06 0l3.75 3.75a.75.75 0 0 1-1.06 1.06L8.75 5.56v7.19a.75.75 0 0 1-.75.75Z"></path>
    </svg>
  `;
}

function createMessageNode(role, content, options = {}) {
  const { loading = false, loadingText = 'Thinking...', editable = false, actionDisabled = false, onEdit = null } = options;
  const wrapper = document.createElement('div');
  wrapper.className = `agent-window__message agent-window__message--${role}`;
  if (loading) wrapper.classList.add('agent-window__message--loading');

  const roleEl = document.createElement('div');
  roleEl.className = 'agent-window__message-role';
  roleEl.textContent = role === 'assistant' ? 'Assistant' : 'You';

  const bubbleEl = document.createElement('div');
  bubbleEl.className = 'agent-window__message-bubble';

  if (loading) {
    bubbleEl.innerHTML = `
      <span class="agent-window__spinner" aria-hidden="true"></span>
      <span class="agent-window__loading-text">${String(loadingText || 'Thinking...')}</span>
    `;
  } else {
    const contentEl = document.createElement('div');
    contentEl.className = 'agent-window__message-content';
    contentEl.textContent = content;
    bubbleEl.appendChild(contentEl);
  }

  wrapper.appendChild(roleEl);
  if (editable && typeof onEdit === 'function') {
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
  wrapper.appendChild(bubbleEl);
  return wrapper;
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

async function loadReviewCredential() {
  const [credentials, settings] = await Promise.all([
    fetch(`${API_BASE}/api/credentials`).then((res) => (res.ok ? res.json() : [])),
    fetch(`${API_BASE}/api/settings`).then((res) => (res.ok ? res.json() : null)),
  ]);
  const reviewId = String(settings?.default_review_credential_id || '').trim();
  const credential = Array.isArray(credentials)
    ? credentials.find((item) => item && item.id === reviewId)
    : null;
  return credential || null;
}

export function mountAgentChatSession({
  overlay,
  messagesEl,
  inputEl,
  sendButtonEl,
  autoResizeComposer,
  onConversationUpdated,
  onConversationDraftChanged,
  resolveConversation,
  getWorkflowSnapshot,
  inspectNode,
  addRunNode,
  addScoreNode,
  createAndRunReviewNode,
  verifyReviewSuggestions,
  acceptReviewSuggestions,
  applyReviewSuggestions,
  startRunNode,
  saveRunResultsToWorkspace,
  saveScoreResultsToWorkspace,
  addSamplerNode,
  addSampledDatasetNode,
  addPromptNode,
  addPromptVersion,
  addDatasetNode,
}) {
  if (!overlay || !messagesEl || !inputEl || !sendButtonEl) {
    return {
      setConversation() {},
      destroy() {},
    };
  }

  let credentialId = '';
  let sendInFlight = false;
  let activeConversationId = '';
  let editingMessageIndex = -1;
  let editingDraft = '';
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

  function setPendingStatus(conversation, status) {
    if (!conversation) return;
    conversation.pendingStatus = String(status || '').trim();
    conversation.updatedAt = Date.now();
    notifyConversationUpdated(conversation);
    if (isMounted() && activeConversationId === conversation.id) renderActiveConversation();
  }

  function renderActiveConversation() {
    const activeConversation = getActiveConversation();
    messagesEl.innerHTML = '';
    const messages = ensureConversationMessages(activeConversation);
    messages.forEach((message, index) => {
      if (message.role === 'user' && index === editingMessageIndex) {
        appendEditingMessage(editingDraft, {
          saveDisabled: !String(editingDraft || '').trim() || activeConversation?.pending || sendInFlight,
          onInput: (value) => {
            editingDraft = value;
          },
          onSave: () => {
            submitEditedMessage();
          },
          onCancel: () => {
            cancelEditingMessage();
          },
        });
        return;
      }
      appendMessage(message.role, message.content, {
        editable: message.role === 'user',
        actionDisabled: activeConversation?.pending || sendInFlight || editingMessageIndex !== -1,
        onEdit: () => startEditingMessage(index),
      });
    });
    if (activeConversation?.pending) {
      appendMessage('assistant', '', {
        loading: true,
        loadingText: String(activeConversation?.pendingStatus || 'Thinking...'),
      });
    }
  }

  function updateComposerState() {
    const activeConversation = getActiveConversation();
    const hasText = Boolean((inputEl.value || '').trim());
    const composerLocked = sendInFlight || editingMessageIndex !== -1;
    inputEl.disabled = !credentialId || composerLocked || !activeConversation;
    sendButtonEl.disabled = !credentialId || composerLocked || !activeConversation || !hasText;
    inputEl.placeholder = editingMessageIndex !== -1
      ? 'Finish editing this message first'
      : !activeConversation
      ? 'Select a chat first'
      : credentialId
        ? (sendInFlight ? 'Waiting for response...' : 'Send a message...')
        : 'Select a Review model in Settings first';
  }

  function syncComposerDraftFromConversation() {
    const activeConversation = getActiveConversation();
    inputEl.value = String(activeConversation?.unsentDraft || '');
    if (typeof autoResizeComposer === 'function') autoResizeComposer();
  }

  function appendMessage(role, content, options = {}) {
    const node = createMessageNode(role, content, options);
    messagesEl.appendChild(node);
    scrollToBottom();
    return node;
  }

  function appendEditingMessage(content, options = {}) {
    const node = createEditingMessageNode(content, options);
    messagesEl.appendChild(node);
    scrollToBottom();
    return node;
  }

  function startEditingMessage(messageIndex) {
    const activeConversation = getActiveConversation();
    if (!activeConversation || sendInFlight || activeConversation.pending) return;
    const messages = ensureConversationMessages(activeConversation);
    const targetMessage = messages[messageIndex];
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
    if (!editingNode) return;
    if (editingNode.contains(event.target)) return;
    cancelEditingMessage();
  }

  function readWorkflowSnapshot() {
    if (typeof getWorkflowSnapshot !== 'function') return null;
    try {
      const snapshot = getWorkflowSnapshot();
      return snapshot && typeof snapshot === 'object' ? snapshot : null;
    } catch (error) {
      console.error('Read workflow snapshot:', error);
      return null;
    }
  }

  function stableStringify(value) {
    if (Array.isArray(value)) {
      return `[${value.map((item) => stableStringify(item)).join(',')}]`;
    }
    if (value && typeof value === 'object') {
      const entries = Object.keys(value)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
      return `{${entries.join(',')}}`;
    }
    return JSON.stringify(value);
  }

  function normalizeSkillArgs(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

function normalizePositiveInteger(value, fallback = null) {
  const normalized = Number.parseInt(value, 10);
  if (!Number.isFinite(normalized) || normalized < 1) return fallback;
  return normalized;
}

function findNodeInSnapshot(workflowSnapshot, nodeId) {
  const normalizedNodeId = String(nodeId || '').trim();
  if (!normalizedNodeId) return null;
  return Array.isArray(workflowSnapshot?.nodes)
    ? workflowSnapshot.nodes.find((node) => String(node?.id || '').trim() === normalizedNodeId) || null
    : null;
}

  function addLoopSignal(loopSignals, signal) {
    const normalizedSignal = String(signal || '').trim();
    if (!normalizedSignal) return;
    if (!loopSignals.includes(normalizedSignal)) loopSignals.push(normalizedSignal);
  }

  function buildSkillCallFingerprint(skillCall) {
    return `${String(skillCall?.skillName || '').trim()}:${stableStringify(normalizeSkillArgs(skillCall?.args))}`;
  }

  function buildObservationFingerprint(observation) {
    return `${String(observation?.skillName || '').trim()}:${stableStringify(normalizeSkillArgs(observation?.args))}:${stableStringify(observation?.result ?? null)}`;
  }

function shouldPreventRepeatedExecution(skillName) {
  return AGENT_SINGLE_EXECUTION_SKILLS.has(String(skillName || '').trim());
}

  function buildObservationSummary(skill, skillCall, result, workflowSnapshot) {
    if (skill && typeof skill.summarizeResult === 'function') {
      return String(
        skill.summarizeResult({
          args: normalizeSkillArgs(skillCall?.args),
          result,
          runtime: {
            inspectNode,
            addRunNode,
            addScoreNode,
            createAndRunReviewNode,
            startRunNode,
            saveRunResultsToWorkspace,
            saveScoreResultsToWorkspace,
            addSamplerNode,
            addSampledDatasetNode,
            addPromptNode,
            addDatasetNode,
            workflowSnapshot,
          },
        }) || ''
      ).trim();
    }
    return result && typeof result === 'object'
      ? `Executed ${String(skillCall?.skillName || 'skill').trim()} successfully`
      : `Executed ${String(skillCall?.skillName || 'skill').trim()} with no result`;
  }

  function getSkillProgressLabel(skill, skillCall, workflowSnapshot) {
    if (skill && typeof skill.getProgressLabel === 'function') {
      return String(
        skill.getProgressLabel({
          args: normalizeSkillArgs(skillCall?.args),
          runtime: {
            inspectNode,
            addRunNode,
            addScoreNode,
            createAndRunReviewNode,
            startRunNode,
            saveRunResultsToWorkspace,
            saveScoreResultsToWorkspace,
            addSamplerNode,
            addSampledDatasetNode,
            addPromptNode,
            addDatasetNode,
            workflowSnapshot,
          },
        }) || ''
      ).trim();
    }
    return `Running ${String(skillCall?.skillName || 'skill').trim()}...`;
  }

  async function executeSkillCall(skillCall, workflowSnapshot) {
    const skillName = String(skillCall?.skillName || '').trim();
    const args = normalizeSkillArgs(skillCall?.args);
    const skill = getAgentSkillByName(skillName);
    if (!skill || typeof skill.execute !== 'function') {
      return {
        skillName,
        args,
        ok: false,
        summary: `Skill ${skillName || 'unknown'} is unavailable`,
        result: null,
      };
    }
    try {
      const result = await skill.execute({
        args,
        runtime: {
          inspectNode,
          addRunNode,
          addScoreNode,
          createAndRunReviewNode,
          verifyReviewSuggestions,
          acceptReviewSuggestions,
          applyReviewSuggestions,
          startRunNode,
          saveRunResultsToWorkspace,
          saveScoreResultsToWorkspace,
          addSamplerNode,
          addSampledDatasetNode,
          addPromptNode,
          addPromptVersion,
          addDatasetNode,
          workflowSnapshot,
        },
      });
      return {
        skillName,
        args,
        ok: result !== null && result !== undefined,
        summary: buildObservationSummary(skill, skillCall, result, workflowSnapshot),
        result,
      };
    } catch (error) {
      console.error(`Execute agent skill ${skillName}:`, error);
      return {
        skillName,
        args,
        ok: false,
        summary: `Skill ${skillName || 'unknown'} failed: ${error instanceof Error ? error.message : 'unknown error'}`,
        result: null,
      };
    }
  }

  async function waitForRunCompletion(waitState, workflowSnapshot, loopSignals, agentTrace, onProgress) {
    const startedAt = waitState?.startedAt || Date.now();
    let lastProgress = Number(waitState?.lastObservedProgress) || 0;
    let lastResultsCount = Number(waitState?.lastObservedResultsCount) || 0;
    let lastProgressAt = waitState?.lastProgressAt || startedAt;
    let warnedForStall = false;

    while (true) {
      const latestSnapshot = readWorkflowSnapshot();
      if (latestSnapshot) workflowSnapshot = latestSnapshot;
      const runNode = findNodeInSnapshot(workflowSnapshot, waitState?.runNodeId);
      if (!runNode || String(runNode?.type || '').trim() !== 'run') {
        return {
          workflowSnapshot,
          observation: {
            skillName: 'wait_for_run_completion',
            args: { run_node_id: waitState?.runNodeId || '' },
            ok: false,
            summary: `Run node ${String(waitState?.runNodeId || '').trim() || 'unknown'} was not found while waiting.`,
            result: {
              runNodeId: String(waitState?.runNodeId || '').trim(),
              status: 'missing',
            },
          },
          shouldBreak: true,
        };
      }

      const runName = String(runNode?.title || waitState?.runNodeId || 'run').trim() || 'run';
      const pending = runNode?.status?.pending === true;
      const progress = Number(runNode?.status?.progress) || 0;
      const resultsCount = Number(runNode?.status?.resultsCount) || 0;
      const completed = runNode?.status?.completed === true;

      if (progress > lastProgress || resultsCount > lastResultsCount) {
        lastProgress = progress;
        lastResultsCount = resultsCount;
        lastProgressAt = Date.now();
        warnedForStall = false;
      }

      if (completed) {
        return {
          workflowSnapshot,
          observation: {
            skillName: 'wait_for_run_completion',
            args: { run_node_id: waitState?.runNodeId || '' },
            ok: true,
            summary: `Run ${runName} completed.`,
            result: {
              runNodeId: String(waitState?.runNodeId || '').trim(),
              status: 'completed',
              progress,
              resultsCount,
            },
          },
          shouldBreak: false,
        };
      }

      if (!pending) {
        const stoppedMessage = `Run ${runName} stopped before completion.`;
        addLoopSignal(loopSignals, stoppedMessage);
        agentTrace.push(`WAIT STOP: ${stoppedMessage}`);
        return {
          workflowSnapshot,
          observation: {
            skillName: 'wait_for_run_completion',
            args: { run_node_id: waitState?.runNodeId || '' },
            ok: false,
            summary: stoppedMessage,
            result: {
              runNodeId: String(waitState?.runNodeId || '').trim(),
              status: 'stopped',
              progress,
              resultsCount,
            },
          },
          shouldBreak: true,
        };
      }

      const waitElapsedMs = Date.now() - startedAt;
      const stalledForMs = Date.now() - lastProgressAt;
      if (waitElapsedMs >= AGENT_RUN_WAIT_MAX_MS) {
        const timeoutMessage = `Timed out waiting for run ${runName} after ${Math.round(AGENT_RUN_WAIT_MAX_MS / 1000)} seconds.`;
        addLoopSignal(loopSignals, timeoutMessage);
        agentTrace.push(`WAIT STOP: ${timeoutMessage}`);
        return {
          workflowSnapshot,
          observation: {
            skillName: 'wait_for_run_completion',
            args: { run_node_id: waitState?.runNodeId || '' },
            ok: false,
            summary: timeoutMessage,
            result: {
              runNodeId: String(waitState?.runNodeId || '').trim(),
              status: 'timeout',
              progress,
              resultsCount,
            },
          },
          shouldBreak: true,
        };
      }

      if (!warnedForStall && stalledForMs >= AGENT_RUN_WAIT_STALL_WARNING_MS) {
        const stallMessage = `Run ${runName} has shown no new progress for ${Math.round(stalledForMs / 1000)} seconds.`;
        addLoopSignal(loopSignals, stallMessage);
        agentTrace.push(`WAIT WARN: ${stallMessage}`);
        warnedForStall = true;
      }

      if (onProgress) {
        onProgress(progress > 0
          ? `Waiting for run ${runName} to finish (${progress}%)...`
          : `Waiting for run ${runName} to finish...`);
      }
      await sleep(AGENT_RUN_WAIT_HEARTBEAT_MS);
    }
  }

  async function waitForReviewCompletion(waitState, workflowSnapshot, loopSignals, agentTrace, onProgress) {
    const startedAt = waitState?.startedAt || Date.now();
    let lastProgress = Number(waitState?.lastObservedProgress) || 0;
    let lastSuggestionCount = Number(waitState?.lastObservedSuggestionCount) || 0;
    let lastProgressAt = waitState?.lastProgressAt || startedAt;
    let warnedForStall = false;

    while (true) {
      const latestSnapshot = readWorkflowSnapshot();
      if (latestSnapshot) workflowSnapshot = latestSnapshot;
      const reviewNode = findNodeInSnapshot(workflowSnapshot, waitState?.reviewNodeId);
      if (!reviewNode || String(reviewNode?.type || '').trim() !== 'promptReview') {
        return {
          workflowSnapshot,
          observation: {
            skillName: 'wait_for_review_completion',
            args: { review_node_id: waitState?.reviewNodeId || '' },
            ok: false,
            summary: `Review node ${String(waitState?.reviewNodeId || '').trim() || 'unknown'} was not found while waiting.`,
            result: {
              reviewNodeId: String(waitState?.reviewNodeId || '').trim(),
              status: 'missing',
            },
          },
          shouldBreak: true,
        };
      }

      const reviewName = String(reviewNode?.title || waitState?.reviewNodeId || 'review').trim() || 'review';
      const pending = reviewNode?.status?.pending === true;
      const progress = Number(reviewNode?.status?.progress) || 0;
      const suggestionCount = Number(reviewNode?.preview?.reviewSuggestionCount) || 0;
      const reviewSummary = String(reviewNode?.preview?.reviewSummary || '').trim();
      const completed = !pending && (suggestionCount > 0 || Boolean(reviewSummary));

      if (progress > lastProgress || suggestionCount > lastSuggestionCount) {
        lastProgress = progress;
        lastSuggestionCount = suggestionCount;
        lastProgressAt = Date.now();
        warnedForStall = false;
      }

      if (completed) {
        return {
          workflowSnapshot,
          observation: {
            skillName: 'wait_for_review_completion',
            args: { review_node_id: waitState?.reviewNodeId || '' },
            ok: true,
            summary: `Review ${reviewName} completed.`,
            result: {
              reviewNodeId: String(waitState?.reviewNodeId || '').trim(),
              status: 'completed',
              progress,
              suggestionCount,
              reviewSummary,
            },
          },
          shouldBreak: false,
        };
      }

      if (!pending) {
        const stoppedMessage = `Review ${reviewName} stopped before completion.`;
        addLoopSignal(loopSignals, stoppedMessage);
        agentTrace.push(`WAIT STOP: ${stoppedMessage}`);
        return {
          workflowSnapshot,
          observation: {
            skillName: 'wait_for_review_completion',
            args: { review_node_id: waitState?.reviewNodeId || '' },
            ok: false,
            summary: stoppedMessage,
            result: {
              reviewNodeId: String(waitState?.reviewNodeId || '').trim(),
              status: 'stopped',
              progress,
              suggestionCount,
              reviewSummary,
            },
          },
          shouldBreak: true,
        };
      }

      const waitElapsedMs = Date.now() - startedAt;
      const stalledForMs = Date.now() - lastProgressAt;
      if (waitElapsedMs >= AGENT_RUN_WAIT_MAX_MS) {
        const timeoutMessage = `Timed out waiting for review ${reviewName} after ${Math.round(AGENT_RUN_WAIT_MAX_MS / 1000)} seconds.`;
        addLoopSignal(loopSignals, timeoutMessage);
        agentTrace.push(`WAIT STOP: ${timeoutMessage}`);
        return {
          workflowSnapshot,
          observation: {
            skillName: 'wait_for_review_completion',
            args: { review_node_id: waitState?.reviewNodeId || '' },
            ok: false,
            summary: timeoutMessage,
            result: {
              reviewNodeId: String(waitState?.reviewNodeId || '').trim(),
              status: 'timeout',
              progress,
              suggestionCount,
              reviewSummary,
            },
          },
          shouldBreak: true,
        };
      }

      if (!warnedForStall && stalledForMs >= AGENT_RUN_WAIT_STALL_WARNING_MS) {
        const stallMessage = `Review ${reviewName} has shown no new progress for ${Math.round(stalledForMs / 1000)} seconds.`;
        addLoopSignal(loopSignals, stallMessage);
        agentTrace.push(`WAIT WARN: ${stallMessage}`);
        warnedForStall = true;
      }

      if (onProgress) {
        onProgress(progress > 0
          ? `Waiting for review ${reviewName} to finish (${progress}%)...`
          : `Waiting for review ${reviewName} to finish...`);
      }
      await sleep(AGENT_RUN_WAIT_HEARTBEAT_MS);
    }
  }

  function normalizePlannedSkillCalls(plan) {
    const calls = Array.isArray(plan?.skill_calls) ? plan.skill_calls : [];
    const seen = new Set();
    return calls
      .map((call) => {
        const args = normalizeSkillArgs(call?.args);
        return {
          skillName: String(call?.skill_name || '').trim(),
          args,
          reason: String(call?.reason || '').trim(),
        };
      })
      .filter((call) => AGENT_SKILL_NAMES.has(call.skillName))
      .filter((call) => {
        const fingerprint = buildSkillCallFingerprint(call);
        if (seen.has(fingerprint)) return false;
        seen.add(fingerprint);
        return true;
      });
  }

  function normalizePlannerPayload(plan) {
    return {
      done: plan?.done === true,
      planSummary: String(plan?.plan_summary || '').trim(),
      expectedProgress: String(plan?.expected_progress || '').trim(),
      skillCalls: normalizePlannedSkillCalls(plan),
    };
  }

  async function planAgentSkills(messages, workflowSnapshot, observations, loopSignals, roundIndex) {
    if (!workflowSnapshot) {
      return {
        ok: true,
        plan: {
          done: true,
          planSummary: 'No workflow snapshot available',
          expectedProgress: '',
          skillCalls: [],
        },
      };
    }
    const { ok, plan } = await requestAgentPlan({
      credentialId,
      messages,
      workflowSnapshot,
      observations,
      availableSkills: AGENT_SKILL_REGISTRY,
      loopSignals,
      roundIndex,
    });
    return {
      ok,
      plan: normalizePlannerPayload(plan),
    };
  }

  async function requestChatCompletion(messages, options = {}) {
    const useWorkflowContext = options.useWorkflowContext === true;
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
    if (useWorkflowContext) {
      const agentTrace = [`LOOP START: evaluating ${AGENT_SKILL_REGISTRY.length} available skills`];
      let workflowSnapshot = readWorkflowSnapshot();
      if (!workflowSnapshot) {
        return requestSimpleChat({ credentialId, messages });
      }
      const observations = [];
      const loopSignals = [];
      const seenObservationFingerprints = new Set();
      const callCountsByFingerprint = new Map();
      const sampledDatasetCreateCountsBySampler = new Map();
      const loopStartedAt = Date.now();
      let stalledCount = 0;
      let roundIndex = 0;
      let waitingState = null;
      try {
        while (true) {
          roundIndex += 1;
          const elapsedMs = Date.now() - loopStartedAt;
          if (elapsedMs >= AGENT_LOOP_MAX_RUNTIME_MS) {
            addLoopSignal(loopSignals, `Agent loop runtime exceeded ${Math.round(AGENT_LOOP_MAX_RUNTIME_MS / 1000)} seconds.`);
            agentTrace.push(`ROUND ${roundIndex} STOP: runtime watchdog reached after ${elapsedMs}ms`);
            break;
          }

          if (waitingState) {
            const waitResult = waitingState.kind === 'review'
              ? await waitForReviewCompletion(waitingState, workflowSnapshot, loopSignals, agentTrace, onProgress)
              : await waitForRunCompletion(waitingState, workflowSnapshot, loopSignals, agentTrace, onProgress);
            workflowSnapshot = waitResult.workflowSnapshot || workflowSnapshot;
            if (waitResult.observation) {
              observations.push(waitResult.observation);
              const observationFingerprint = buildObservationFingerprint(waitResult.observation);
              seenObservationFingerprints.add(observationFingerprint);
              agentTrace.push(
                `ROUND ${roundIndex} WAIT: ${waitResult.observation.ok ? 'ok' : 'error'} | ${waitResult.observation.summary || 'no summary'}`
              );
            }
            waitingState = null;
            if (waitResult.shouldBreak) break;
            stalledCount = 0;
            if (onProgress) onProgress('Node finished, replanning next steps...');
            continue;
          }

          if (onProgress) onProgress(`Planning round ${roundIndex}...`);
          const { ok, plan } = await planAgentSkills(messages, workflowSnapshot, observations, loopSignals, roundIndex);
          if (!ok) {
            addLoopSignal(loopSignals, 'Planner request failed');
            agentTrace.push(`ROUND ${roundIndex} PLAN ERROR: planner request failed, answering with current evidence`);
            if (onProgress) onProgress('Planning failed, answering with current evidence...');
            break;
          }

          agentTrace.push(
            `ROUND ${roundIndex} PLAN: done=${plan.done} skills=${plan.skillCalls.length}`
            + (plan.planSummary ? ` | summary=${plan.planSummary}` : '')
            + (plan.expectedProgress ? ` | expect=${plan.expectedProgress}` : '')
          );

          if (plan.done) {
            agentTrace.push(`ROUND ${roundIndex} STOP: planner marked evidence sufficient`);
            break;
          }

          if (plan.skillCalls.length === 0) {
            addLoopSignal(loopSignals, 'Planner returned no skill calls and did not mark the task done.');
            agentTrace.push(`ROUND ${roundIndex} STOP: no skill call selected`);
            break;
          }

          let roundMadeProgress = false;
          for (const skillCall of plan.skillCalls) {
            const skill = getAgentSkillByName(skillCall.skillName);
            if (onProgress) onProgress(getSkillProgressLabel(skill, skillCall, workflowSnapshot));

            const callFingerprint = buildSkillCallFingerprint(skillCall);
            const repeatCount = (callCountsByFingerprint.get(callFingerprint) || 0) + 1;
            callCountsByFingerprint.set(callFingerprint, repeatCount);
            if (repeatCount >= AGENT_LOOP_REPEAT_WARNING_THRESHOLD) {
              addLoopSignal(loopSignals, `Repeated skill call detected: ${callFingerprint}`);
            }

            if (repeatCount >= AGENT_LOOP_REPEAT_WARNING_THRESHOLD && shouldPreventRepeatedExecution(skillCall.skillName)) {
              const stopSummary = `Prevented repeated create/apply action in the same request: ${callFingerprint}`;
              addLoopSignal(loopSignals, stopSummary);
              agentTrace.push(`ROUND ${roundIndex} STOP: ${stopSummary}`);
              stalledCount = Math.max(stalledCount, AGENT_LOOP_STALL_CRITICAL_THRESHOLD);
              break;
            }

            if (skillCall.skillName === 'create_sampled_dataset_node') {
              const samplerNodeId = String(
                skillCall.args?.sampler_node_id || skillCall.args?.samplerNodeId || ''
              ).trim();
              const maxSampleUses = normalizePositiveInteger(
                skillCall.args?.max_sample_uses ?? skillCall.args?.maxSampleUses,
                1
              );
              if (samplerNodeId && maxSampleUses != null) {
                const usedCount = sampledDatasetCreateCountsBySampler.get(samplerNodeId) || 0;
                if (usedCount >= maxSampleUses) {
                  const limitSummary = `Agent-side sample limit reached for sampler ${samplerNodeId}: ${usedCount}/${maxSampleUses} in this request.`;
                  addLoopSignal(loopSignals, limitSummary);
                  agentTrace.push(`ROUND ${roundIndex} STOP: ${limitSummary}`);
                  stalledCount = Math.max(stalledCount, AGENT_LOOP_STALL_CRITICAL_THRESHOLD);
                  break;
                }
              }
            }

            const observation = await executeSkillCall(skillCall, workflowSnapshot);
            observations.push(observation);
            if (observation.ok && skillCall.skillName === 'create_sampled_dataset_node') {
              const samplerNodeId = String(
                skillCall.args?.sampler_node_id || skillCall.args?.samplerNodeId || ''
              ).trim();
              if (samplerNodeId) {
                sampledDatasetCreateCountsBySampler.set(
                  samplerNodeId,
                  (sampledDatasetCreateCountsBySampler.get(samplerNodeId) || 0) + 1
                );
              }
            }
            const refreshedSnapshot = readWorkflowSnapshot();
            if (refreshedSnapshot) workflowSnapshot = refreshedSnapshot;
            const observationFingerprint = buildObservationFingerprint(observation);
            const isNewObservation = !seenObservationFingerprints.has(observationFingerprint);
            if (isNewObservation) {
              seenObservationFingerprints.add(observationFingerprint);
              roundMadeProgress = true;
            }

            agentTrace.push(
              `ROUND ${roundIndex} ACT: ${skillCall.skillName}(${stableStringify(skillCall.args)}) -> `
              + `${observation.ok ? 'ok' : 'error'} | ${observation.summary || 'no summary'} | progress=${isNewObservation ? 'yes' : 'no'}`
            );

            if (observation.ok && observation.result?.waitRequired === true && observation.result?.runNodeId) {
              waitingState = {
                kind: 'run',
                runNodeId: String(observation.result.runNodeId || '').trim(),
                runId: String(observation.result.runId || '').trim(),
                startedAt: Date.now(),
                lastObservedProgress: 0,
                lastObservedResultsCount: Number(observation.result?.resultsCount) || 0,
                lastProgressAt: Date.now(),
              };
              agentTrace.push(`ROUND ${roundIndex} WAIT START: run ${waitingState.runNodeId}`);
              break;
            }

            if (observation.ok && observation.result?.waitRequired === true && observation.result?.reviewNodeId) {
              waitingState = {
                kind: 'review',
                reviewNodeId: String(observation.result.reviewNodeId || '').trim(),
                startedAt: Date.now(),
                lastObservedProgress: Number(observation.result?.reviewProgress) || 0,
                lastObservedSuggestionCount: 0,
                lastProgressAt: Date.now(),
              };
              agentTrace.push(`ROUND ${roundIndex} WAIT START: review ${waitingState.reviewNodeId}`);
              break;
            }

            if (!isNewObservation && repeatCount >= AGENT_LOOP_REPEAT_CRITICAL_THRESHOLD) {
              addLoopSignal(loopSignals, `Critical repeated skill call: ${callFingerprint}`);
              agentTrace.push(`ROUND ${roundIndex} STOP: repeated identical observation for ${callFingerprint}`);
              stalledCount = Math.max(stalledCount, AGENT_LOOP_STALL_CRITICAL_THRESHOLD);
              break;
            }
          }

          if (roundMadeProgress) {
            stalledCount = 0;
            if (onProgress) onProgress('Reviewing new observations...');
            agentTrace.push(`ROUND ${roundIndex} OBSERVE: progress detected`);
          } else {
            stalledCount += 1;
            if (stalledCount >= AGENT_LOOP_STALL_WARNING_THRESHOLD) {
              addLoopSignal(loopSignals, `No new information after ${stalledCount} consecutive rounds.`);
            }
            agentTrace.push(`ROUND ${roundIndex} OBSERVE: no new information`);
          }

          if (stalledCount >= AGENT_LOOP_STALL_CRITICAL_THRESHOLD) {
            agentTrace.push(`ROUND ${roundIndex} STOP: stalled with no new information`);
            break;
          }
        }

        const latestNodeInspection = [...observations]
          .reverse()
          .find((observation) => observation.skillName === 'inspect_node' && observation.ok && observation.result && typeof observation.result === 'object');

        agentTrace.push(`FINAL ANSWER: workflow_snapshot=yes, observations=${observations.length}`);
        if (onProgress) onProgress('Drafting final answer...');
        return requestAgentChat({
          credentialId,
          messages,
          workflowSnapshot,
          observations,
          nodeInspection: latestNodeInspection?.result || null,
          agentTrace,
        });
      } catch (error) {
        console.error('Run agent loop:', error);
        agentTrace.push(`LOOP ERROR: ${error instanceof Error ? error.message : 'unknown error'}`);
        addLoopSignal(loopSignals, `Agent loop error: ${error instanceof Error ? error.message : 'unknown error'}`);
        if (onProgress) onProgress('Agent loop error, answering with current evidence...');
      }
      const latestNodeInspection = [...observations]
        .reverse()
        .find((observation) => observation.skillName === 'inspect_node' && observation.ok && observation.result && typeof observation.result === 'object');
      return requestAgentChat({
        credentialId,
        messages,
        workflowSnapshot,
        observations,
        nodeInspection: latestNodeInspection?.result || null,
        agentTrace,
      });
    }
    return requestSimpleChat({ credentialId, messages });
  }

  async function refreshConversationTitle(targetConversation) {
    if (!targetConversation?.id || !credentialId) return;
    const fullMessages = ensureConversationMessages(targetConversation);
    if (!shouldRefreshGeneratedTitle(fullMessages)) return;
    const sourceMessages = getTitleSummarySourceMessages(fullMessages);

    const requestId = (titleRequestSerialByConversation.get(targetConversation.id) || 0) + 1;
    titleRequestSerialByConversation.set(targetConversation.id, requestId);
    try {
      const { ok, content } = await requestChatCompletion(buildTitleSummaryPrompt(sourceMessages), { useWorkflowContext: false });
      if (!ok || titleRequestSerialByConversation.get(targetConversation.id) !== requestId) return;
      const fallbackText =
        sourceMessages.find((message) => message.role === 'user')?.content || targetConversation.title;
      targetConversation.title = normalizeGeneratedTitle(content, fallbackText);
      targetConversation.generatedTitle = true;
      targetConversation.updatedAt = Date.now();
      notifyConversationUpdated(targetConversation);
      if (isMounted() && activeConversationId === targetConversation.id) renderActiveConversation();
    } catch (error) {
      console.error('Generate conversation title:', error);
    } finally {
      if (titleRequestSerialByConversation.get(targetConversation.id) === requestId) {
        titleRequestSerialByConversation.delete(targetConversation.id);
      }
    }
  }

  async function requestAssistantReply(targetConversation, targetMessages) {
    try {
      setPendingStatus(targetConversation, 'Planning next steps...');
      const { ok, content: reply } = await requestChatCompletion(sliceChatHistoryForApi(targetMessages), {
        useWorkflowContext: true,
        onProgress: (status) => setPendingStatus(targetConversation, status),
      });

      targetConversation.pending = false;
      targetConversation.pendingStatus = '';
      targetMessages.push({ role: 'assistant', content: reply });
      targetConversation.updatedAt = Date.now();
      notifyConversationUpdated(targetConversation);
      if (isMounted() && activeConversationId === targetConversation.id) renderActiveConversation();
      if (ok) void refreshConversationTitle(targetConversation);
    } catch (error) {
      const reply = `Error: ${error instanceof Error ? error.message : 'Request failed'}`;
      targetConversation.pending = false;
      targetConversation.pendingStatus = '';
      targetMessages.push({ role: 'assistant', content: reply });
      targetConversation.updatedAt = Date.now();
      notifyConversationUpdated(targetConversation);
      if (isMounted() && activeConversationId === targetConversation.id) renderActiveConversation();
    } finally {
      sendInFlight = false;
      if (isMounted() && activeConversationId === targetConversation.id) renderActiveConversation();
      if (isMounted()) updateComposerState();
    }
  }

  async function submitEditedMessage() {
    const text = String(editingDraft || '').trim();
    const activeConversation = getActiveConversation();
    if (!text || !credentialId || sendInFlight || !activeConversation || editingMessageIndex === -1) return;

    const targetConversation = activeConversation;
    const targetMessages = ensureConversationMessages(targetConversation);
    const messageIndex = editingMessageIndex;
    const targetMessage = targetMessages[messageIndex];
    if (!targetMessage || targetMessage.role !== 'user') return;

    sendInFlight = true;
    editingMessageIndex = -1;
    editingDraft = '';
    targetMessage.content = text;
    targetMessages.splice(messageIndex + 1);
    targetConversation.pending = true;
    targetConversation.pendingStatus = 'Planning next steps...';
    targetConversation.updatedAt = Date.now();
    if (messageIndex === 0) {
      targetConversation.title = deriveConversationTitle(text);
      targetConversation.generatedTitle = true;
    }
    notifyConversationUpdated(targetConversation);
    if (activeConversationId === targetConversation.id) renderActiveConversation();
    updateComposerState();

    await requestAssistantReply(targetConversation, targetMessages);
  }

  async function initializeCredential() {
    try {
      const credential = await loadReviewCredential();
      if (!isMounted()) return;
      if (!credential) {
        credentialId = '';
      } else {
        credentialId = String(credential.id || '').trim();
      }
    } catch (error) {
      credentialId = '';
      console.error('Load Review model:', error);
    }
    updateComposerState();
  }

  async function sendMessage() {
    const text = String(inputEl.value || '').trim();
    const activeConversation = getActiveConversation();
    if (!text || !credentialId || sendInFlight || !activeConversation || editingMessageIndex !== -1) return;

    const targetConversation = activeConversation;
    const targetMessages = ensureConversationMessages(targetConversation);
    sendInFlight = true;
    targetConversation.unsentDraft = '';
    notifyConversationDraftChanged(targetConversation);
    inputEl.value = '';
    if (typeof autoResizeComposer === 'function') autoResizeComposer();

    if (targetMessages.length === 0) {
      targetConversation.title = deriveConversationTitle(text);
      targetConversation.generatedTitle = true;
    }

    targetMessages.push({ role: 'user', content: text });
    targetConversation.updatedAt = Date.now();
    targetConversation.pending = true;
    targetConversation.pendingStatus = 'Planning next steps...';
    notifyConversationUpdated(targetConversation);
    if (activeConversationId === targetConversation.id) renderActiveConversation();
    updateComposerState();

    await requestAssistantReply(targetConversation, targetMessages);
  }

  function handleInput() {
    const activeConversation = getActiveConversation();
    if (activeConversation) {
      activeConversation.unsentDraft = String(inputEl.value || '');
      notifyConversationDraftChanged(activeConversation);
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
    destroy() {
      inputEl.removeEventListener('input', handleInput);
      inputEl.removeEventListener('keydown', handleKeyDown);
      sendButtonEl.removeEventListener('click', handleSendClick);
      document.removeEventListener('pointerdown', handleOutsidePointerDown);
    },
  };
}
