const API_BASE = 'http://localhost:8000';
const CHAT_MAX_MESSAGES = 40;

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
  if (normalized.length <= 28) return normalized;
  return `${normalized.slice(0, 27).trimEnd()}...`;
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

function createMessageNode(role, content, options = {}) {
  const { loading = false, editable = false, actionDisabled = false, onEdit = null } = options;
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
      <span class="agent-window__loading-text">Thinking...</span>
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
}) {
  if (!overlay || !messagesEl || !inputEl || !sendButtonEl) {
    return {
      setConversation() {},
      destroy() {},
    };
  }

  let credentialId = '';
  let sendInFlight = false;
  let activeConversation = null;
  let editingMessageIndex = -1;
  let editingDraft = '';

  function isMounted() {
    return overlay.isConnected;
  }

  function ensureConversationMessages(conversation) {
    if (!conversation) return [];
    if (!Array.isArray(conversation.messages)) conversation.messages = [];
    return conversation.messages;
  }

  function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function notifyConversationUpdated(conversation) {
    if (typeof onConversationUpdated === 'function' && conversation) {
      onConversationUpdated(conversation);
    }
  }

  function renderActiveConversation() {
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
      appendMessage('assistant', '', { loading: true });
    }
  }

  function updateComposerState() {
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

  async function requestAssistantReply(targetConversation, targetMessages) {
    try {
      const res = await fetch(`${API_BASE}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          credential_id: credentialId,
          messages: sliceChatHistoryForApi(targetMessages),
        }),
      });
      const payload = await res.json().catch(() => ({}));

      const reply = res.ok
        ? String(payload?.content || '').trim() || '(No response)'
        : `Error: ${payload?.detail || res.statusText}`;

      targetConversation.pending = false;
      targetMessages.push({ role: 'assistant', content: reply });
      targetConversation.updatedAt = Date.now();
      notifyConversationUpdated(targetConversation);
      if (isMounted() && activeConversation?.id === targetConversation.id) renderActiveConversation();
    } catch (error) {
      const reply = `Error: ${error instanceof Error ? error.message : 'Request failed'}`;
      targetConversation.pending = false;
      targetMessages.push({ role: 'assistant', content: reply });
      targetConversation.updatedAt = Date.now();
      notifyConversationUpdated(targetConversation);
      if (isMounted() && activeConversation?.id === targetConversation.id) renderActiveConversation();
    } finally {
      sendInFlight = false;
      if (isMounted() && activeConversation?.id === targetConversation.id) renderActiveConversation();
      if (isMounted()) updateComposerState();
    }
  }

  async function submitEditedMessage() {
    const text = String(editingDraft || '').trim();
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
    targetConversation.updatedAt = Date.now();
    if (messageIndex === 0 || targetConversation.generatedTitle) {
      targetConversation.title = deriveConversationTitle(text);
      targetConversation.generatedTitle = false;
    }
    notifyConversationUpdated(targetConversation);
    if (activeConversation?.id === targetConversation.id) renderActiveConversation();
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
    if (!text || !credentialId || sendInFlight || !activeConversation || editingMessageIndex !== -1) return;

    const targetConversation = activeConversation;
    const targetMessages = ensureConversationMessages(targetConversation);
    sendInFlight = true;
    inputEl.value = '';
    if (typeof autoResizeComposer === 'function') autoResizeComposer();

    if (targetConversation.generatedTitle || targetMessages.length === 0) {
      targetConversation.title = deriveConversationTitle(text);
      targetConversation.generatedTitle = false;
    }

    targetMessages.push({ role: 'user', content: text });
    targetConversation.updatedAt = Date.now();
    targetConversation.pending = true;
    notifyConversationUpdated(targetConversation);
    if (activeConversation?.id === targetConversation.id) renderActiveConversation();
    updateComposerState();

    await requestAssistantReply(targetConversation, targetMessages);
  }

  function handleInput() {
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
    activeConversation = conversation || null;
    editingMessageIndex = -1;
    editingDraft = '';
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
