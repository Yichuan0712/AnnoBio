/**
 * The Agent's tool-calling loop. The model streams a response; any tool calls it makes are executed
 * here and their results appended, and the model is called again, until it answers without tools or
 * calls a tool only the user can answer: ask_user (a question), propose_changes (a change proposal
 * to apply or reject), run_nodes (jobs to start or cancel), pipeline_action, or create_project (with
 * no project open). That ends the loop until the user responds.
 *
 * Conversation messages are stored in this shape and converted to OpenAI format per request:
 *   {role: 'user', content, attachments?: [{id, name, path, kind, size, preview}]}
 *   {role: 'assistant', content, toolCalls?: [{id, name, arguments, preview?}]}
 *   {role: 'tool', toolCallId, name, content, ok, label, answer?, outcome?}
 * preview is the validated proposal or run request the card shows; answer/outcome record how the
 * user responded. A user attachment's preview is what the model saw of the file (attachmentContent.js).
 */
import { fetchAgentContext, streamAgentTurn } from './api/agentTurnClient.js';
import {
  agentToolDefinitions,
  ASK_USER_TOOL,
  CREATE_PROJECT_TOOL,
  REQUEST_FOLDER_ACCESS_TOOL,
  PROPOSE_CHANGES_TOOL,
  RUN_NODES_TOOL,
  PIPELINE_ACTION_TOOL,
  USER_TOOLS,
  describeToolCall,
  executeAgentTool,
} from './tools/agentTools.js';
import { attachmentsMessageText } from './attachments/attachmentContent.js';
import { historyTokenBudget, planHistory } from './historyBudget.js';
import { summarizeHistory } from './historySummary.js';

const MAX_TOOL_CALLS_PER_TURN = 30;
const MAX_TURN_MS = 5 * 60 * 1000;
const BUDGET_EXHAUSTED = JSON.stringify({
  error: 'The tool budget for this message is used up. Answer now with the information you already have, and say what you could not check.',
});
const INVALID_ARGUMENTS = 'The arguments were not valid JSON.';
// A reply that hits the output token limit cuts its tool call's arguments off mid-JSON; without
// saying so the model tends to send the same oversized call again.
const TRUNCATED_ARGUMENTS = 'The arguments were cut off because the reply reached the output token limit. Send less in one call: fewer operations per proposal or jobs per request, or shorter code.';
const TRUNCATING_FINISH_REASONS = new Set(['length', 'max_tokens']);

/** OpenAI-format messages. A tool call left without a result (an interrupted turn) gets a
 * placeholder one, since providers reject a call that is never answered. */
export function toApiMessages(messages) {
  const answered = new Set(messages.filter((m) => m.role === 'tool').map((m) => m.toolCallId));
  const out = [];
  for (const m of messages) {
    if (m.role === 'tool') {
      const local = m.attachments?.length ? attachmentsMessageText(m.attachments) : '';
      out.push({ role: 'tool', tool_call_id: m.toolCallId, content: [m.content, local].filter(Boolean).join('\n\n') });
      continue;
    }
    if (m.role === 'assistant' && m.toolCalls?.length) {
      out.push({
        role: 'assistant',
        content: m.content || null,
        ...(m.reasoningContent != null ? { reasoning_content: m.reasoningContent } : {}),
        tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })),
      });
      for (const c of m.toolCalls) {
        if (!answered.has(c.id)) out.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify({ error: 'No result was recorded for this call.' }) });
      }
      continue;
    }
    // A user message's attachments reach the model as their previews, after the text.
    const attached = m.role === 'user' ? attachmentsMessageText(m.attachments) : '';
    out.push({ role: m.role, content: [m.content || '', attached].filter(Boolean).join('\n\n'),
      ...(m.role === 'assistant' && m.reasoningContent != null ? { reasoning_content: m.reasoningContent } : {}) });
  }
  return out;
}

function parseArguments(raw) {
  try {
    const parsed = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (_) {
    return null;
  }
}

/**
 * The first question, proposal or run request still waiting for the user at the end of the
 * conversation: {kind: 'question', toolCallId, question, options}, or {kind: 'proposal' | 'run' | 'pipeline',
 * toolCallId, summary, request, preview} where request is the call's arguments.
 */
export function findPendingInteraction(messages) {
  const answered = new Set(messages.filter((m) => m.role === 'tool').map((m) => m.toolCallId));
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m.role === 'user') return null;
    if (m.role !== 'assistant') continue;
    const call = (m.toolCalls || []).find((c) => USER_TOOLS.has(c.name) && !answered.has(c.id) && (c.name === ASK_USER_TOOL || c.preview));
    if (!call) return null;
    const args = parseArguments(call.arguments) || {};
    if (call.name === ASK_USER_TOOL) {
      return {
        kind: 'question',
        toolCallId: call.id,
        question: String(args.question || ''),
        options: Array.isArray(args.options) ? args.options.map(String).filter(Boolean) : [],
      };
    }
    return {
      kind: { [RUN_NODES_TOOL]: 'run', [PIPELINE_ACTION_TOOL]: 'pipeline', [CREATE_PROJECT_TOOL]: 'project', [REQUEST_FOLDER_ACCESS_TOOL]: 'folder' }[call.name] || 'proposal',
      toolCallId: call.id,
      summary: String(args.summary || ''),
      request: args,
      preview: call.preview,
    };
  }
  return null;
}

