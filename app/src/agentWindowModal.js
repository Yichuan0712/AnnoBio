import { attachModalPaneToggle } from './paneToggleButton.js';

const MOCK_CHATS = [
  {
    id: 'new-chat',
    title: 'New Agent',
    subtitle: 'Placeholder agent',
    messages: [
      {
        role: 'assistant',
        text: 'This is a placeholder agent. Real agent actions can be connected here later.',
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
        text: 'This is a placeholder agent view. Real review output can be connected here later.',
      },
    ],
  },
];

function createChatId() {
  return `chat-${Math.random().toString(36).slice(2, 10)}`;
}

function createDraftChat(index = 1) {
  return {
    id: createChatId(),
    title: index <= 1 ? 'New Agent' : `New Agent ${index}`,
    subtitle: 'Placeholder agent',
    messages: [
      {
        role: 'assistant',
        text: 'This is a placeholder agent. Real agent actions can be connected here later.',
      },
    ],
  };
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

function createSidebarItem(chat, isActive) {
  const summary = chat.subtitle ? `${chat.title} · ${chat.subtitle}` : chat.title;
  return `
    <div class="agent-window__chat-item score-rule-card${isActive ? ' is-active' : ''}" data-chat-id="${escapeHtml(chat.id)}">
      <button type="button" class="agent-window__chat-item-inner score-rule-card-inner" data-chat-id="${escapeHtml(chat.id)}" title="${escapeHtml(summary)}">
        <span class="agent-window__chat-title score-rule-card-summary">${escapeHtml(summary)}</span>
      </button>
      <button type="button" class="agent-window__chat-remove score-rule-card-remove" data-action="delete-chat" data-chat-id="${escapeHtml(chat.id)}" aria-label="Delete agent">×</button>
    </div>
  `;
}

function createNewChatItem() {
  return `
    <button type="button" class="agent-window__new-chat-btn score-tree-add-rule-box" data-action="new-chat">+ Add agent</button>
  `;
}

function createChatMarkup(chat) {
  const messages = Array.isArray(chat.messages) ? chat.messages : [];
  return `
    <div class="agent-window__conversation">
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

  let chats = MOCK_CHATS.map((chat) => ({
    ...chat,
    messages: Array.isArray(chat.messages) ? chat.messages.map((message) => ({ ...message })) : [],
  }));
  let activeChatId = chats[0].id;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay modal-overlay--no-maximize agent-window-overlay';
  overlay.setAttribute('aria-labelledby', 'agent-window-title');

  overlay.innerHTML = `
    <div class="modal-panel agent-window">
      <div class="modal-header">
        <h2 id="agent-window-title" class="modal-title">Agent Window</h2>
        <button type="button" class="modal-close" aria-label="Close">×</button>
      </div>
      <div class="modal-body agent-window__body">
        <aside class="agent-window__sidebar">
          <div class="agent-window__sidebar-header">
            <p class="agent-window__sidebar-title">Agents</p>
          </div>
          <div class="agent-window__chat-list"></div>
        </aside>
        <section class="agent-window__main">
          <div class="agent-window__main-header">
            <p class="agent-window__main-label">Agent</p>
          </div>
          <div class="agent-window__content"></div>
          <div class="agent-window__composer">
            <div class="agent-window__composer-field">
              <textarea
                class="agent-window__composer-input"
                rows="3"
                placeholder="Message agents... (UI placeholder)"
              ></textarea>
              <button type="button" class="agent-window__composer-send" aria-label="Send" disabled>↑</button>
            </div>
          </div>
        </section>
      </div>
    </div>
  `;

  const chatListEl = overlay.querySelector('.agent-window__chat-list');
  const contentEl = overlay.querySelector('.agent-window__content');
  const mainLabelEl = overlay.querySelector('.agent-window__main-label');
  const composerInputEl = overlay.querySelector('.agent-window__composer-input');

  function setSidebarCollapsed(collapsed) {
    overlay.classList.toggle('agent-window-overlay--sidebar-collapsed', collapsed);
  }

  function autoResizeComposer() {
    if (!composerInputEl) return;
    composerInputEl.style.height = 'auto';
    const nextHeight = Math.min(Math.max(composerInputEl.scrollHeight, 72), 180);
    composerInputEl.style.height = `${nextHeight}px`;
  }

  function close() {
    overlay.remove();
    document.removeEventListener('keydown', onKeyDown);
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') close();
  }

  function render() {
    chatListEl.innerHTML =
      chats.map((chat) => createSidebarItem(chat, chat.id === activeChatId)).join('') +
      createNewChatItem();
    const activeChat = chats.find((chat) => chat.id === activeChatId) || chats[0];
    if (mainLabelEl) mainLabelEl.textContent = activeChat?.title || 'Agent';
    renderContent(contentEl, activeChat);
  }

  overlay.querySelector('.modal-close').addEventListener('click', close);
  const agentPaneToggle = attachModalPaneToggle({
    overlay,
    isCollapsed: () => overlay.classList.contains('agent-window-overlay--sidebar-collapsed'),
    onToggle: () => {
      setSidebarCollapsed(!overlay.classList.contains('agent-window-overlay--sidebar-collapsed'));
      agentPaneToggle.update();
    },
    expandedLabel: 'Hide agents panel',
    collapsedLabel: 'Show agents panel',
  });
  chatListEl.addEventListener('click', (e) => {
    const newChatBtn = e.target.closest('[data-action="new-chat"]');
    if (newChatBtn) {
      const newChat = createDraftChat(chats.filter((chat) => chat.title.startsWith('New Agent')).length + 1);
      chats = [...chats, newChat];
      activeChatId = newChat.id;
      render();
      return;
    }
    const deleteBtn = e.target.closest('[data-action="delete-chat"]');
    if (deleteBtn) {
      const chatId = deleteBtn.getAttribute('data-chat-id') || '';
      chats = chats.filter((chat) => chat.id !== chatId);
      if (chats.length === 0) {
        const fallbackChat = createDraftChat(1);
        chats = [fallbackChat];
        activeChatId = fallbackChat.id;
      } else if (activeChatId === chatId) {
        activeChatId = chats[0].id;
      }
      render();
      return;
    }
    const button = e.target.closest('[data-chat-id]');
    if (!button) return;
    activeChatId = button.getAttribute('data-chat-id') || chats[0].id;
    render();
  });
  composerInputEl?.addEventListener('input', autoResizeComposer);

  document.addEventListener('keydown', onKeyDown);
  document.body.appendChild(overlay);
  setSidebarCollapsed(true);
  agentPaneToggle.update();
  render();
  autoResizeComposer();
}
