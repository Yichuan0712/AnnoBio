const MOCK_CHATS = [
  {
    id: 'new-chat',
    title: 'New Chat',
    subtitle: 'Placeholder conversation',
    messages: [
      {
        role: 'assistant',
        text: 'This is a placeholder chat. Real agent actions can be connected here later.',
      },
    ],
  },
  {
    id: 'prompt-tuning',
    title: 'Prompt Tuning',
    subtitle: 'gpt-5-mini · 5m ago',
    messages: [
      {
        role: 'user',
        text: 'Help me improve the evaluation prompt for tone consistency.',
      },
      {
        role: 'assistant',
        text: 'I can help with that. We can tighten the scoring rubric and add clearer examples before wiring up real agent actions.',
      },
    ],
  },
  {
    id: 'review-agent',
    title: 'Review Agent',
    subtitle: 'gpt-5 · Yesterday',
    messages: [
      {
        role: 'user',
        text: 'Summarize what changed in my latest workflow run.',
      },
      {
        role: 'assistant',
        text: 'This is a placeholder chat view. Real review output can be connected here later.',
      },
    ],
  },
];

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

function createSidebarItem(chat, isActive) {
  return `
    <button
      type="button"
      class="agent-window__chat-item${isActive ? ' is-active' : ''}"
      data-chat-id="${escapeHtml(chat.id)}"
    >
      <span class="agent-window__chat-title">${escapeHtml(chat.title)}</span>
      <span class="agent-window__chat-subtitle">${escapeHtml(chat.subtitle)}</span>
    </button>
  `;
}

function createChatMarkup(chat) {
  const messages = Array.isArray(chat.messages) ? chat.messages : [];
  return `
    <div class="agent-window__conversation">
      <div class="agent-window__conversation-header">
        <div>
          <h3 class="agent-window__conversation-title">${escapeHtml(chat.title)}</h3>
          <p class="agent-window__conversation-subtitle">${escapeHtml(chat.subtitle)}</p>
        </div>
        <span class="agent-window__model-pill">Placeholder</span>
      </div>
      <div class="agent-window__messages">
        ${messages.map((message) => `
          <div class="agent-window__message agent-window__message--${escapeHtml(message.role)}">
            <div class="agent-window__message-role">${message.role === 'assistant' ? 'Agent' : 'You'}</div>
            <div class="agent-window__message-bubble">${escapeHtml(message.text)}</div>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

function renderContent(contentEl, activeChat) {
  contentEl.innerHTML = createChatMarkup(activeChat);
}

export function openAgentWindowModal() {
  const existing = document.querySelector('.agent-window-overlay');
  if (existing) {
    const closeButton = existing.querySelector('.modal-close');
    if (closeButton) closeButton.focus();
    return;
  }

  let activeChatId = MOCK_CHATS[0].id;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay agent-window-overlay';
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'agent-window-title');

  overlay.innerHTML = `
    <div class="modal-panel agent-window">
      <div class="modal-header">
        <h2 id="agent-window-title" class="modal-title">Agents Window</h2>
        <button type="button" class="modal-close" aria-label="Close">×</button>
      </div>
      <div class="modal-body agent-window__body">
        <aside class="agent-window__sidebar">
          <div class="agent-window__sidebar-header">
            <button type="button" class="agent-window__new-chat-btn">+ New chat</button>
          </div>
          <div class="agent-window__chat-list"></div>
        </aside>
        <section class="agent-window__main">
          <div class="agent-window__content"></div>
          <div class="agent-window__composer">
            <textarea
              class="agent-window__composer-input"
              rows="3"
              placeholder="Message agents... (UI placeholder)"
            ></textarea>
            <button type="button" class="agent-window__composer-send" disabled>Send</button>
          </div>
        </section>
      </div>
    </div>
  `;

  const chatListEl = overlay.querySelector('.agent-window__chat-list');
  const contentEl = overlay.querySelector('.agent-window__content');

  function close() {
    overlay.remove();
    document.body.style.overflow = '';
    document.removeEventListener('keydown', onKeyDown);
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') close();
  }

  function render() {
    chatListEl.innerHTML = MOCK_CHATS.map((chat) => createSidebarItem(chat, chat.id === activeChatId)).join('');
    const activeChat = MOCK_CHATS.find((chat) => chat.id === activeChatId) || MOCK_CHATS[0];
    renderContent(contentEl, activeChat);
  }

  overlay.querySelector('.modal-close').addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  overlay.querySelector('.agent-window__new-chat-btn').addEventListener('click', () => {
    activeChatId = 'new-chat';
    render();
  });
  chatListEl.addEventListener('click', (e) => {
    const button = e.target.closest('[data-chat-id]');
    if (!button) return;
    activeChatId = button.getAttribute('data-chat-id') || MOCK_CHATS[0].id;
    render();
  });

  document.addEventListener('keydown', onKeyDown);
  document.body.style.overflow = 'hidden';
  document.body.appendChild(overlay);
  render();
}
