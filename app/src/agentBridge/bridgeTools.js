/**
 * The tools a local coding agent may call through the Local Agent Bridge (docs/design/LOCAL_AGENT_BRIDGE_DESIGN.md),
 * run in the renderer exactly as the built-in Agent runs them: the same definitions (AGENT_TOOL_DEFINITIONS), the
 * same executeAgentTool, and the same preview / apply functions behind the built-in Agent's cards.
 *
 * Read-only tools and try_process run at once. Changing the canvas, running nodes, Pipeline actions and creating a
 * project go in two steps, with the user's confirmation in the coding agent's own chat (user decision 2026-11-08):
 * propose_changes / run_nodes / pipeline_action / create_project only preview (nothing changes, nothing is spent) and
 * return a preview_id; apply(preview_id) then does exactly what that preview showed, refusing if a fresh preview of
 * the same request no longer matches (the project changed). apply carries destructiveHint so clients ask before it.
 * ask_user is not offered (the coding agent asks in its own chat); local-file tools are not offered (it reads files
 * itself).
 */
import { AGENT_TOOL_DEFINITIONS, CREATE_PROJECT_TOOL, PIPELINE_ACTION_TOOL, PROPOSE_CHANGES_TOOL, RUN_NODES_TOOL, agentToolDefinitions, executeAgentTool } from '../agent/tools/agentTools.js';
import { buildWorkspaceSummary } from '../agent/context/workspaceSummary.js';
import { createProposalRuntime } from '../agent/operations/proposals.js';
import { executeRunRequest, previewRunRequest } from '../agent/execution/runJobs.js';
import { executePipelineAction, previewPipelineAction } from '../agent/pipeline/pipelineActions.js';
import { executeCreateProject, previewCreateProject } from '../agent/project/createProject.js';
import { BACKEND_API_BASE } from '../backendConfig.js';

export const APPLY_TOOL = 'apply';
export const APPLY_STATUS_TOOL = 'apply_status';

const READ_TOOLS = ['get_workspace', 'inspect_node', 'read_rows', 'trace_row', 'list_models', 'read_guide',
  'search_source', 'inspect_source', 'web_search', 'read_webpage', 'try_process'];

/** Preview tools and the kind of preview each makes. */
const PREVIEW_KINDS = {
  [PROPOSE_CHANGES_TOOL]: 'proposal',
  [RUN_NODES_TOOL]: 'run',
  [PIPELINE_ACTION_TOOL]: 'pipeline',
  [CREATE_PROJECT_TOOL]: 'project',
};

export const BRIDGE_TOOL_NAMES = new Set([...READ_TOOLS, ...Object.keys(PREVIEW_KINDS), APPLY_TOOL, APPLY_STATUS_TOOL]);

/** Tools that work with no project open, as for the built-in Agent (get_workspace then says no project is open and
 * lists the models; create_project is only for that case). */
const NO_PROJECT_TOOLS = new Set(['get_workspace', 'list_models', 'read_guide', 'search_source', 'inspect_source',
  'web_search', 'read_webpage', CREATE_PROJECT_TOOL, APPLY_TOOL, APPLY_STATUS_TOOL]);

const PREVIEW_TTL_MS = 30 * 60 * 1000;
const MAX_PREVIEWS = 30;
/** How long apply waits for the action to finish before answering "running" (the main process gives up on a
 * request after 120 s). */
const APPLY_WAIT_MS = 45000;

const PREVIEW_NOTE = 'Through AnnoBio\'s bridge this tool only PREVIEWS: nothing changes and nothing is spent. It '
  + 'returns a preview_id and what would happen (with the estimated cost for runs). Show that to the user, ask whether '
  + 'to go ahead, and call apply with the preview_id only after they agree. Where the text below mentions a card, the '
  + 'user confirms in this chat instead.\n\n';

