/**
 * The tools a local coding agent may call through the Local Agent Bridge (docs/design/LOCAL_AGENT_BRIDGE_DESIGN.md),
 * run in the renderer exactly as the built-in Agent runs them: the same definitions (AGENT_TOOL_DEFINITIONS), the
 * same executeAgentTool, and the same runtime pieces (canvas state, node inspector, workspace summary).
 *
 * B1 offers the read-only tools and try_process. Tools that change the canvas, spend money or need a decision
 * (propose_changes, run_nodes, pipeline_action, ask_user) arrive in B2 with confirmation cards; local-file tools
 * are not offered to external agents (they can read files themselves).
 */
import { AGENT_TOOL_DEFINITIONS, executeAgentTool } from '../agent/tools/agentTools.js';
import { buildWorkspaceSummary } from '../agent/context/workspaceSummary.js';
import { BACKEND_API_BASE } from '../backendConfig.js';

export const BRIDGE_TOOL_NAMES = new Set([
  'get_workspace', 'inspect_node', 'read_rows', 'trace_row', 'list_models', 'read_guide',
  'search_source', 'inspect_source', 'web_search', 'read_webpage', 'try_process',
]);

/** Tools that work with no project open (as for the built-in Agent). */
const NO_PROJECT_TOOLS = new Set(['list_models', 'read_guide', 'search_source', 'inspect_source', 'web_search', 'read_webpage']);

/** MCP tool descriptors for the bridge's tools, taken from the built-in Agent's definitions. */
export function bridgeToolDefinitions(definitions = AGENT_TOOL_DEFINITIONS) {
  return definitions
    .filter((definition) => BRIDGE_TOOL_NAMES.has(definition.function.name))
    .map((definition) => ({
      name: definition.function.name,
      description: definition.function.description,
      inputSchema: definition.function.parameters || { type: 'object', properties: {} },
    }));
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

/**
 * @param {() => object} getWorkspace the canvas's Agent workspace (the object the Agent panel is mounted with)
 * @param {{fetchImpl?: typeof fetch, execute?: typeof executeAgentTool}} [options]
 */
export function createBridgeToolHost(getWorkspace, { fetchImpl = (...a) => fetch(...a), execute = executeAgentTool } = {}) {
  async function buildRuntime(signal) {
    const workspace = getWorkspace();
    const { credentialsById, defaultRunCredential, defaultReviewCredential } = await loadCredentialContext(fetchImpl);
    const inspectNode = (nodeId, readOptions = {}) =>
      workspace.inspectNode(nodeId, { credentialsById, defaultRunCredential, ...readOptions });
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

  return {
    listTools: () => bridgeToolDefinitions(),
    /** @returns {Promise<{ok: boolean, content: string}>} */
    async callTool(name, args) {
      if (!BRIDGE_TOOL_NAMES.has(name)) {
        return { ok: false, content: JSON.stringify({ error: `${name} is not available to external agents in this version. Ask the user to do it in AnnoBio.` }) };
      }
      const workspace = getWorkspace();
      if (!workspace) return { ok: false, content: JSON.stringify({ error: 'AnnoBio is still starting; try again in a moment.' }) };
      if (workspace.hasProject?.() === false && !NO_PROJECT_TOOLS.has(name)) {
        return { ok: false, content: JSON.stringify({ error: 'No project is open in AnnoBio. Ask the user to open or create one.' }) };
      }
      const controller = new AbortController();
      return execute(name, args && typeof args === 'object' ? args : {}, await buildRuntime(controller.signal));
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