/** Record the user's reply to a pending question. */
export function answerQuestion(messages, question, answer) {
  messages.push({
    role: 'tool',
    toolCallId: question.toolCallId,
    name: ASK_USER_TOOL,
    content: JSON.stringify({ answer }),
    ok: true,
    label: question.question,
    answer,
  });
}

/**
 * Record what happened to a pending proposal.
 * @param {{status: 'applied' | 'rejected' | 'failed'}} result the tool result the model sees
 */
export function resolveProposal(messages, proposal, result) {
  messages.push({
    role: 'tool',
    toolCallId: proposal.toolCallId,
    name: PROPOSE_CHANGES_TOOL,
    content: JSON.stringify(result),
    ok: result.status === 'applied',
    label: proposal.summary,
    outcome: result.status === 'applied'
      ? 'Applied'
      : result.status === 'rejected'
        ? `Rejected${result.feedback ? `: ${result.feedback}` : ''}`
        : `Could not apply: ${result.error}`,
  });
}

/**
 * Record what happened to a pending run request.
 * @param {{status: 'completed' | 'stopped' | 'failed' | 'cancelled', results?: string[]}} result
 */
export function resolveRunRequest(messages, request, result) {
  const heading = {
    completed: 'Completed',
    stopped: 'Stopped',
    failed: `Failed${result.error ? `: ${result.error}` : ''}`,
    cancelled: `Cancelled${result.feedback ? `: ${result.feedback}` : ''}`,
  }[result.status] || result.status;
  messages.push({
    role: 'tool',
    toolCallId: request.toolCallId,
    name: RUN_NODES_TOOL,
    content: JSON.stringify(result),
    ok: result.status === 'completed',
    label: request.summary,
    outcome: [heading, ...(result.results || [])].join('\n'),
  });
}

export function resolvePipelineAction(messages, request, result) {
  messages.push({
    role: 'tool', toolCallId: request.toolCallId, name: PIPELINE_ACTION_TOOL,
    content: JSON.stringify(result),
    ok: !['cancelled', 'failed'].includes(result.status),
    label: request.summary,
    outcome: result.status === 'failed' ? `Failed: ${result.error}`
      : result.status === 'cancelled' ? `Cancelled${result.feedback ? `: ${result.feedback}` : ''}`
        : `${result.status[0].toUpperCase()}${result.status.slice(1)}${result.run?.run_id ? `: ${result.run.run_id}` : ''}`,
  });
}

/**
 * Record what happened to a pending create_project.
 * @param {{status: 'created' | 'cancelled' | 'failed', name?: string, feedback?: string, error?: string}} result
 */
export function resolveCreateProject(messages, request, result) {
  messages.push({
    role: 'tool',
    toolCallId: request.toolCallId,
    name: CREATE_PROJECT_TOOL,
    content: JSON.stringify(result),
    ok: result.status === 'created',
    label: request.summary,
    outcome: result.status === 'created' ? `Created: ${result.name}`
      : result.status === 'cancelled' ? `Cancelled${result.feedback ? `: ${result.feedback}` : ''}`
        : `Failed: ${result.error}`,
  });
}

export function resolveFolderAccess(messages, request, result) {
  messages.push({ role: 'tool', toolCallId: request.toolCallId, name: REQUEST_FOLDER_ACCESS_TOOL,
    content: JSON.stringify(result), ok: result.status === 'allowed', label: request.request.reason || 'Local folder access',
    outcome: result.status === 'allowed' ? 'Access allowed' : result.status === 'denied' ? 'Access denied' : `Failed: ${result.error}`,
    ...(result.attachment ? { attachments: [result.attachment] } : {}) });
}

