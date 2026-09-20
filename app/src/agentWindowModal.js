import { attachModalPaneToggle } from './paneToggleButton.js';
import { mountAgentChatSession } from './agentChatSession.js';
import { clampAgentTitle } from './agentTitleLimits.js';
import { BACKEND_API_BASE } from './backendConfig.js';

// Web fallback for the electronAPI methods this module relies on: same two method names,
// backed by backend/project_store.py's REST endpoints instead of local-file IPC, keyed by
// project id instead of a file path. Every call site below only ever calls through
// `storageApi`, so this is the only place that needs to branch on environment.
const webAgentStorageApi = {
  async loadAgentConversations(projectId) {
    const res = await fetch(`${BACKEND_API_BASE}/api/projects/${projectId}/agent-conversations`);
    if (!res.ok) return { activeConversationId: '', conversations: [] };
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

function mapMessageForStorage(message) {
  if (!message || typeof message !== 'object') {
    return { role: 'assistant', content: '' };
  }
  const out = {
    role: String(message.role || 'assistant'),
    content: String(message.content || ''),
  };
  if (Array.isArray(message.reasoningSteps) && message.reasoningSteps.length > 0) {
    const rs = message.reasoningSteps.map((s) => String(s || '').trim()).filter(Boolean);
    if (rs.length) out.reasoningSteps = rs;
  }
  return out;
}

function normalizeStoredChats(data) {
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
          messages: Array.isArray(chat.messages)
            ? chat.messages
                .filter((message) => message && typeof message === 'object')
                .map((message) => mapMessageForStorage(message))
            : [],
        }))
    : [];
  const activeChatId = String(data?.activeConversationId || data?.activeChatId || '').trim();
  return { conversations: sortChatsByRecent(conversations), activeChatId };
}

/** Apply disk snapshot onto an in-memory chat when disk is newer or has completed a pending reply. */
function mergeRemoteConversationIntoLocal(local, remote) {
  if (!local || !remote || local.id !== remote.id) return false;
  if (!Array.isArray(local.messages)) local.messages = [];
  if (!Array.isArray(remote.messages)) return false;
  const lm = local.messages.length;
  const rm = remote.messages.length;
  const lt = Number(local.updatedAt) || 0;
  const rt = Number(remote.updatedAt) || 0;
  const localPending = local.pending === true;
  const remotePending = remote.pending === true;

  const remoteAhead = rm > lm || (rt > lt && rm >= lm) || (localPending && !remotePending);
  if (!remoteAhead) return false;

  local.title = remote.title;
  local.generatedTitle = remote.generatedTitle === true;
  local.pending = remotePending;
  local.pendingStatus = String(remote.pendingStatus || '').trim();
  local.unsentDraft = String(remote.unsentDraft || '');
  local.updatedAt = Math.max(lt, rt);
  const prevMessages = local.messages;
  local.messages = remote.messages.map((m, i) => {
    const mapped = mapMessageForStorage(m);
    const prev = prevMessages[i];
    if (
      prev
      && prev.role === mapped.role
      && String(prev.content || '') === String(mapped.content || '')
      && Array.isArray(prev.reasoningSteps) && prev.reasoningSteps.length > 0
      && !mapped.reasoningSteps
    ) {
      return { ...mapped, reasoningSteps: prev.reasoningSteps.slice() };
    }
    return mapped;
  });
  return true;
}

