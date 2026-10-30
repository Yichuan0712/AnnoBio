/**
 * The Agent's create_project, offered only while no project is open. Web saves on the server;
 * desktop asks for a local file. The conversation then moves into the confirmed project.
 */

const MAX_NAME_CHARS = 80;

/** Validates a create_project call before its card is shown. */
export function previewCreateProject(args, runtime) {
  const name = String(args?.name || '').replace(/\s+/g, ' ').trim();
  if (!name) return { ok: false, error: 'Give the project a name.' };
  if (name.length > MAX_NAME_CHARS) return { ok: false, error: `Keep the project name within ${MAX_NAME_CHARS} characters.` };
  const serverStorage = runtime.projectStorage === 'server';
  if (runtime.hasProject?.()) return { ok: false, error: `A project is already open. ${serverStorage ? 'Use the project picker to create another one.' : 'The user creates another one with File → New.'}` };
  return {
    ok: true,
    name,
    items: [{
      kind: 'add',
      title: `Create project "${name}"`,
      lines: [serverStorage ? 'The project is saved automatically on the server.' : 'You choose where to save the project file.', 'This conversation moves into the new project.'],
    }],
  };
}

/**
 * Creates the confirmed project using the platform's storage and adopts its conversation.
 * @returns {Promise<{status: 'created', name: string, path?: string, projectId?: string, note: string} | {status: 'cancelled', feedback?: string} | {status: 'failed', error: string}>}
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