const APPLY_DEFINITION = {
  name: APPLY_TOOL,
  description: 'Carry out a preview the user has agreed to: the changes, runs, Pipeline action or new project it '
    + 'showed, exactly as previewed. Call it only after showing the user the preview and getting their yes in this chat. '
    + 'AnnoBio refuses if the project changed since the preview (preview again and ask again). Runs spend money on the '
    + 'models in the user\'s credentials. If the action is still going after about 45 seconds, the result says '
    + '"running"; check it with apply_status. Each preview_id can be applied once.',
  inputSchema: {
    type: 'object',
    properties: { preview_id: { type: 'string', description: 'The preview_id from propose_changes, run_nodes, pipeline_action or create_project.' } },
    required: ['preview_id'],
    additionalProperties: false,
  },
  annotations: { title: 'Apply a confirmed preview', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
};

const APPLY_STATUS_DEFINITION = {
  name: APPLY_STATUS_TOOL,
  description: 'Check an action started with apply: whether it is still running (with its latest progress) or how it '
    + 'ended. Without preview_id, reports the action that is running now, if any.',
  inputSchema: {
    type: 'object',
    properties: { preview_id: { type: 'string', description: 'The preview_id passed to apply.' } },
    additionalProperties: false,
  },
  annotations: { title: 'Check an applied action', readOnlyHint: true },
};

/** MCP tool descriptors for the bridge's tools, taken from the built-in Agent's definitions. */
export function bridgeToolDefinitions(definitions = AGENT_TOOL_DEFINITIONS) {
  const byName = new Map([...agentToolDefinitions({ projectOpen: false }), ...definitions].map((d) => [d.function.name, d.function]));
  const read = READ_TOOLS.filter((name) => byName.has(name)).map((name) => ({
    name,
    description: byName.get(name).description,
    inputSchema: byName.get(name).parameters || { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  }));
  const previews = Object.keys(PREVIEW_KINDS).filter((name) => byName.has(name)).map((name) => ({
    name,
    description: PREVIEW_NOTE + byName.get(name).description,
    inputSchema: byName.get(name).parameters,
    annotations: { title: `Preview: ${name.replace(/_/g, ' ')}`, readOnlyHint: true },
  }));
  return [...read, ...previews, APPLY_DEFINITION, APPLY_STATUS_DEFINITION];
}

async function loadCredentialContext(fetchImpl) {
  const [credentials, settings] = await Promise.all([
    fetchImpl(`${BACKEND_API_BASE}/api/credentials`).then((res) => (res.ok ? res.json() : [])).catch(() => []),
    fetchImpl(`${BACKEND_API_BASE}/api/settings`).then((res) => (res.ok ? res.json() : null)).catch(() => null),
  ]);
  const credentialsById = new Map((Array.isArray(credentials) ? credentials : []).map((c) => [c.id, c]));
  const defaultRunCredential = credentialsById.get(String(settings?.default_run_credential_id || '').trim()) || null;
  const defaultReviewCredential = credentialsById.get(String(settings?.default_review_credential_id || '').trim()) || null;
  return { credentialsById, defaultRunCredential, defaultReviewCredential };
}

/** The built-in Agent's preview / execute functions over a workspace (agentChatSession.js buildToolRuntime). */
function defaultActions(workspace, { credentialsById, inspectNode }) {
  const proposalWorkspace = { ...workspace, credentialsById };
  const runWorkspace = { ...workspace, credentialsById, inspectNode };
  const proposals = createProposalRuntime(proposalWorkspace);
  return {
    preview: {
      proposal: (request) => proposals.previewProposal(request),
      run: (request) => previewRunRequest(request, runWorkspace),
      pipeline: (request) => previewPipelineAction(request, workspace),
      // No built-in Agent conversation moves into the project, so the card's line saying so is left out.
      project: (request) => {
        const preview = previewCreateProject(request, workspace);
        return preview.ok
          ? { ...preview, items: preview.items.map((item) => ({ ...item, lines: item.lines.filter((line) => !/conversation moves/i.test(line)) })) }
          : preview;
      },
    },
    execute: {
      proposal: (request, preview, options) => proposals.applyProposal(request, { ...options, importSnapshots: preview.importSnapshots }),
      run: (request, preview, options) => executeRunRequest(request, runWorkspace, { ...options, approvedPreview: preview }),
      pipeline: (request, preview) => executePipelineAction(request, preview, workspace),
      // '': no built-in Agent conversation moves into the new project.
      project: (request) => executeCreateProject(request, workspace, ''),
    },
  };
}

const SUCCESS = { proposal: ['applied'], run: ['completed'], pipeline: ['renamed', 'exported'], project: ['created'] };

const json = (value) => JSON.stringify(value);
const fail = (error) => ({ ok: false, content: json({ error }) });
/** What the user is shown of a preview, and what must still match when it is applied. */
const shownItems = (items) => (items || []).map(({ title, lines, diffs }) => ({ title, lines, ...(diffs?.length ? { diffs } : {}) }));
const isStopOnly = (entry) => entry.kind === 'run' && (entry.request?.jobs || []).every((job) => job?.kind === 'stop');

let previewCounter = 0;
function newPreviewId(kind) {
  previewCounter += 1;
  const random = globalThis.crypto?.randomUUID?.().slice(0, 8) || Math.random().toString(16).slice(2, 10);
  return `${kind}-${previewCounter}-${random}`;
}

/**
 * @param {() => object} getWorkspace the canvas's Agent workspace (the object the Agent panel is mounted with)
 * @param {{fetchImpl?: typeof fetch, execute?: typeof executeAgentTool, actions?: Function, now?: () => number, applyWaitMs?: number}} [options]
 *   actions(workspace, context) returns {preview, execute} by kind (tests replace it).
 */
export function createBridgeToolHost(getWorkspace, {
  fetchImpl = (...a) => fetch(...a),
  execute = executeAgentTool,
  actions = defaultActions,
  now = () => Date.now(),
  applyWaitMs = APPLY_WAIT_MS,
} = {}) {
  /** preview_id -> {kind, request, preview, projectIdentity, createdAt} */
  const previews = new Map();
  /** preview_id -> {kind, summary, status: 'running'|'done', progress, result, startedAt} */
  const applied = new Map();

  async function buildContext() {
    const workspace = getWorkspace();
    const { credentialsById, defaultRunCredential, defaultReviewCredential } = await loadCredentialContext(fetchImpl);
    const inspectNode = (nodeId, readOptions = {}) =>
      workspace.inspectNode(nodeId, { credentialsById, defaultRunCredential, ...readOptions });
    return { workspace, credentialsById, defaultRunCredential, defaultReviewCredential, inspectNode };
  }

  async function buildRuntime(signal) {
    const { workspace, credentialsById, defaultRunCredential, defaultReviewCredential, inspectNode } = await buildContext();
    const buildSummary = () => buildWorkspaceSummary(workspace.getCanvasState(), {
      extractInputFields: workspace.extractInputFields,
      inspectNode,
      credentialsById,
      defaultRunCredential,
      defaultReviewCredential,
      selectedNodeIds: workspace.getSelectedNodeIds?.() || [],
      pipelineSelections: workspace.getPipelineSelections?.() || [],
      projectOpen: workspace.hasProject?.() !== false,
      projectPath: workspace.getCurrentProjectPath?.() || '',
      folderAccessTool: false,  // external agents have no request_folder_access
    });
    return {
      getCanvasState: workspace.getCanvasState,
      inspectNode,
      getScoreComparisonRows: workspace.getScoreComparisonRows,
      buildSummary,
      signal,
    };
  }

  function prune() {
    for (const [id, entry] of previews) if (now() - entry.createdAt > PREVIEW_TTL_MS) previews.delete(id);
    while (previews.size > MAX_PREVIEWS) previews.delete(previews.keys().next().value);
  }

  const running = () => [...applied.entries()].find(([, job]) => job.status === 'running');

  async function makePreview(name, args) {
    const kind = PREVIEW_KINDS[name];
    const context = await buildContext();
    let preview;
    try {
      preview = await actions(context.workspace, context).preview[kind](args);
    } catch (error) {
      preview = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    if (!preview?.ok) return fail(`Not previewed: ${preview?.error || 'invalid request'}. Fix the request and preview again.`);
    prune();
    const id = newPreviewId(kind);
    previews.set(id, { kind, request: args, preview, projectIdentity: context.workspace.getAssetProjectId?.() ?? null, createdAt: now() });
    return {
      ok: true,
      content: json({
        preview_id: id,
        summary: String(args.summary || ''),
        what_will_happen: shownItems(preview.items),
        ...(preview.total ? { estimate: preview.total } : {}),
        ...(preview.warnings?.length ? { warnings: preview.warnings } : {}),
        nothing_changed_yet: true,
        next: `Show the user what will happen${preview.total ? ' and the estimate' : ''}, ask whether to go ahead, and call apply with this preview_id only if they agree.`,
      }),
    };
  }

  function jobResult(id, job) {
    if (job.status === 'running') {
      return { ok: true, content: json({ preview_id: id, status: 'running', progress: job.progress, note: 'Still running in AnnoBio. Check again with apply_status; the user can also stop it on the canvas.' }) };
    }
    return { ok: SUCCESS[job.kind].includes(job.result?.status), content: json({ preview_id: id, ...job.result }) };
  }

  async function apply(args) {
    const id = String(args?.preview_id || '').trim();
    prune();
    if (applied.has(id)) return fail('This preview was already applied; each preview_id is applied once. Use apply_status to see how it went.');
    const entry = previews.get(id);
    if (!entry) return fail('Unknown or expired preview_id (previews last 30 minutes). Preview again and ask the user again.');
    const busy = running();
    if (busy && !isStopOnly(entry)) return fail(`Another applied action (${busy[0]}) is still running. Wait for it with apply_status, or preview a run_nodes stop job.`);
    const context = await buildContext();
    const { workspace } = context;
    if (entry.kind !== 'project' && workspace.hasProject?.() === false) return fail('No project is open in AnnoBio any more, so nothing was applied.');
    if ((workspace.getAssetProjectId?.() ?? null) !== entry.projectIdentity) return fail('A different project is open in AnnoBio now, so nothing was applied. Preview again.');
    const kindActions = actions(workspace, context);
    let fresh;
    try {
      fresh = await kindActions.preview[entry.kind](entry.request);
    } catch (error) {
      fresh = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    if (!fresh?.ok || json(shownItems(fresh.items)) !== json(shownItems(entry.preview.items))) {
      previews.delete(id);
      return fail('The project changed since this preview, so nothing was applied. Preview again and show the user what would happen now.'
        + (fresh?.ok ? '' : ` (${fresh?.error || 'the request is no longer valid'})`));
    }
    previews.delete(id);
    const job = { kind: entry.kind, summary: String(entry.request?.summary || ''), status: 'running', progress: 'Starting...', result: null, startedAt: now() };
    applied.set(id, job);
    const controller = new AbortController();
    const done = Promise.resolve()
      .then(() => kindActions.execute[entry.kind](entry.request, entry.preview, { signal: controller.signal, onStatus: (text) => { job.progress = String(text || ''); } }))
      .then((result) => result || { status: 'failed', error: 'No result.' })
      .catch((error) => ({ status: 'failed', error: error instanceof Error ? error.message : String(error) }))
      .then((result) => {
        job.result = result;
        job.status = 'done';
      });
    let timer;
    await Promise.race([done, new Promise((resolve) => { timer = setTimeout(resolve, applyWaitMs); })]);
    clearTimeout(timer);
    return jobResult(id, job);
  }

  function applyStatus(args) {
    const id = String(args?.preview_id || '').trim();
    if (!id) {
      const busy = running();
      return busy ? jobResult(busy[0], busy[1]) : { ok: true, content: json({ status: 'idle', note: 'No applied action is running.' }) };
    }
    const job = applied.get(id);
    if (!job) return fail(previews.has(id) ? 'This preview has not been applied.' : 'Unknown preview_id.');
    return jobResult(id, job);
  }

  return {
    listTools: () => bridgeToolDefinitions(),
    /** @returns {Promise<{ok: boolean, content: string}>} */
    async callTool(name, args) {
      if (!BRIDGE_TOOL_NAMES.has(name)) {
        return fail(`${name} is not available to external agents. Ask the user to do it in AnnoBio.`);
      }
      const workspace = getWorkspace();
      if (!workspace) return fail('AnnoBio is still starting; try again in a moment.');
      if (workspace.hasProject?.() === false && !NO_PROJECT_TOOLS.has(name)) {
        return fail('This needs a project, and none is open in AnnoBio. Ask the user to open one, or preview create_project; without a project you can still use get_workspace, list_models, read_guide, search_source, inspect_source, web_search and read_webpage.');
      }
      const input = args && typeof args === 'object' ? args : {};
      if (PREVIEW_KINDS[name]) return makePreview(name, input);
      if (name === APPLY_TOOL) return apply(input);
      if (name === APPLY_STATUS_TOOL) return applyStatus(input);
      const controller = new AbortController();
      return execute(name, input, await buildRuntime(controller.signal));
    },
  };
}

/**
 * Answers the main process's bridge requests (desktop only). Each request is {id, kind: 'list'|'call', name, args};
 * the answer goes back through electronAPI.respondAgentBridge.
 * @param {() => object} getWorkspace
 */
export function installAgentBridge(getWorkspace, api = window.electronAPI) {
  if (!api?.onAgentBridgeRequest || !api?.respondAgentBridge) return () => {};
  const host = createBridgeToolHost(getWorkspace);
  return api.onAgentBridgeRequest(async (request) => {
    let result;
    try {
      result = request.kind === 'list' ? host.listTools() : await host.callTool(String(request.name || ''), request.args);
    } catch (error) {
      result = { ok: false, content: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) };
    }
    api.respondAgentBridge(request.id, result);
  });
}
