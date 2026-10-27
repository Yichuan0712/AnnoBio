/**
 * The Agent's create_project, offered only while no project is open (the desktop app,
 * docs/design/AGENT_NO_PROJECT_PLAN.md). The user confirms on a card and picks where to save, as with
 * File → New; the conversation then moves into the new project (agentWindowModal.js's adoptProject).
 */

const MAX_NAME_CHARS = 80;

/** Validates a create_project call before its card is shown. */
export function previewCreateProject(args, runtime) {
  const name = String(args?.name || '').replace(/\s+/g, ' ').trim();
  if (!name) return { ok: false, error: 'Give the project a name.' };
  if (name.length > MAX_NAME_CHARS) return { ok: false, error: `Keep the project name within ${MAX_NAME_CHARS} characters.` };
  if (runtime.hasProject?.()) return { ok: false, error: 'A project is already open. The user creates another one with File → New.' };
  return {
    ok: true,
    name,
    items: [{
      kind: 'add',
      title: `Create project "${name}"`,
      lines: ['You choose where to save the project file.', 'This conversation moves into the new project.'],
    }],
  };
}

/**
 * Creates the project the user confirmed; `runtime.createProject` asks where to save it.
 * @returns {Promise<{status: 'created', name: string, path: string, note: string} | {status: 'cancelled', feedback?: string} | {status: 'failed', error: string}>}
 */
export async function executeCreateProject(request, runtime, conversationId) {
  const preview = previewCreateProject(request, runtime);
  if (!preview.ok) return { status: 'failed', error: preview.error };
  const result = await runtime.createProject({ name: preview.name, adoptAgentConversationId: conversationId });
  if (result?.status !== 'created') return result || { status: 'failed', error: 'The project was not created.' };
  return {
    ...result,
    note: 'The project is open and this conversation is now part of it. Every tool is available; the workspace below is the new, empty project.',
  };
}