/**
 * Continue the conversation until the model answers or asks the user something.
 * @param {{messages: object[], credentialId: string, runtime: object, workspaceSummary: string,
 *   contextSummary?: {text: string, covered: number}|null, signal?: AbortSignal,
 *   onProgress?: (p: {status?: string, text?: string}) => void, onMessage?: () => void,
 *   onSummary?: (summary: {text: string, covered: number}) => void}} options messages is mutated in
 *   place; onMessage fires after each append; contextSummary is the conversation's summary so far,
 *   and onSummary receives a new one to store on the conversation; runtime.projectOpen false
 *   (no project open) narrows the tools offered; runtime.readAttachment (the desktop app) adds read_attachment
 * @returns {Promise<'answered' | 'waiting'>} waiting: a question or proposal is open
 */
export async function runAgentLoop({ messages, credentialId, runtime, workspaceSummary, contextSummary = null, signal, onProgress, onMessage, onSummary }) {
  const startedAt = Date.now();
  let toolCallCount = 0;
  const webCalls = { web_search: 0, read_webpage: 0 };
  const webLimits = { web_search: 2, read_webpage: 3 };
  let budgetSpent = false;
  const progress = (p) => { if (onProgress) onProgress(p); };
  const projectOpen = runtime.projectOpen !== false;
  const tools = agentToolDefinitions({ projectOpen, attachments: typeof runtime.readAttachment === 'function' });
  const offered = new Set(tools.map((definition) => definition.function.name));
  // The workspace summary and tools are fixed for this loop, so the history's share is too.
  const historyBudget = historyTokenBudget(await fetchAgentContext(credentialId), {
    workspaceSummary,
    tools,
  });
  let summary = contextSummary;

  for (;;) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    // Earlier turns that no longer fit are condensed into the conversation's summary rather than
    // dropped; if summarizing fails they are dropped, as planHistory already plans for.
    let plan = planHistory(messages, historyBudget, summary);
    if (plan.dropped > 0) {
      progress({ status: 'Summarizing earlier messages...', text: '' });
      const text = await summarizeHistory({
        credentialId,
        previousSummary: plan.summaryText,
        messages: messages.slice(plan.cut - plan.dropped, plan.cut),
        signal,
      });
      if (text) {
        summary = { text, covered: plan.cut };
        if (onSummary) onSummary(summary);
        plan = planHistory(messages, historyBudget, summary);
      }
    }
    // Some models (Gemini Flash-Lite, for one) intermittently end a turn with neither text nor a
    // tool call; one retry usually gets a real reply.
    let text = '';
    let toolCalls = [];
    let finishReason = '';
    let reasoningContent = '';
    for (let attempt = 0; attempt < 2 && !text.trim() && !toolCalls.length; attempt += 1) {
      let streamed = '';
      progress({ status: 'Thinking...', text: '' });
      ({ text, toolCalls, finishReason, reasoningContent } = await streamAgentTurn({
        credentialId,
        messages: toApiMessages(plan.messages),
        conversationSummary: plan.summaryText,
        tools,
        projectOpen,
        workspaceSummary,
        signal,
        onText: (delta) => {
          streamed += delta;
          progress({ text: streamed });
        },
      }));
    }
    const content = text.trim() || toolCalls.length
      ? text
      : 'The model returned an empty reply. Send the message again, or choose a different Agent model in Settings.';
    messages.push({ role: 'assistant', content, ...(toolCalls.length ? { toolCalls } : {}),
      ...(reasoningContent ? { reasoningContent } : {}) });
    if (onMessage) onMessage();
    if (!toolCalls.length) return 'answered';
    if (budgetSpent) {
      // The model ignored the exhausted budget; close its calls so the history stays valid.
      for (const call of toolCalls) {
        messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: BUDGET_EXHAUSTED, ok: false, label: 'Stopped: tool budget used up' });
      }
      messages.push({ role: 'assistant', content: 'I stopped here because this request needed more lookups than one message allows. Ask a narrower question, or tell me to continue.' });
      if (onMessage) onMessage();
      return 'answered';
    }

    const argumentsError = TRUNCATING_FINISH_REASONS.has(finishReason) ? TRUNCATED_ARGUMENTS : INVALID_ARGUMENTS;
    const overBudget = () => toolCallCount >= MAX_TOOL_CALLS_PER_TURN || Date.now() - startedAt >= MAX_TURN_MS;
    let waiting = false;
    for (const call of toolCalls) {
      if (!offered.has(call.name)) {
        // A tool this turn did not offer (a canvas tool with no project open, or create_project with
        // one open); it still costs a call.
        const spent = overBudget();
        if (spent) budgetSpent = true;
        else toolCallCount += 1;
        const unavailable = projectOpen ? 'a project is already open' : 'no project is open';
        messages.push({
          role: 'tool',
          toolCallId: call.id,
          name: call.name,
          content: spent ? BUDGET_EXHAUSTED : JSON.stringify({ error: `${call.name} is not available: ${unavailable}.` }),
          ok: false,
          label: spent ? 'Stopped: tool budget used up' : `${call.name} is not available: ${unavailable}`,
        });
        if (onMessage) onMessage();
        continue;
      }
      if (call.name === ASK_USER_TOOL) {
        waiting = true;
        continue;
      }
      if (call.name === PROPOSE_CHANGES_TOOL || call.name === RUN_NODES_TOOL || call.name === PIPELINE_ACTION_TOOL || call.name === CREATE_PROJECT_TOOL || call.name === REQUEST_FOLDER_ACCESS_TOOL) {
        // A request sent back to fix costs another model call, so it counts toward the budget too:
        // otherwise a model that keeps sending invalid ones never stops.
        if (overBudget()) {
          budgetSpent = true;
          messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: BUDGET_EXHAUSTED, ok: false, label: 'Stopped: tool budget used up' });
          if (onMessage) onMessage();
          continue;
        }
        toolCallCount += 1;
        // Validate before showing it: an invalid request goes straight back to the model to fix.
        const args = parseArguments(call.arguments);
        const isRun = call.name === RUN_NODES_TOOL;
        const isPipeline = call.name === PIPELINE_ACTION_TOOL;
        const isProject = call.name === CREATE_PROJECT_TOOL;
        const isFolder = call.name === REQUEST_FOLDER_ACCESS_TOOL;
        progress({ status: isProject ? 'Checking the project...' : isPipeline ? 'Checking the Pipeline...' : isRun ? 'Checking the jobs...' : 'Checking the proposal...' });
        const preview = !args
          ? { ok: false, error: argumentsError }
          : await (isFolder ? runtime.previewFolderAccess(args) : isProject ? runtime.previewCreateProject(args) : isPipeline ? runtime.previewPipelineAction(args) : isRun ? runtime.previewRunRequest(args) : runtime.previewProposal(args));
        if (preview.ok) {
          call.preview = isFolder ? { items: preview.items, path: preview.path } : isProject ? { items: preview.items, name: preview.name }
            : isPipeline ? { items: preview.items, action: preview.action, routeKey: preview.routeKey, runId: preview.runId, projectId: preview.projectId, projectIdentity: preview.projectIdentity, requestId: preview.requestId }
              : isRun ? { items: preview.items, total: preview.total, stopGuards: preview.stopGuards, projectIdentity: preview.projectIdentity } : { items: preview.items, warnings: preview.warnings, ...(preview.importSnapshots ? { importSnapshots: preview.importSnapshots } : {}) };
          waiting = true;
          if (onMessage) onMessage();
        } else {
          messages.push({
            role: 'tool',
            toolCallId: call.id,
            name: call.name,
            content: JSON.stringify({ status: 'invalid', error: preview.error }),
            ok: false,
            label: `Sent the ${isProject ? 'project' : isPipeline ? 'Pipeline action' : isRun ? 'run request' : 'proposal'} back for a fix: ${preview.error}`,
          });
          if (onMessage) onMessage();
        }
        continue;
      }
      const args = parseArguments(call.arguments);
      let result;
      if (!args) result = { ok: false, content: JSON.stringify({ error: argumentsError }) };
      else if (overBudget()) {
        budgetSpent = true;
        result = { ok: false, content: BUDGET_EXHAUSTED };
      } else {
        toolCallCount += 1;
        const label = describeToolCall(call.name, args, runtime);
        if (call.name in webCalls && webCalls[call.name] >= webLimits[call.name]) {
          result = { ok: false, content: JSON.stringify({ error: `The ${call.name} limit for this message is reached. Answer with available sources and explain what could not be checked.` }), label: 'Web lookup limit reached' };
        } else {
          if (call.name in webCalls) webCalls[call.name] += 1;
          progress({ status: call.name === 'web_search' ? 'Searching the web...' : call.name === 'read_webpage' ? 'Reading the webpage...' : `${label}...` });
          const outcome = await executeAgentTool(call.name, args, { ...runtime, signal });
          const activityLabel = !outcome.ok && call.name === 'web_search' ? 'Web search unavailable'
            : !outcome.ok && call.name === 'read_webpage' ? 'Webpage could not be read' : label;
          result = { ...outcome, label: activityLabel };
        }
      }
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      messages.push({
        role: 'tool',
        toolCallId: call.id,
        name: call.name,
        content: result.content,
        ok: result.ok,
        label: result.label || call.name,
      });
      if (onMessage) onMessage();
    }
    if (waiting) return 'waiting';
  }
}
