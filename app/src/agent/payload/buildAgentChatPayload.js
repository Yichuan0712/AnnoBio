export function buildAgentChatPayload({ credentialId, messages, workflowSnapshot = null, nodeInspection = null } = {}) {
  const payload = {
    credential_id: String(credentialId || '').trim(),
    messages: Array.isArray(messages) ? messages : [],
  };

  if (workflowSnapshot && typeof workflowSnapshot === 'object') {
    payload.workflow_snapshot = workflowSnapshot;
  }
  if (nodeInspection && typeof nodeInspection === 'object') {
    payload.node_inspection = nodeInspection;
  }

  return payload;
}
