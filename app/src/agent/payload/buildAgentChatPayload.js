export function serializeAgentObservations(observations) {
  if (!Array.isArray(observations) || observations.length === 0) {
    return [];
  }
  return observations.map((observation) => ({
    skill_name: String(observation?.skill_name || observation?.skillName || '').trim(),
    args: observation?.args && typeof observation.args === 'object' && !Array.isArray(observation.args)
      ? observation.args
      : {},
    ok: observation?.ok !== false,
    summary: String(observation?.summary || '').trim(),
    result: observation?.result ?? null,
  }));
}

export function buildAgentChatPayload({
  credentialId,
  messages,
  workflowSnapshot = null,
  observations = [],
  nodeInspection = null,
  agentTrace = [],
} = {}) {
  const payload = {
    credential_id: String(credentialId || '').trim(),
    messages: Array.isArray(messages) ? messages : [],
  };

  if (workflowSnapshot && typeof workflowSnapshot === 'object') {
    payload.workflow_snapshot = workflowSnapshot;
  }
  if (Array.isArray(observations) && observations.length > 0) {
    payload.observations = serializeAgentObservations(observations);
  }
  if (nodeInspection && typeof nodeInspection === 'object') {
    payload.node_inspection = nodeInspection;
  }
  if (Array.isArray(agentTrace) && agentTrace.length > 0) {
    payload.agent_trace = agentTrace.map((item) => String(item || '').trim()).filter(Boolean);
  }

  return payload;
}
