import { attachModalPaneToggle } from './paneToggleButton.js';
import { mountAgentChatSession } from './agentChatSession.js';

function createChatId() {
  return `chat-${Math.random().toString(36).slice(2, 10)}`;
}

function createDraftChat(index = 1) {
  return {
    id: createChatId(),
    title: index <= 1 ? 'New Agent' : `New Agent ${index}`,
    generatedTitle: true,
    updatedAt: Date.now(),
    messages: [],
    pending: false,
  };
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

function buildChatSubtitle(chat) {
  const messages = Array.isArray(chat?.messages) ? chat.messages : [];
  const lastMessage = messages.length ? String(messages[messages.length - 1]?.content || '').trim() : '';
  if (!lastMessage) return chat?.pending ? 'Thinking...' : 'No messages yet';
  const compact = lastMessage.replace(/\s+/g, ' ').trim();
  return compact.length <= 42 ? compact : `${compact.slice(0, 41).trimEnd()}...`;
}

function createSidebarItem(chat, isActive) {
  const summary = `${chat.title} · ${buildChatSubtitle(chat)}`;
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

function sortChatsByRecent(chats) {
  return (Array.isArray(chats) ? chats : [])
    .slice()
    .sort((a, b) => {
      const aTime = Number(a?.updatedAt) || 0;
      const bTime = Number(b?.updatedAt) || 0;
      if (bTime !== aTime) return bTime - aTime;
      return String(a?.id || '').localeCompare(String(b?.id || ''));
    });
}

function normalizeStoredChats(data) {
  const conversations = Array.isArray(data?.conversations)
    ? data.conversations
        .filter((chat) => chat && typeof chat === 'object' && String(chat.id || '').trim())
        .map((chat) => ({
          id: String(chat.id || '').trim(),
          title: String(chat.title || '').trim() || 'New Agent',
          generatedTitle: chat.generatedTitle === true,
          updatedAt: Number.isFinite(Number(chat.updatedAt)) ? Number(chat.updatedAt) : Date.now(),
          pending: chat.pending === true,
          messages: Array.isArray(chat.messages)
            ? chat.messages
                .filter((message) => message && typeof message === 'object')
                .map((message) => ({
                  role: String(message.role || 'assistant'),
                  content: String(message.content || ''),
                }))
            : [],
        }))
    : [];
  const activeChatId = String(data?.activeConversationId || '').trim();
  return { conversations: sortChatsByRecent(conversations), activeChatId };
}

function nextDraftIndexFromChats(chats) {
  const nums = (Array.isArray(chats) ? chats : [])
    .map((chat) => {
      const m = String(chat?.title || '').match(/^New Agent(?: (\d+))?$/);
      if (!m) return 0;
      return m[1] ? Number(m[1]) : 1;
    })
    .filter((n) => Number.isFinite(n) && n > 0);
  return nums.length ? Math.max(...nums) : 0;
}

export async function openAgentWindowModal(options = {}) {
  const existing = document.querySelector('.agent-window-overlay');
  if (existing) {
    const closeButton = existing.querySelector('.modal-close');
    if (closeButton) closeButton.focus();
    return;
  }

  const projectPath = String(options?.projectPath || '').trim();
  const storageApi = window.electronAPI;
  let storedState = { conversations: [], activeConversationId: '' };
  if (projectPath && storageApi?.loadAgentConversations) {
    try {
      storedState = normalizeStoredChats(await storageApi.loadAgentConversations(projectPath));
    } catch (error) {
      console.error('Load agent conversations:', error);
    }
  }

  let nextDraftIndex = nextDraftIndexFromChats(storedState.conversations);
  let chats = storedState.conversations.length ? storedState.conversations : [createDraftChat(1)];
  if (storedState.conversations.length === 0) nextDraftIndex = 1;
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
          <div class="agent-window__content">
            <div class="agent-window__conversation">
              <div class="agent-window__messages" aria-live="polite"></div>
            </div>
          </div>
          <div class="agent-window__composer">
            <div class="agent-window__composer-field">
              <textarea
                class="agent-window__composer-input"
                rows="3"
                placeholder="Loading Review model..."
              ></textarea>
              <button type="button" class="agent-window__composer-send" aria-label="Send" disabled>
                <svg class="agent-window__button-icon" viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M8 13.5a.75.75 0 0 1-.75-.75V5.56L4.78 8.03a.75.75 0 1 1-1.06-1.06l3.75-3.75a.75.75 0 0 1 1.06 0l3.75 3.75a.75.75 0 0 1-1.06 1.06L8.75 5.56v7.19a.75.75 0 0 1-.75.75Z"></path>
                </svg>
              </button>
            </div>
          </div>
        </section>
      </div>
    </div>
  `;

  const chatListEl = overlay.querySelector('.agent-window__chat-list');
  const mainLabelEl = overlay.querySelector('.agent-window__main-label');
  const messagesEl = overlay.querySelector('.agent-window__messages');
  const composerInputEl = overlay.querySelector('.agent-window__composer-input');
  const composerSendEl = overlay.querySelector('.agent-window__composer-send');
  let chatSession = null;

  function saveConversations() {
    if (!projectPath || !storageApi?.saveAgentConversations) return;
    const payload = {
      activeConversationId: activeChatId,
      conversations: chats.map((chat) => ({
        ...chat,
        pending: chat.pending === true,
        messages: Array.isArray(chat.messages)
          ? chat.messages.map((message) => ({
              role: String(message.role || 'assistant'),
              content: String(message.content || ''),
            }))
          : [],
      })),
    };
    storageApi.saveAgentConversations(projectPath, payload).catch((error) => {
      console.error('Save agent conversations:', error);
    });
  }

  function getActiveChat() {
    return chats.find((chat) => chat.id === activeChatId) || chats[0] || null;
  }

  function renderSidebar() {
    if (!chatListEl) return;
    chatListEl.innerHTML =
      chats.map((chat) => createSidebarItem(chat, chat.id === activeChatId)).join('') +
      createNewChatItem();
  }

  function syncActiveChatUI() {
    const activeChat = getActiveChat();
    if (mainLabelEl) mainLabelEl.textContent = activeChat?.title || 'Agent';
    chatSession?.setConversation(activeChat);
    renderSidebar();
  }

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
    chatSession?.destroy?.();
    overlay.remove();
    document.removeEventListener('keydown', onKeyDown);
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') close();
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
      nextDraftIndex += 1;
      const newChat = createDraftChat(nextDraftIndex);
      chats = sortChatsByRecent([...chats, newChat]);
      activeChatId = newChat.id;
      syncActiveChatUI();
      saveConversations();
      return;
    }
    const deleteBtn = e.target.closest('[data-action="delete-chat"]');
    if (deleteBtn) {
      const chatId = deleteBtn.getAttribute('data-chat-id') || '';
      chats = sortChatsByRecent(chats.filter((chat) => chat.id !== chatId));
      if (chats.length === 0) {
        nextDraftIndex += 1;
        const fallbackChat = createDraftChat(nextDraftIndex);
        chats = [fallbackChat];
        activeChatId = fallbackChat.id;
      } else if (activeChatId === chatId) {
        activeChatId = chats[0].id;
      }
      syncActiveChatUI();
      saveConversations();
      return;
    }
    const button = e.target.closest('[data-chat-id]');
    if (!button) return;
    activeChatId = button.getAttribute('data-chat-id') || chats[0]?.id || '';
    syncActiveChatUI();
    saveConversations();
  });
  document.addEventListener('keydown', onKeyDown);
  document.body.appendChild(overlay);
  chatSession = mountAgentChatSession({
    overlay,
    messagesEl,
    inputEl: composerInputEl,
    sendButtonEl: composerSendEl,
    autoResizeComposer,
    onConversationUpdated: () => {
      chats = sortChatsByRecent(chats);
      const activeChat = getActiveChat();
      if (mainLabelEl) mainLabelEl.textContent = activeChat?.title || 'Agent';
      renderSidebar();
      saveConversations();
    },
  });
  syncActiveChatUI();
  setSidebarCollapsed(true);
  agentPaneToggle.update();
  autoResizeComposer();
}
