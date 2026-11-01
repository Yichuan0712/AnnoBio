import './workspacePanels.css';
import { iconCollapse, iconMaximize, iconRestore } from './modalMaximize.js';

const STORAGE_KEY = 'annobio.workspacePanels.v1';

/**
 * Owns the layout only; panel contents stay mounted when collapsed. The bottom panel ("pipeline"
 * in saved state, for compatibility) has one tab per `bottomTabs` entry, each with its own
 * container from tabHost(); the right panel is a single dock with its own header.
 */
export function createWorkspacePanels(root, canvas, onChange, {
  bottomTabs = [{ id: 'pipeline', label: 'Pipeline' }],
  onCollapse = () => {},
  // Panels that start open on every load, whatever was saved when they were last closed.
  openOnLoad = [],
} = {}) {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; } catch (_) {}
  const state = {
    pipeline: openOnLoad.includes('pipeline') || saved.pipeline !== false,
    agent: openOnLoad.includes('agent') || saved.agent !== false,
    height: Number(saved.height) || 230,
    width: Number(saved.width) || 380,
    tab: bottomTabs.some((tab) => tab.id === saved.tab) ? saved.tab : bottomTabs[0].id,
  };
  let enabled = false;
  // Not persisted: a dock that reopened full-screen would hide the canvas on the next project load.
  let maximized = null;
  const element = document.createElement('div');
  element.className = 'workflow-workspace';
  const bottomHost = document.createElement('section');
  bottomHost.className = 'workspace-panel-host workspace-panel-host--pipeline';
  bottomHost.id = 'workspace-pipeline';
  bottomHost.setAttribute('aria-label', bottomTabs.map((tab) => tab.label).join(', '));
  const agentHost = document.createElement('aside');
  agentHost.className = 'workspace-panel-host workspace-panel-host--agent';
  agentHost.id = 'workspace-agent';
  agentHost.setAttribute('aria-label', 'Agent Assistant');
  element.append(canvas, bottomHost, agentHost);
  root.appendChild(element);
  const hosts = { pipeline: bottomHost, agent: agentHost };

  const header = document.createElement('div');
  header.className = 'workspace-panel-header';
  const tabButtons = new Map();
  const tabPanels = new Map();
  let tabList = null;
  if (bottomTabs.length > 1) {
    tabList = document.createElement('div');
    tabList.className = 'workspace-panel-tabs';
    tabList.setAttribute('role', 'tablist');
    header.appendChild(tabList);
  } else {
    const title = document.createElement('h2');
    title.className = 'workspace-panel-title';
    title.textContent = bottomTabs[0].label;
    header.appendChild(title);
  }
  for (const { id, label } of bottomTabs) {
    const panel = document.createElement('div');
    panel.className = 'workspace-panel-tab';
    panel.id = `workspace-tab-${id}`;
    tabPanels.set(id, panel);
    if (!tabList) continue;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'workspace-panel-tab-button';
    button.id = `workspace-tab-${id}-button`;
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-controls', panel.id);
    button.innerHTML = '<span></span><span class="workspace-panel-tab__badge" hidden></span>';
    button.firstChild.textContent = label;
    button.addEventListener('click', () => selectTab(id));
    tabList.appendChild(button);
    tabButtons.set(id, button);
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', button.id);
  }
  tabList?.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const ids = bottomTabs.map((tab) => tab.id);
    const next = ids[(ids.indexOf(state.tab) + (event.key === 'ArrowRight' ? 1 : ids.length - 1)) % ids.length];
    selectTab(next);
    tabButtons.get(next).focus();
  });
  const headerActions = document.createElement('div');
  headerActions.className = 'modal-header-actions';
  const collapseButton = document.createElement('button');
  collapseButton.type = 'button';
  collapseButton.className = 'modal-close';
  collapseButton.setAttribute('aria-label', 'Collapse panel');
  collapseButton.title = 'Collapse panel';
  collapseButton.appendChild(iconCollapse());
  collapseButton.addEventListener('click', () => {
    api.collapse('pipeline');
    onCollapse('pipeline');
  });
  headerActions.append(createMaximizeButton('pipeline'), collapseButton);
  header.appendChild(headerActions);
  bottomHost.append(header, ...tabPanels.values());

  function persist() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (_) {}
  }

  function limits(kind) {
    const rect = element.getBoundingClientRect();
    const maximum = kind === 'agent' ? Math.max(160, rect.width - 280) : Math.max(100, rect.height - 180);
    return { min: Math.min(kind === 'agent' ? 300 : 140, maximum), max: maximum };
  }

  function apply() {
    const width = limits('agent');
    const height = limits('pipeline');
    const agentWidth = Math.min(width.max, Math.max(width.min, state.width));
    const pipelineHeight = Math.min(height.max, Math.max(height.min, state.height));
    element.style.setProperty('--workspace-agent-width', `${enabled && state.agent ? agentWidth : 0}px`);
    element.style.setProperty('--workspace-pipeline-height', `${enabled && state.pipeline ? pipelineHeight : 0}px`);
    agentHost.hidden = !enabled || !state.agent;
    bottomHost.hidden = !enabled || !state.pipeline;
    for (const [id, panel] of tabPanels) {
      panel.hidden = id !== state.tab;
      const button = tabButtons.get(id);
      button?.setAttribute('aria-selected', String(id === state.tab));
      if (button) button.tabIndex = id === state.tab ? 0 : -1;
    }
    if (maximized && hosts[maximized].hidden) maximized = null;
    element.classList.toggle('workflow-workspace--maximized', Boolean(maximized));
    for (const [kind, host] of Object.entries(hosts)) {
      host.classList.toggle('workspace-panel-host--maximized', kind === maximized);
      syncMaximizeButton(kind);
    }
    for (const [kind, separator] of separators) {
      separator.hidden = hosts[kind].hidden || Boolean(maximized);
      const range = limits(kind);
      separator.setAttribute('aria-valuemin', String(Math.round(range.min)));
      separator.setAttribute('aria-valuemax', String(Math.round(range.max)));
      separator.setAttribute('aria-valuenow', String(Math.round(kind === 'agent' ? agentWidth : pipelineHeight)));
    }
  }

  const separators = ['pipeline', 'agent'].map((kind) => {
    const handle = document.createElement('div');
    handle.className = `workspace-panel-resizer workspace-panel-resizer--${kind}`;
    handle.tabIndex = 0;
    handle.setAttribute('role', 'separator');
    handle.setAttribute('aria-label', `Resize ${kind === 'agent' ? 'Agent Assistant' : 'bottom panel'}`);
    handle.setAttribute('aria-controls', `workspace-${kind}`);
    handle.setAttribute('aria-orientation', kind === 'agent' ? 'vertical' : 'horizontal');
    element.appendChild(handle);
    const property = kind === 'agent' ? 'width' : 'height';
    function resize(value) {
      const range = limits(kind);
      state[property] = Math.min(range.max, Math.max(range.min, value));
      apply();
    }
    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      handle.setPointerCapture(event.pointerId);
      const start = kind === 'agent' ? event.clientX : event.clientY;
      const initial = Number(handle.getAttribute('aria-valuenow'));
      element.classList.add('workflow-workspace--resizing');
      const move = (next) => resize(initial + start - (kind === 'agent' ? next.clientX : next.clientY));
      const finish = () => {
        element.classList.remove('workflow-workspace--resizing');
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('lostpointercapture', finish);
        persist();
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('lostpointercapture', finish);
    });
    handle.addEventListener('keydown', (event) => {
      const increase = kind === 'agent' ? 'ArrowLeft' : 'ArrowUp';
      const decrease = kind === 'agent' ? 'ArrowRight' : 'ArrowDown';
      if (event.key !== increase && event.key !== decrease) return;
      event.preventDefault();
      resize(Number(handle.getAttribute('aria-valuenow')) + (event.key === increase ? 20 : -20));
      persist();
    });
    handle.addEventListener('dblclick', () => { resize(kind === 'agent' ? 380 : 230); persist(); });
    return [kind, handle];
  });

  function createMaximizeButton(kind) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'modal-maximize';
    button.addEventListener('click', () => {
      maximized = maximized === kind ? null : kind;
      apply();
    });
    return button;
  }

  // The Agent dock renders its own header; full-screen is a layout concern, so its button is added
  // here, the same way modalMaximize.js adds one to every modal window.
  function ensureAgentMaximizeButton() {
    const close = agentHost.querySelector('.modal-header .modal-close');
    if (!close || agentHost.querySelector('.modal-maximize')) return;
    let actions = close.parentElement;
    if (!actions.classList.contains('modal-header-actions')) {
      actions = document.createElement('div');
      actions.className = 'modal-header-actions';
      close.replaceWith(actions);
      actions.appendChild(close);
    }
    actions.insertBefore(createMaximizeButton('agent'), close);
    syncMaximizeButton('agent');
  }
  new MutationObserver(ensureAgentMaximizeButton).observe(agentHost, { childList: true });

  function syncMaximizeButton(kind) {
    const button = hosts[kind].querySelector('.modal-maximize');
    const isMaximized = maximized === kind;
    if (!button || button.dataset.maximized === String(isMaximized)) return;
    button.dataset.maximized = String(isMaximized);
    button.replaceChildren(isMaximized ? iconRestore() : iconMaximize());
    button.setAttribute('aria-label', isMaximized ? 'Restore size' : 'Maximize');
    button.title = isMaximized ? 'Restore size' : 'Maximize';
  }

  function notify() {
    apply();
    onChange({ pipeline: enabled && state.pipeline, agent: enabled && state.agent, tab: state.tab });
  }

  function selectTab(id) {
    if (!tabPanels.has(id) || id === state.tab) return;
    state.tab = id;
    persist();
    notify();
  }

  new ResizeObserver(apply).observe(element);
  apply();
  const api = {
    element, agentHost,
    pipelineHost: tabPanels.get('pipeline'),
    tabHost: (id) => tabPanels.get(id),
    selectTab,
    /** Shows `count` beside the tab's label; 0 hides it. */
    setTabBadge(id, count) {
      const badge = tabButtons.get(id)?.querySelector('.workspace-panel-tab__badge');
      if (!badge) return;
      badge.hidden = !count;
      badge.textContent = count > 99 ? '99+' : String(count);
    },
    setEnabled(value) { enabled = value; notify(); },
    toggle(kind) { state[kind] = !state[kind]; persist(); notify(); },
    show(kind) { if (!state[kind]) { state[kind] = true; persist(); } notify(); },
    collapse(kind) { state[kind] = false; persist(); notify(); },
  };
  return api;
}
