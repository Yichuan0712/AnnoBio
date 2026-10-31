import { attachModalPaneToggle } from './paneToggleButton.js';
import { mountAgentChatSession } from './agentChatSession.js';
import { clampAgentTitle } from './agentTitleLimits.js';
import { BACKEND_API_BASE, waitForBackend } from './backendConfig.js';
import { iconCollapse } from './modalMaximize.js';
import { normalizeStoredAttachments } from './agent/attachments/attachmentTypes.js';
import { attachmentsSupported } from './agent/attachments/desktopAttachments.js';
import { iconPaperclip } from './icons.js';
import { createConversationSaver } from './agent/conversationSaver.js';

// Web fallback for the electronAPI methods this module relies on: same two method names,
// backed by backend/project_store.py's REST endpoints instead of local-file IPC, keyed by
// project id instead of a file path. Every call site below only ever calls through
// `storageApi`, so this is the only place that needs to branch on where chats are stored.
const webAgentStorageApi = {
  async loadAgentConversations(projectId) {
    const res = await fetch(`${BACKEND_API_BASE}/api/projects/${projectId}/agent-conversations`);
    if (!res.ok) throw new Error('Could not load agent conversations.');
    return res.json();
  },
  async saveAgentConversations(projectId, payload) {
    const res = await fetch(`${BACKEND_API_BASE}/api/projects/${projectId}/agent-conversations`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error('Could not save agent conversations.');
    return { ok: true };
  },
};

// Chats from before any project is open are kept by the backend apart from every project on both
// desktop and web. A failed load
// throws rather than reading as empty, so the dock never saves an empty list over chats it could not read.
const globalAgentStorageApi = {
  async loadAgentConversations() {
    // The desktop dock mounts at launch, possibly before the backend is listening.
    await waitForBackend();
    const res = await fetch(`${BACKEND_API_BASE}/api/agent/conversations`);
    if (!res.ok) throw new Error('Could not load agent conversations.');
    return res.json();
  },
  async saveAgentConversations(_projectPath, payload) {
    const res = await fetch(`${BACKEND_API_BASE}/api/agent/conversations`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error('Could not save agent conversations.');
    return { ok: true };
  },
};

function createChatId() {
  return `chat-${Math.random().toString(36).slice(2, 10)}`;
}

function createDraftChat() {
  return {
    id: createChatId(),
    title: 'New Agent',
    generatedTitle: true,
    updatedAt: Date.now(),
    messages: [],
    pending: false,
    pendingStatus: '',
    unsentDraft: '',
  };
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

function buildChatSubtitle(chat) {
  const title = String(chat?.title || '').trim();
  if (title && !/^New Agent(?: \d+)?$/.test(title)) return clampAgentTitle(title);

  const messages = Array.isArray(chat?.messages) ? chat.messages : [];
  const firstUserMessage = messages.find((message) => message?.role === 'user' && String(message.content || '').trim());
  const fallback = String(firstUserMessage?.content || '').replace(/\s+/g, ' ').trim();
  if (!fallback) return chat?.pending ? 'Thinking...' : 'New Agent';
  return clampAgentTitle(fallback);
}

function createSidebarItem(chat, isActive) {
  const summary = buildChatSubtitle(chat);
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

// Conversations saved before the tool-calling Agent (no format_version) are not loaded: their
// messages carry none of the tool history the current loop needs. See docs/design/AGENT_DESIGN.md.
const CONVERSATIONS_FORMAT_VERSION = 2;

/** Keeps the fields agent/agentLoop.js stores on each message (tool calls, tool results, attachments).
 * main.js's mapAgentMessageForStorage keeps the same fields for desktop projects. */
function mapMessageForStorage(message) {
  if (!message || typeof message !== 'object') {
    return { role: 'assistant', content: '' };
  }
  const out = {
    role: String(message.role || 'assistant'),
    content: String(message.content || ''),
    ...(message.role === 'assistant' && message.reasoningContent != null ? { reasoningContent: String(message.reasoningContent) } : {}),
  };
  if (Array.isArray(message.toolCalls) && message.toolCalls.length) {
    out.toolCalls = message.toolCalls.map((call) => ({
      id: String(call?.id || ''),
      name: String(call?.name || ''),
      arguments: String(call?.arguments || '{}'),
      ...(call?.preview && typeof call.preview === 'object' ? { preview: call.preview } : {}),
    }));
  }
  if (out.role === 'tool') {
    out.toolCallId = String(message.toolCallId || '');
    out.name = String(message.name || '');
    out.ok = message.ok !== false;
    out.label = String(message.label || '');
    if (message.answer != null) out.answer = String(message.answer);
    if (message.outcome != null) out.outcome = String(message.outcome);
  }
  const attachments = out.role === 'user' || out.role === 'tool' ? normalizeStoredAttachments(message.attachments) : [];
  if (attachments.length) out.attachments = attachments;
  return out;
}

/** {contextSummary} when the stored summary (agent/historySummary.js) still fits the messages, else {}. */
function normalizeContextSummary(summary, messageCount) {
  const text = String(summary?.text || '').trim();
  const covered = Number(summary?.covered);
  return text && Number.isInteger(covered) && covered > 0 && covered <= messageCount
    ? { contextSummary: { text, covered } }
    : {};
}

function normalizeStoredChats(data) {
  if (Number(data?.format_version) !== CONVERSATIONS_FORMAT_VERSION) {
    return { conversations: [], activeChatId: '' };
  }
  const conversations = Array.isArray(data?.conversations)
    ? data.conversations
        .filter((chat) => chat && typeof chat === 'object' && String(chat.id || '').trim())
        .map((chat) => ({
          id: String(chat.id || '').trim(),
          title: clampAgentTitle(String(chat.title || '').trim() || 'New Agent'),
          generatedTitle: chat.generatedTitle === true,
          updatedAt: Number.isFinite(Number(chat.updatedAt)) ? Number(chat.updatedAt) : Date.now(),
          pending: chat.pending === true,
          pendingStatus: String(chat.pendingStatus || '').trim(),
          unsentDraft: String(chat.unsentDraft || ''),
          welcomeDismissed: chat.welcomeDismissed === true,
          unsentAttachments: normalizeStoredAttachments(chat.unsentAttachments),
          messages: Array.isArray(chat.messages)
            ? chat.messages
                .filter((message) => message && typeof message === 'object')
                .map((message) => mapMessageForStorage(message))
            : [],
          ...normalizeContextSummary(chat.contextSummary, Array.isArray(chat.messages) ? chat.messages.length : 0),
        }))
    : [];
  const activeChatId = String(data?.activeConversationId || data?.activeChatId || '').trim();
  return { conversations: sortChatsByRecent(conversations), activeChatId };
}

/**
 * A chat stored as pending was mid-turn when the app quit or crashed: turns run in this renderer,
 * so nothing else is going to finish it. It gets a note if the turn ended part-way (last message a
 * question, tool call or result). Returns whether any chat changed.
 */
function finalizeStalePendingChats(chats) {
  let changed = false;
  for (const chat of chats) {
    if (!chat.pending) continue;
    const last = chat.messages[chat.messages.length - 1];
    chat.pending = false;
    chat.pendingStatus = '';
    chat.updatedAt = Date.now();
    changed = true;
    if (last && !(last.role === 'assistant' && !last.toolCalls?.length)) {
      chat.messages.push({
        role: 'assistant',
        content: 'No response was saved for the previous in-flight request. Send again if you still need a reply.',
      });
    }
  }
  return changed;
}

/**
 * Mounts the Agent Assistant into its workspace dock (`options.host`): the open project's chats,
 * or with no project (`projectPath` empty) the chats kept apart from every project.
 */
export async function openAgentWindowModal(options = {}) {
  const host = options.host;
  const existing = host.querySelector('.agent-window-overlay');
  if (existing) {
    const closeButton = existing.querySelector('.modal-close');
    if (closeButton) closeButton.focus();
    return;
  }

  // Both change once, when the Agent's create_project moves a chat into a new project (adoptProject).
  let projectPath = String(options?.projectPath || '').trim();
  const workspace = options?.workspace || null;
  let storageApi = projectPath ? window.electronAPI || webAgentStorageApi : globalAgentStorageApi;
  let storedState = { conversations: [], activeChatId: '' };
  // Saving after a failed load would replace the stored chats with this session's.
  let loadFailed = false;
  if (storageApi?.loadAgentConversations) {
    try {
      storedState = normalizeStoredChats(await storageApi.loadAgentConversations(projectPath));
    } catch (error) {
      loadFailed = true;
      console.error('Load agent conversations:', error);
    }
  }
  if (options.isCurrent && !options.isCurrent()) return;

  const hadStalePending = finalizeStalePendingChats(storedState.conversations);
  let chats = storedState.conversations.length ? sortChatsByRecent(storedState.conversations) : [createDraftChat()];
  const savedActiveId = String(storedState.activeChatId || '').trim();
  let activeChatId =
    savedActiveId && chats.some((c) => c.id === savedActiveId) ? savedActiveId : chats[0].id;
  const overlay = document.createElement('div');
  overlay.className = 'workspace-dock agent-window-overlay';
  overlay.setAttribute('role', 'region');
  overlay.setAttribute('aria-labelledby', 'agent-window-title');

  overlay.innerHTML = `
    <div class="modal-panel agent-window">
      <div class="modal-header">
        <h2 id="agent-window-title" class="modal-title">Agent Assistant</h2>
        <button type="button" class="modal-close" aria-label="Collapse Agent Assistant" title="Collapse panel"></button>
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
            <div class="agent-window__attachment-tray" hidden></div>
            <div class="agent-window__composer-field">
              <textarea
                class="agent-window__composer-input"
                rows="3"
                placeholder="Loading Agent model..."
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
  const messagesEl = overlay.querySelector('.agent-window__messages');
  const composerInputEl = overlay.querySelector('.agent-window__composer-input');
  const composerSendEl = overlay.querySelector('.agent-window__composer-send');
  // Attaching files is desktop-only (docs/design/AGENT_ATTACHMENTS_PLAN.md).
  let composerAttachEl = null;
  if (attachmentsSupported()) {
    composerAttachEl = document.createElement('button');
    composerAttachEl.type = 'button';
    composerAttachEl.className = 'agent-window__composer-attach';
    composerAttachEl.title = 'Attach files';
    composerAttachEl.setAttribute('aria-label', 'Attach files');
    composerAttachEl.appendChild(iconPaperclip(15));
    composerSendEl.before(composerAttachEl);
    overlay.classList.add('agent-window-overlay--attachments');
  }
  let chatSession = null;
  let saveChain = Promise.resolve();
  const saver = createConversationSaver(async () => {
    if (loadFailed || !storageApi?.saveAgentConversations) return;
    try {
      await saveChain;
      await storageApi.saveAgentConversations(projectPath, buildSavePayload());
    } catch (error) {
      console.error('Save agent conversations:', error);
    }
  });

  function buildSavePayload(list = chats, activeId = activeChatId) {
    return {
      format_version: CONVERSATIONS_FORMAT_VERSION,
      activeConversationId: activeId,
      conversations: list.map((chat) => ({
        ...chat,
        pending: chat.pending === true,
        pendingStatus: String(chat.pendingStatus || '').trim(),
        unsentDraft: String(chat.unsentDraft || ''),
        messages: Array.isArray(chat.messages)
          ? chat.messages.map((message) => mapMessageForStorage(message))
          : [],
      })),
    };
  }

  function saveConversations() {
    if (loadFailed || !storageApi?.saveAgentConversations) return;
    saver.schedule();
  }

  /**
   * The Agent's create_project made `nextPath` (workflowCanvas.js's syncProjectPanels): chat
   * `conversationId` moves out of the global store into that project and its turn carries on. The
   * switch happens at once, so any save from here on goes to the project; the two writes queue after
   * the saves already pending, project first, so a failure part-way leaves the chat in both, never
   * in neither.
   */
  async function adoptProject(nextPath, conversationId) {
    // Finish writes to the old store before moving the chat to its new project.
    await saver.flush();
    const chat = chats.find((item) => item.id === conversationId);
    const remaining = chats.filter((item) => item !== chat);
    const globalPayload = buildSavePayload(remaining, remaining[0]?.id || '');
    const globalWritable = !loadFailed;
    const projectStorage = window.electronAPI || webAgentStorageApi;
    projectPath = nextPath;
    storageApi = projectStorage;
    loadFailed = false;
    chats = [chat || createDraftChat()];
    activeChatId = chats[0].id;
    const projectPayload = buildSavePayload();
    saveChain = saveChain
      .catch(() => {})
      .then(async () => {
        await projectStorage.saveAgentConversations(nextPath, projectPayload);
        if (globalWritable) await globalAgentStorageApi.saveAgentConversations('', globalPayload);
      })
      .catch((error) => {
        console.error('Move agent conversation into the project:', error);
      });
    syncActiveChatUI();
    await saveChain;
  }
  overlay.adoptProject = adoptProject;

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
    if (!overlay.isConnected) return;
    const activeChat = getActiveChat();
    const labelEl = overlay.querySelector('.agent-window__main-label');
    if (labelEl) {
      const raw = String(activeChat?.title || '').trim();
      labelEl.textContent = raw ? clampAgentTitle(raw) : 'Agent';
    }
    try {
      chatSession?.setConversation(activeChat);
    } catch (err) {
      console.error('Agent chat setConversation:', err);
    } finally {
      renderSidebar();
    }
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

  function destroy() {
    // A dock is destroyed only when switching projects; collapsing it keeps the turn alive.
    chatSession?.stopAssistant?.();
    chatSession?.destroy?.();
    chatSession = null;
    void saver.flush();
    window.removeEventListener('pagehide', flushConversations);
    overlay.remove();
  }
  function flushConversations() { void saver.flush(); }
  window.addEventListener('pagehide', flushConversations);
  overlay.destroyAgentWindow = destroy;

  const closeButton = overlay.querySelector('.modal-close');
  closeButton.appendChild(iconCollapse());
  closeButton.addEventListener('click', () => options.onClose?.());
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
  chatListEl.addEventListener('click', async (e) => {
    const newChatBtn = e.target.closest('[data-action="new-chat"]');
    if (newChatBtn) {
      const newChat = createDraftChat();
      chats = sortChatsByRecent([...chats, newChat]);
      activeChatId = newChat.id;
      syncActiveChatUI();
      saveConversations();
      return;
    }
    const deleteBtn = e.target.closest('[data-action="delete-chat"]');
    if (deleteBtn) {
      const chatId = deleteBtn.getAttribute('data-chat-id') || '';
      if (window.electronAPI?.revokeAgentPath) {
        const result = await window.electronAPI.revokeAgentPath(chatId);
        if (result?.error) { console.error('Revoke local paths:', result.error); return; }
      }
      chats = sortChatsByRecent(chats.filter((chat) => chat.id !== chatId));
      if (chats.length === 0) {
        const fallbackChat = createDraftChat();
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
  host.appendChild(overlay);
  chatSession = mountAgentChatSession({
    overlay,
    messagesEl,
    inputEl: composerInputEl,
    sendButtonEl: composerSendEl,
    attachButtonEl: composerAttachEl,
    attachmentTrayEl: overlay.querySelector('.agent-window__attachment-tray'),
    dropZoneEl: overlay.querySelector('.agent-window__main'),
    autoResizeComposer,
    workspace,
    onConversationDraftChanged: () => {
      saveConversations();
    },
    resolveConversation: (conversationId) =>
      chats.find((chat) => chat.id === String(conversationId || '').trim()) || null,
    onConversationUpdated: () => {
      chats = sortChatsByRecent(chats);
      saveConversations();
      if (overlay.isConnected) syncActiveChatUI();
    },
  });
  syncActiveChatUI();
  if (hadStalePending) saveConversations();
  setSidebarCollapsed(true);
  agentPaneToggle.update();
  autoResizeComposer();
}
