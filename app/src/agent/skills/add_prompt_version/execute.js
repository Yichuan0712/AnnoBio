import { addPromptVersionMeta } from './meta.js';

function safeLabel(args = {}) {
  const name = String(args?.name || '').trim();
  const promptNodeId = String(args?.prompt_node_id || args?.promptNodeId || '').trim();
  return name || promptNodeId || 'prompt version';
}

function describeEdits(args = {}) {
  const edits = Array.isArray(args?.edits) ? args.edits : [];
  if (edits.length === 0) return 'duplicate (no edits)';
  const counts = new Map();
  for (const edit of edits) {
    const op = String(edit?.op || 'unknown');
    counts.set(op, (counts.get(op) || 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([op, count]) => `${op} x${count}`)
    .join(', ');
}

export const addPromptVersionSkill = Object.freeze({
  meta: addPromptVersionMeta,
  getProgressLabel({ args = {} } = {}) {
    return `Creating prompt version ${safeLabel(args)} (${describeEdits(args)})...`;
  },
  summarizeResult({ result = null } = {}) {
    const name = String(result?.name || result?.requestedName || '').trim() || 'Prompt';
    const nodeId = String(result?.nodeId || '').trim();
    const editsApplied = Number.isFinite(Number(result?.editsApplied)) ? Number(result.editsApplied) : 0;
    const warnings = Array.isArray(result?.editWarnings) ? result.editWarnings : [];
    const parts = [];
    parts.push(nodeId ? `Created prompt version ${name}` : `Prepared prompt version ${name}`);
    parts.push(editsApplied > 0 ? `(applied ${editsApplied} edit op${editsApplied === 1 ? '' : 's'})` : '(duplicated source)');
    if (warnings.length > 0) parts.push(`warnings: ${warnings.join('; ')}`);
    return parts.join(' ');
  },
  execute({ args = {}, runtime = {} } = {}) {
    if (typeof runtime?.addPromptVersion !== 'function') {
      throw new Error('Prompt version runtime is unavailable.');
    }
    const promptNodeId = String(args?.prompt_node_id || args?.promptNodeId || '').trim();
    if (!promptNodeId) {
      throw new Error('Prompt node id is required.');
    }

    if (args?.sections != null || args?.outputFormat != null) {
      throw new Error(
        'add_prompt_version no longer accepts `sections` or `outputFormat` (whole-section replacement). Express changes as a list of small `edits` ops, or call `create_prompt_node` for a from-scratch rewrite.',
      );
    }

    const edits = Array.isArray(args?.edits) ? args.edits : (args?.edits != null ? args.edits : undefined);

    return runtime.addPromptVersion({
      promptNodeId,
      name: args?.name,
      note: args?.note,
      edits,
      left: Number.isFinite(Number(args?.left)) ? Number(args.left) : undefined,
      top: Number.isFinite(Number(args?.top)) ? Number(args.top) : undefined,
      ensureUniqueName: typeof args?.ensure_unique_name === 'boolean' ? args.ensure_unique_name : true,
    });
  },
});
