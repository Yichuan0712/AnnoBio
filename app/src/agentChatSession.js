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

function createMessageNode(role, content, options = {}) {
  const { loading = false } = options;
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
    bubbleEl.textContent = content;
  }

  wrapper.appendChild(roleEl);
  wrapper.appendChild(bubbleEl);
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
    messages.forEach((message) => appendMessage(message.role, message.content));
    if (activeConversation?.pending) {
      appendMessage('assistant', '', { loading: true });
    }
  }

  function updateComposerState() {
    const hasText = Boolean((inputEl.value || '').trim());
    inputEl.disabled = !credentialId || sendInFlight || !activeConversation;
    sendButtonEl.disabled = !credentialId || sendInFlight || !activeConversation || !hasText;
    inputEl.placeholder = !activeConversation
      ? 'Select a chat first'
      : credentialId
        ? (sendInFlight ? 'Waiting for response...' : 'Message chatbot...')
        : 'Select a Review model in Settings first';
  }

  function appendMessage(role, content, options = {}) {
    const node = createMessageNode(role, content, options);
    messagesEl.appendChild(node);
    scrollToBottom();
    return node;
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
    if (!text || !credentialId || sendInFlight || !activeConversation) return;

    const targetConversation = activeConversation;
    const targetMessages = ensureConversationMessages(targetConversation);
    sendInFlight = true;
    inputEl.value = '';
    if (typeof autoResizeComposer === 'function') autoResizeComposer();

    if (targetConversation.generatedTitle) {
      targetConversation.title = deriveConversationTitle(text);
      targetConversation.generatedTitle = false;
    }

    targetMessages.push({ role: 'user', content: text });
    targetConversation.updatedAt = Date.now();
    targetConversation.pending = true;
    notifyConversationUpdated(targetConversation);
    if (activeConversation?.id === targetConversation.id) renderActiveConversation();
    updateComposerState();

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
      if (!isMounted()) return;

      const reply = res.ok
        ? String(payload?.content || '').trim() || '(No response)'
        : `Error: ${payload?.detail || res.statusText}`;

      targetConversation.pending = false;
      targetMessages.push({ role: 'assistant', content: reply });
      targetConversation.updatedAt = Date.now();
      notifyConversationUpdated(targetConversation);
      if (activeConversation?.id === targetConversation.id) renderActiveConversation();
    } catch (error) {
      const reply = `Error: ${error instanceof Error ? error.message : 'Request failed'}`;
      targetConversation.pending = false;
      targetMessages.push({ role: 'assistant', content: reply });
      targetConversation.updatedAt = Date.now();
      notifyConversationUpdated(targetConversation);
      if (isMounted() && activeConversation?.id === targetConversation.id) renderActiveConversation();
    } finally {
      sendInFlight = false;
      if (isMounted()) updateComposerState();
    }
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
    renderActiveConversation();
    updateComposerState();
  }

  messagesEl.innerHTML = '';
  inputEl.addEventListener('input', handleInput);
  inputEl.addEventListener('keydown', handleKeyDown);
  sendButtonEl.addEventListener('click', handleSendClick);
  updateComposerState();
  initializeCredential();

  return {
    setConversation,
    destroy() {
      inputEl.removeEventListener('input', handleInput);
      inputEl.removeEventListener('keydown', handleKeyDown);
      sendButtonEl.removeEventListener('click', handleSendClick);
    },
  };
}