export async function openAgentWindowModal(options = {}) {
  const existing = document.querySelector('.agent-window-overlay');
  if (existing) {
    const closeButton = existing.querySelector('.modal-close');
    if (closeButton) closeButton.focus();
    return;
  }

  const onOpen = typeof options?.onOpen === 'function' ? options.onOpen : null;
  const onClose = typeof options?.onClose === 'function' ? options.onClose : null;
  const projectPath = String(options?.projectPath || '').trim();
  const getWorkflowSnapshot = typeof options?.getWorkflowSnapshot === 'function' ? options.getWorkflowSnapshot : null;
  const inspectNode = typeof options?.inspectNode === 'function' ? options.inspectNode : null;
  const addRunNode = typeof options?.addRunNode === 'function' ? options.addRunNode : null;
  const addScoreNode = typeof options?.addScoreNode === 'function' ? options.addScoreNode : null;
  const createAndRunReviewNode = typeof options?.createAndRunReviewNode === 'function' ? options.createAndRunReviewNode : null;
  const verifyReviewSuggestions = typeof options?.verifyReviewSuggestions === 'function' ? options.verifyReviewSuggestions : null;
  const acceptReviewSuggestions = typeof options?.acceptReviewSuggestions === 'function' ? options.acceptReviewSuggestions : null;
  const applyReviewSuggestions = typeof options?.applyReviewSuggestions === 'function' ? options.applyReviewSuggestions : null;
  const startRunNode = typeof options?.startRunNode === 'function' ? options.startRunNode : null;
  const saveRunResultsToWorkspace = typeof options?.saveRunResultsToWorkspace === 'function' ? options.saveRunResultsToWorkspace : null;
  const saveScoreResultsToWorkspace = typeof options?.saveScoreResultsToWorkspace === 'function' ? options.saveScoreResultsToWorkspace : null;
  const addSamplerNode = typeof options?.addSamplerNode === 'function' ? options.addSamplerNode : null;
  const addSampledDatasetNode = typeof options?.addSampledDatasetNode === 'function' ? options.addSampledDatasetNode : null;
  const addPromptNode = typeof options?.addPromptNode === 'function' ? options.addPromptNode : null;
  const addPromptVersion = typeof options?.addPromptVersion === 'function' ? options.addPromptVersion : null;
  const updateScoreNode = typeof options?.updateScoreNode === 'function' ? options.updateScoreNode : null;
  const updateScoreRowSelection = typeof options?.updateScoreRowSelection === 'function' ? options.updateScoreRowSelection : null;
  const addDatasetNode = typeof options?.addDatasetNode === 'function' ? options.addDatasetNode : null;
  const addProcessNode = typeof options?.addProcessNode === 'function' ? options.addProcessNode : null;
  const importPubmedDataset = typeof options?.importPubmedDataset === 'function' ? options.importPubmedDataset : null;
  const importClinicaltrialsDataset = typeof options?.importClinicaltrialsDataset === 'function' ? options.importClinicaltrialsDataset : null;
  const importPreprintDataset = typeof options?.importPreprintDataset === 'function' ? options.importPreprintDataset : null;
  const importChemblDataset = typeof options?.importChemblDataset === 'function' ? options.importChemblDataset : null;
  const storageApi = window.electronAPI || webAgentStorageApi;
  let storedState = { conversations: [], activeChatId: '' };
  if (projectPath && storageApi?.loadAgentConversations) {
    try {
      storedState = normalizeStoredChats(await storageApi.loadAgentConversations(projectPath));
    } catch (error) {
      console.error('Load agent conversations:', error);
    }
  }

  let chats = storedState.conversations.length ? storedState.conversations : [createDraftChat()];
  const savedActiveId = String(storedState.activeChatId || '').trim();
  let activeChatId =
    savedActiveId && chats.some((c) => c.id === savedActiveId) ? savedActiveId : chats[0].id;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay modal-overlay--no-maximize agent-window-overlay';
  overlay.setAttribute('aria-labelledby', 'agent-window-title');

  overlay.innerHTML = `
    <div class="modal-panel agent-window">
      <div class="modal-header">
        <h2 id="agent-window-title" class="modal-title">Agent Assistant</h2>
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
  const messagesEl = overlay.querySelector('.agent-window__messages');
  const composerInputEl = overlay.querySelector('.agent-window__composer-input');
  const composerSendEl = overlay.querySelector('.agent-window__composer-send');
  let chatSession = null;
  let pendingPollTimeout = null;
  let saveChain = Promise.resolve();

  function buildSavePayload() {
    return {
      activeConversationId: activeChatId,
      conversations: chats.map((chat) => ({
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

  function stopPendingPoll() {
    if (pendingPollTimeout != null) {
      clearTimeout(pendingPollTimeout);
      pendingPollTimeout = null;
    }
  }

  /** If a chat was left pending while a request finished after the UI closed, merge from disk until caught up. */
  function finalizeStalePendingChats() {
    let changed = false;
    for (const c of chats) {
      if (!c.pending) continue;
      if (!Array.isArray(c.messages)) c.messages = [];
      const msgs = c.messages;
      const last = msgs[msgs.length - 1];
      if (last?.role === 'user' && String(last.content || '').trim()) {
        c.pending = false;
        c.pendingStatus = '';
        msgs.push({
          role: 'assistant',
          content:
            'No response was saved for the previous in-flight request. Send again if you still need a reply.',
        });
        c.updatedAt = Date.now();
        changed = true;
      }
    }
    return changed;
  }

  async function pollAgentConversationsFromDiskOnce() {
    if (!projectPath || !storageApi?.loadAgentConversations) return false;
    const disk = normalizeStoredChats(await storageApi.loadAgentConversations(projectPath));
    let changed = false;
    for (const local of chats) {
      const remote = disk.conversations.find((x) => x.id === local.id);
      if (remote && mergeRemoteConversationIntoLocal(local, remote)) changed = true;
    }
    return changed;
  }

  function startPendingResolutionLoop() {
    stopPendingPoll();
    if (!projectPath || !storageApi?.loadAgentConversations) return;
    if (!chats.some((c) => c.pending === true)) return;

    const maxTicks = 700;
    let tick = 0;

    const step = async () => {
      pendingPollTimeout = null;
      if (!overlay.isConnected) return;
      if (!chats.some((c) => c.pending === true)) return;

      tick += 1;
      try {
        const changed = await pollAgentConversationsFromDiskOnce();
        if (changed && overlay.isConnected) {
          chats = sortChatsByRecent(chats);
          syncActiveChatUI();
          saveConversations();
        }
      } catch (e) {
        console.error('Agent conversations poll:', e);
      }

      if (!overlay.isConnected) return;
      if (!chats.some((c) => c.pending === true)) return;
      if (tick >= maxTicks) {
        if (finalizeStalePendingChats() && overlay.isConnected) {
          chats = sortChatsByRecent(chats);
          syncActiveChatUI();
          saveConversations();
        }
        return;
      }
      pendingPollTimeout = setTimeout(step, 600);
    };

    pendingPollTimeout = setTimeout(step, 350);
  }

  function saveConversations() {
    if (!projectPath || !storageApi?.saveAgentConversations) return;
    const payload = buildSavePayload();
    saveChain = saveChain
      .catch(() => {})
      .then(() => storageApi.saveAgentConversations(projectPath, payload))
      .catch((error) => {
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

  function close() {
    stopPendingPoll();
    chatSession?.destroy?.();
    chatSession = null;
    overlay.remove();
    document.removeEventListener('keydown', onKeyDown);
    try {
      onClose?.();
    } catch (error) {
      console.error('Agent window onClose callback:', error);
    }
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
  document.addEventListener('keydown', onKeyDown);
  document.body.appendChild(overlay);
  try {
    onOpen?.();
  } catch (error) {
    console.error('Agent window onOpen callback:', error);
  }
  chatSession = mountAgentChatSession({
    overlay,
    messagesEl,
    inputEl: composerInputEl,
    sendButtonEl: composerSendEl,
    autoResizeComposer,
    getWorkflowSnapshot,
    inspectNode,
    addRunNode,
    addScoreNode,
    updateScoreNode,
    updateScoreRowSelection,
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
    addProcessNode,
    importPubmedDataset,
    importClinicaltrialsDataset,
    importPreprintDataset,
    importChemblDataset,
    onConversationDraftChanged: () => {
      saveConversations();
    },
    resolveConversation: (conversationId) =>
      chats.find((chat) => chat.id === String(conversationId || '').trim()) || null,
    onConversationUpdated: () => {
      chats = sortChatsByRecent(chats);
      saveConversations();
      startPendingResolutionLoop();
      if (overlay.isConnected) syncActiveChatUI();
    },
  });
  syncActiveChatUI();
  startPendingResolutionLoop();
  setSidebarCollapsed(true);
  agentPaneToggle.update();
  autoResizeComposer();
}
