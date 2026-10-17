/**
 * The Agent's change proposals, applied to a getCanvasState() snapshot. Pure: planChangeSet takes a
 * canvas state and a list of operations and returns the next state (for loadCanvasState) plus a
 * readable description of every change for the confirmation card. Any invalid operation throws a
 * ChangeSetError and nothing is applied, so a proposal lands on the canvas whole or not at all.
 *
 * Nodes are referenced by their canvas id, or, for nodes added earlier in the same proposal, by the
 * "$name" ref given when adding them.
 */
import { generateDisplayName, nodeTypeLabel } from '../../nodeLabels.js';
import { cloneCell, isAssetCell, moveImageAsset, normalizeDatasetContent } from '../../datasetContent.js';
import { sampleSourceIndices, sampledOutputs } from '../../samplerQuota.js';
import { buildSamplerNodeSpec, formatSamplerModeSummary } from './sampler_node_shared.js';
import { PORT_TYPES, applyPortOp, checkConnect, checkDisconnect, keepSharedMapping, nodePorts } from '../../nodePorts.js';
import { referencedDatasetAliasNames } from '../../processDatasetBindings.js';
import { rebuildWorkingFromApplied } from '../../reviewWorkingText.js';
import { optimizationApplyBlockReason } from '../../evaluationHistory.js';
import { effectiveProcessOutputs } from '../../processOutputPorts.js';
import { savedProcessOutputs, savedRunOutput, scoreSavedFrom } from '../../savedDatasets.js';
import {
  DATA_EDGE, RESULT_PORT, processInputBindings, processPrimarySource, readsFromStep, runInputSource, setProcessInputs,
  setRunInputSource, stepSourceLabel,
} from '../../stepInputs.js';
import { stepOutputTable } from '../../stepOutputs.js';
import { parseScoreMappingBundle, serializeScoreMappingBundle } from '../../scoreMappingBundle.js';
import { nodeTitle, processOutputsOf, runResultsOf } from '../canvas/workflowNodeInspector.js';
import { contentLocks } from '../../contentLocks.js';
import { isTaskLocked } from '../../runTaskLocks.js';
import { validateAgentScoreTree } from './scoreRules.js';

export class ChangeSetError extends Error {
  constructor(message, index = null) {
    super(index == null ? message : `Operation ${index + 1}: ${message}`);
    this.name = 'ChangeSetError';
    this.operationIndex = index;
  }
}

const NODE_WIDTH = 320;
const NODE_HEIGHT = 170;
const COLUMN_TYPES = ['text', 'image', 'pdf'];
const NO_INPUT_TYPES = 'Prompt inputs have no type: an input sends what its mapped column holds (an image or PDF column sends its files). Leave out input_types.';
const OUTPUT_TYPES = ['str', 'float', 'list_str', 'list_float'];
const RETURN_SHAPES = ['single', 'table'];

const MATCH_FLAG_KEYS = {
  contains: 'contains',
  ignore_case: 'ignoreCase',
  ignore_symbols: 'ignoreSymbols',
  ignore_whitespace: 'ignoreWhitespace',
  semantic: 'semanticAlign',
  embedding: 'embeddingSimilarity',
  rxnorm: 'rxnormMatch',
  mesh: 'meshMatch',
};

function clean(value) {
  return String(value == null ? '' : value).trim();
}

function fail(message) {
  throw new ChangeSetError(message);
}

function parseJson(raw, fallback) {
  if (raw == null || raw === '') return fallback;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw) ?? fallback;
  } catch (_) {
    return fallback;
  }
}

function generateNodeId() {
  return `n_${Date.now()}_${(Math.random() * 1e9) | 0}`;
}

function uniqueName(requested, taken) {
  const base = clean(requested);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base} ${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

function datasetColumns(node) {
  const content = normalizeDatasetContent(node?.datasetContent || { headers: [], rows: [] });
  return content.headers.map((name, i) => ({ name, type: content.columnTypes[i] || 'text' }));
}

/** A Prompt's {variable} inputs. An input takes any column: an image or PDF column sends its files. */
function promptInputs(node, extractInputFields) {
  return extractInputFields(node?.text || '');
}

function outputText(output) {
  const fields = (output?.fields || []).map((f) => `- ${f.key} (${f.type}${f.allowNone ? ', allows None' : ''})${f.description ? `: ${f.description}` : ''}${f.examples?.length ? `; examples: ${JSON.stringify(f.examples)}` : ''}`);
  return [`Return shape: ${output?.returnShape || 'single'}`, ...fields].join('\n');
}

/**
 * @param {object} state getCanvasState() output
 * @param {object[]} operations
 * @param {{extractInputFields: Function, sources?: object, imported?: Map<number, {headers: string[], rows: string[][]}>,
 *   now?: () => string, models?: Map<string, object>, scoreTables?: Map<string, object>}} ctx imported holds rows fetched for import
 *   operations (by operation index); without it an import becomes an empty placeholder table. models holds the
 *   credentials the model pickers offer (Test passed), by id; scoreTables the table each Evaluate's Save to
 *   workspace saves ({headers, rows, recordId, stale}), by Evaluate id.
 * @returns {{state: object, items: object[], refs: Record<string, string>, warnings: string[], nodeIds: string[]}}
 */
export function planChangeSet(state, operations, ctx) {
  if (!Array.isArray(operations) || operations.length === 0) fail('A proposal needs at least one operation.');
  if (typeof ctx?.extractInputFields !== 'function') fail('extractInputFields is required.');
  const next = {
    ...state,
    nodes: (state?.nodes || []).map((n) => ({ ...n })),
    connections: (state?.connections || []).map((c) => ({ ...c })),
  };
  const refs = {};
  const items = [];
  const warnings = [];
  const touched = new Set();

  const byId = () => new Map(next.nodes.map((n) => [n.nodeId, n]));

  function resolve(value, label, types = null) {
    const raw = clean(value);
    if (!raw) fail(`${label} is required.`);
    const id = raw.startsWith('$') ? refs[raw] : raw;
    if (!id) fail(`${label} "${raw}" refers to a node that is not added earlier in this proposal.`);
    const node = byId().get(id);
    if (!node) fail(`${label} "${raw}" is not a node on the canvas.`);
    if (types && !types.includes(node.type)) fail(`${label} "${raw}" is a ${nodeTypeLabel(node.type)}, not a ${types.map(nodeTypeLabel).join(' or ')}.`);
    return node;
  }

  const addedIds = new Set();
  const codeChanged = new Set();

  /**
   * A step's input as a user can connect it on the canvas (stepInputs.js candidates): a Dataset, a Generate's results,
   * or one branch of a Process (`branch`; a Process with one output needs none). A Process's branches
   * are offered once its code has been checked or it has run, so one added or rewritten in this same
   * proposal cannot be read yet. Reading the step itself or one that reads it would make a loop.
   * @returns {{ nodeId: string, port: string, kind: 'dataset'|'run'|'process' }}
   */
  function resolveSource(value, branch, label, stepId) {
    const node = resolve(value, label, ['dataset', 'run', 'process']);
    const port = clean(branch);
    if (stepId && readsFromStep(next, node.nodeId, stepId)) {
      fail(`${label} "${nodeTitle(node)}" ${node.nodeId === stepId ? 'is this step itself' : 'reads this step\'s output'}, so reading it would make a loop.`);
    }
    if (node.type !== 'process') {
      if (port && port !== RESULT_PORT) fail(`${label} "${nodeTitle(node)}" is a ${nodeTypeLabel(node.type)} with one output; it has no branch "${port}".`);
      return { nodeId: node.nodeId, port: RESULT_PORT, kind: node.type };
    }
    if (addedIds.has(node.nodeId) || codeChanged.has(node.nodeId)) {
      fail(`Process "${nodeTitle(node)}" is added or changed in this proposal, so its branches are not known yet. Read it in a later proposal, once its code has been checked.`);
    }
    const { ports, dynamic } = effectiveProcessOutputs({ detected: node.processOutputPorts, dfResults: node.dfResults });
    if (!ports.length) {
      fail(`Process "${nodeTitle(node)}" has no known branches yet${dynamic ? ': its code builds them at run time, so run it first' : '; run it first'}.`);
    }
    const chosen = port || (ports.length === 1 ? ports[0] : '');
    if (!chosen) fail(`Process "${nodeTitle(node)}" has several branches (${ports.join(', ')}); name the one to read with ${label === 'input' ? 'input_branch' : 'primary_branch'}.`);
    if (!ports.includes(chosen)) fail(`Process "${nodeTitle(node)}" has no branch "${chosen}". Branches: ${ports.join(', ')}.`);
    return { nodeId: node.nodeId, port: chosen, kind: 'process' };
  }

  /** The columns a step reads from `source`, or null while that step has no result to read. */
  function sourceColumns(source) {
    const { table } = stepOutputTable(next, source);
    if (!table) return null;
    return table.headers.map((name, i) => ({ name, type: table.columnTypes?.[i] || 'text' }));
  }

  function registerRef(op, nodeId) {
    const ref = clean(op.ref);
    if (!ref) return;
    if (!ref.startsWith('$')) fail(`ref "${ref}" must start with "$".`);
    if (refs[ref]) fail(`ref "${ref}" is used twice.`);
    refs[ref] = nodeId;
  }

  function takenNames(type, filter = () => true) {
    return new Set(next.nodes.filter((n) => n.type === type && filter(n)).map((n) => nodeTitle(n)));
  }

  /** A free spot to the right of `anchor`, or below everything when there is no anchor. */
  function placeNear(anchor) {
    const occupied = next.nodes.map((n) => ({ left: Number(n.left) || 0, top: Number(n.top) || 0 }));
    const overlaps = (left, top) => occupied.some((o) => Math.abs(o.left - left) < NODE_WIDTH - 20 && Math.abs(o.top - top) < NODE_HEIGHT - 20);
    let left;
    let top;
    if (anchor) {
      left = (Number(anchor.left) || 0) + NODE_WIDTH;
      top = Number(anchor.top) || 0;
    } else {
      left = occupied.length ? Math.min(...occupied.map((o) => o.left)) : 80;
      top = occupied.length ? Math.max(...occupied.map((o) => o.top)) + NODE_HEIGHT + 40 : 80;
    }
    while (overlaps(left, top)) top += NODE_HEIGHT;
    return { left, top };
  }

  function addNode(node) {
    addedIds.add(node.nodeId);
    next.nodes.push(node);
    touched.add(node.nodeId);
    return node;
  }

  function connect(fromId, toId, type) {
    if (!next.connections.some((c) => c.fromId === fromId && c.toId === toId && c.type === type)) {
      next.connections.push({ fromId, toId, type });
    }
  }

  /** A model the user could pick beside Create Generate or Optimize prompt: a credential whose Test passed. */
  function pickModel(value) {
    const model = ctx.models?.get(clean(value));
    if (model) return model;
    fail(ctx.models?.size
      ? `model must be the id of a tested model from the workspace summary: ${[...ctx.models.keys()].join(', ')}.`
      : 'There are no tested models; the user has to add and test one in Settings → Credentials.');
  }
  const modelLabel = (credential) => [credential.provider, credential.model].filter(Boolean).join(' / ') || credential.id;

  const promptInputNames = (prompt) => promptInputs(prompt, ctx.extractInputFields);
  /** How a source an input reads is named on a card: a Prompt by its title, a step or Dataset as its readers name it. */
  const sourceLabel = (source) => (source.kind === 'prompt' ? nodeTitle(byId().get(source.nodeId)) : stepSourceLabel(next, source));

  /**
   * Joins the output `from` ({ nodeId, portId }) to the input `portId` of `node` with the rules a line
   * dragged on the canvas follows (nodePorts.js), and changes what that line changes there.
   * @returns {object|null} the op carried out; null when the input already read `from`
   */
  function connectPort(from, node, portId) {
    if (node.type === 'score' && node.scoreMatchPending) fail(`Evaluate "${nodeTitle(node)}" is matching; stop it before changing its inputs.`);
    const result = checkConnect(next, from, { nodeId: node.nodeId, portId });
    if (!result.ok) fail(`${nodeTitle(node)}: ${result.reason}`);
    applyPortOp(next, result.op, { promptInputs: promptInputNames });
    return result.op;
  }

  /** The output a connect operation names for one input port: a Prompt, a Dataset, or a step's output. */
  function connectSource(op, node, port) {
    if (port.type === PORT_TYPES.PROMPT) return { nodeId: resolve(op.source, 'source', ['prompt']).nodeId, portId: 'prompt' };
    if (port.id === 'ground_truth') return { nodeId: resolve(op.source, 'source', ['dataset']).nodeId, portId: RESULT_PORT };
    const source = resolveSource(op.source, op.branch, 'source', node.nodeId);
    return { nodeId: source.nodeId, portId: source.port };
  }

  function inputPortOf(op, node) {
    const portId = clean(op.input);
    const inputs = nodePorts(next, node.nodeId)?.inputs || [];
    const port = inputs.find((item) => item.id === portId);
    if (!port) fail(`${nodeTypeLabel(node.type)} "${nodeTitle(node)}" has no input "${portId}". Its inputs: ${inputs.map((item) => item.id).join(', ') || '(none)'}.`);
    return port;
  }

  function disconnectWhere(predicate) {
    next.connections = next.connections.filter((c) => !predicate(c));
  }

  // ---------- normalizers for operation payloads ----------

  function normalizeText(value) {
    if (typeof value !== 'string' || !value.trim()) fail('text must be the prompt text, with a {variable} for each input.');
    return value;
  }

  /** The text with each {old, new} edit applied in turn; every `old` must appear exactly once in the text so far. */
  function editText(current, edits) {
    if (!Array.isArray(edits) || edits.length === 0) fail('text_edits must be a non-empty list of {old, new}.');
    let text = String(current || '');
    for (const edit of edits) {
      const old = String(edit?.old ?? '');
      if (!old) fail('Every text edit needs the old text it replaces.');
      const at = text.indexOf(old);
      if (at < 0) fail(`text_edits: "${old.slice(0, 80)}" is not in the prompt text.`);
      if (text.indexOf(old, at + 1) >= 0) fail(`text_edits: "${old.slice(0, 80)}" appears more than once; include more of the text around it.`);
      text = text.slice(0, at) + String(edit?.new ?? '') + text.slice(at + old.length);
    }
    return normalizeText(text);
  }

  function nextText(current, op) {
    if (op.text != null && op.text_edits != null) fail('Give either text or text_edits, not both.');
    if (op.text_edits != null) return editText(current, op.text_edits);
    if (op.text != null) return normalizeText(op.text);
    return null;
  }

  /**
   * An output schema from the model. A bare list is taken as the fields; for a version or an edit
   * (`base` = the current schema), whatever is left out (the fields, or the return shape) is kept.
   */
  function normalizeOutput(rawValue, base = null) {
    const value = Array.isArray(rawValue) ? { fields: rawValue } : rawValue;
    if (!value || typeof value !== 'object') fail('output must be {return_shape, fields}.');
    const returnShape = clean(value.return_shape ?? value.returnShape) || base?.returnShape || 'table';
    if (!RETURN_SHAPES.includes(returnShape)) fail(`return_shape must be ${RETURN_SHAPES.join(' or ')}.`);
    const rawFields = value.fields === undefined ? (base?.fields || []) : value.fields;
    if (!Array.isArray(rawFields)) fail('output.fields must be a list of fields.');
    const fields = rawFields.map((f) => {
      if ((f?.allow_none !== undefined && typeof f.allow_none !== 'boolean')
        || (f?.allowNone !== undefined && typeof f.allowNone !== 'boolean')) fail('allow_none must be a boolean.');
      const type = clean(f?.type) || 'str';
      const number = (example) => {
        if (example == null || typeof example === 'boolean' || clean(example) === '' || !Number.isFinite(Number(example))) {
          fail(`Output field "${clean(f?.key)}" needs numeric examples.`);
        }
        return Number(example);
      };
      const examples = (Array.isArray(f?.examples) ? f.examples : []).map((example) => {
        if (type === 'list_str' || type === 'list_float') {
          if (!Array.isArray(example)) fail(`Output field "${clean(f?.key)}" needs each list example as an array.`);
          return example.map((item) => type === 'list_float' ? number(item) : String(item ?? ''));
        }
        if (Array.isArray(example) || (example && typeof example === 'object')) fail(`Output field "${clean(f?.key)}" needs scalar examples.`);
        return type === 'float' ? number(example) : String(example ?? '');
      });
      return {
        key: clean(f?.key), type, description: String(f?.description ?? '').trim(), examples,
        allowNone: f?.allow_none === true || f?.allowNone === true,
      };
    });
    if (!fields.length) fail('output.fields must list at least one field as {key, type, description}.');
    if (value.fields !== undefined && fields.some((field) => !field.description)) fail('Every output field needs a description.');
    const keys = new Set();
    for (const f of fields) {
      if (!f.key) fail('Every output field needs a key.');
      if (keys.has(f.key.toLowerCase())) fail(`Output field "${f.key}" is listed twice.`);
      keys.add(f.key.toLowerCase());
      if (!OUTPUT_TYPES.includes(f.type)) fail(`Output field "${f.key}" has type "${f.type}"; use one of ${OUTPUT_TYPES.join(', ')}.`);
    }
    return { returnShape, fields };
  }

  function normalizeTable(op, current = null) {
    const definitions = Array.isArray(op.columns) ? op.columns : current?.headers || [];
    const columns = definitions.map((c) => clean(typeof c === 'object' ? c?.name : c));
    if (!columns.length || columns.some((c) => !c)) fail('columns must be a non-empty list of column names.');
    if (new Set(columns).size !== columns.length) fail('Column names must be unique.');
    const columnTypes = definitions.map((column, i) => {
      const previous = current?.headers.indexOf(columns[i]) ?? -1;
      const type = clean(typeof column === 'object' ? column?.type : '')
        || current?.columnTypes[previous >= 0 ? previous : columns.length === current.headers.length ? i : -1] || 'text';
      if (!COLUMN_TYPES.includes(type)) fail(`Column "${columns[i]}" must have type text, image or pdf.`);
      return type;
    });
    const assets = new Map();
    function collectAssets(value) {
      if (!value || typeof value !== 'object') return;
      if (isAssetCell(value)) {
        value.assetIds.forEach((id, index) => assets.set(`${value.kind}:${id}`, value.names?.[index] || assets.get(`${value.kind}:${id}`) || ''));
      } else Object.values(value).forEach(collectAssets);
    }
    for (const node of next.nodes) {
      collectAssets(node.datasetContent);
      for (const key of ['dfResults', 'runInputContent', 'runResults']) collectAssets(parseJson(node[key], null));
    }
    const rawRows = op.rows ?? current?.rows ?? [];
    if (!Array.isArray(rawRows)) fail('rows must be a list of rows.');
    const rows = rawRows.map((row, i) => {
      let values;
      if (Array.isArray(row)) {
        values = op.rows == null && current ? columns.map((column, index) => {
          const previous = current.headers.indexOf(column);
          return row[previous >= 0 ? previous : columns.length === current.headers.length ? index : -1] ?? '';
        }) : row;
        if (values.length !== columns.length) fail(`Row ${i + 1} has ${values.length} cells but there are ${columns.length} columns.`);
      } else if (row && typeof row === 'object') values = columns.map((column) => row[column] ?? '');
      else fail(`Row ${i + 1} must be a list of cells or an object keyed by column.`);
      return values.map((cell, column) => {
        const type = columnTypes[column];
        if (type === 'text') {
          if (cell && typeof cell === 'object') fail(`Row ${i + 1}, column "${columns[column]}" is text; use a scalar value.`);
          return String(cell ?? '');
        }
        if (cell == null || cell === '') return { kind: type === 'image' ? 'images' : 'pdf', assetIds: [], names: [] };
        if (!isAssetCell(cell) || cell.kind !== (type === 'image' ? 'images' : 'pdf')) {
          fail(`Row ${i + 1}, column "${columns[column]}" needs an existing ${type} asset cell from read_rows, or an empty cell.`);
        }
        for (const id of cell.assetIds) {
          if (!assets.has(`${cell.kind}:${id}`)) fail(`Unknown ${type} asset "${id}". Reuse uploaded files from read_rows; new files must be uploaded in the Dataset view.`);
        }
        return { kind: cell.kind, assetIds: cell.assetIds.slice(), names: cell.assetIds.map((id) => assets.get(`${cell.kind}:${id}`)) };
      });
    });
    const rowIds = op.row_ids ?? (current && rows.length === current.rows.length ? current.rowIds : undefined);
    if (op.row_ids !== undefined && (!current || !Array.isArray(rowIds) || rowIds.length !== rows.length
      || rowIds.some((id) => id && !current.rowIds.includes(id)) || new Set(rowIds.filter(Boolean)).size !== rowIds.filter(Boolean).length)) {
      fail('row_ids must match rows and contain unique existing row IDs (or null for new rows).');
    }
    return normalizeDatasetContent({ headers: columns, rows, columnTypes, rowIds });
  }

  /**
   * The mapping a Generate gets, checked against the columns of what it reads. Like the Generate window, columns
   * can only be chosen once they are known: an input whose step has no result yet is left unmapped.
   */
  function validateMapping(prompt, source, mapping) {
    const inputs = promptInputs(prompt, ctx.extractInputFields);
    const columns = sourceColumns(source);
    const label = stepSourceLabel(next, source);
    const normalized = Object.fromEntries(Object.entries(mapping && typeof mapping === 'object' ? mapping : {})
      .map(([k, v]) => [clean(k), clean(v)]).filter(([, v]) => v));
    for (const key of Object.keys(normalized)) {
      if (!inputs.includes(key)) fail(`input_mapping names "${key}", which is not an input of prompt "${nodeTitle(prompt)}".`);
    }
    if (!columns) {
      if (Object.keys(normalized).length) {
        fail(`"${label}" has no result yet, so its columns are not known. Leave out input_mapping, run "${label}", then set input_mapping with update.`);
      }
      return {};
    }
    for (const input of inputs) {
      const column = normalized[input];
      if (!column) fail(`input_mapping has no column for prompt input "${input}".`);
      if (!columns.some((c) => c.name === column)) fail(`"${label}" has no column "${column}". Columns: ${columns.map((c) => c.name).join(', ')}.`);
    }
    return normalized;
  }

  /** What a Generate's card says about its input mapping. */
  function mappingLine(mapping, source) {
    const entries = Object.entries(mapping);
    if (entries.length) return `Mapping: ${entries.map(([k, v]) => `${k} ← ${v}`).join(', ')}`;
    return sourceColumns(source) ? 'Mapping: (no inputs)' : `Not mapped yet: map its inputs once "${stepSourceLabel(next, source)}" has run.`;
  }

  function matchFlags(match) {
    const flags = {};
    const m = match && typeof match === 'object' ? match : {};
    for (const [key, flag] of Object.entries(MATCH_FLAG_KEYS)) if (m[key] === true) flags[flag] = true;
    const numeric = clean(m.numeric);
    if (numeric && numeric !== 'exact') {
      if (!['abs', 'rel', 'decimals'].includes(numeric)) fail('match.numeric must be exact, abs, rel or decimals.');
      flags.numericMode = numeric;
      if (numeric === 'abs') flags.numericAbsEpsilon = Number(m.tolerance) || 0;
      if (numeric === 'rel') flags.numericRelEpsilon = Number(m.tolerance) || 0;
      if (numeric === 'decimals') flags.numericDecimalPlaces = Number.isInteger(m.decimals) ? m.decimals : 2;
    }
    return flags;
  }

  function scoreBundle(op, run, groundTruth) {
    const prompt = next.nodes.find((n) => n.type === 'prompt'
      && next.connections.some((c) => c.type === 'prompt-to-run' && c.fromId === n.nodeId && c.toId === run.nodeId));
    const runInput = runInputSource(next, run.nodeId);
    const inputColumns = runInput ? (sourceColumns(runInput) || []).map((c) => c.name) : [];
    const outputKeys = (prompt?.outputFormat?.fields || []).map((f) => f.key);
    const gtColumns = datasetColumns(groundTruth).map((c) => c.name);
    if (op.rule_tree !== undefined) {
      if (['pairing', 'comparison', 'combine'].some((key) => op[key] !== undefined) || clean(op.match_code)) fail('Use rule_tree alone, without flat rules or match_code.');
      let mapping;
      try { mapping = validateAgentScoreTree(op.rule_tree, { inputColumns, outputKeys, gtColumns }); }
      catch (error) { fail(error.message); }
      return { mapping, lines: ['Replace the complete Evaluate rule tree, preserving its AND/OR groups.'],
        diffs: [{ label: 'Evaluate rule tree', before: '', after: JSON.stringify(mapping, null, 2) }] };
    }
    const gtList = (value, where) => {
      const cols = (Array.isArray(value) ? value : [value]).map(clean).filter(Boolean);
      if (!cols.length) fail(`${where} needs ground_truth_columns.`);
      for (const col of cols) {
        if (!gtColumns.includes(col)) fail(`Ground truth "${nodeTitle(groundTruth)}" has no column "${col}". Columns: ${gtColumns.join(', ')}.`);
      }
      return cols;
    };
    const pairing = (Array.isArray(op.pairing) ? op.pairing : []).map((rule, i) => {
      const column = clean(rule?.run_input_column);
      if (column !== '#' && !inputColumns.includes(column)) {
        fail(`pairing rule ${i + 1}: the run's input has no column "${column}". Use one of: ${inputColumns.join(', ')}, or "#" for the row number.`);
      }
      return {
        type: 'rule',
        outputKey: column === '#' ? '#' : `[${column}]`,
        gtColumns: gtList(rule?.ground_truth_columns, `pairing rule ${i + 1}`),
        matchType: 'exact',
        matchFlags: matchFlags(rule?.match),
      };
    });
    const comparison = (Array.isArray(op.comparison) ? op.comparison : []).map((rule, i) => {
      const field = clean(rule?.field);
      if (!outputKeys.includes(field)) fail(`comparison rule ${i + 1}: the prompt has no output field "${field}". Fields: ${outputKeys.join(', ')}.`);
      return {
        type: 'rule',
        outputKey: field,
        gtColumns: gtList(rule?.ground_truth_columns, `comparison rule ${i + 1}`),
        matchType: 'exact',
        matchFlags: matchFlags(rule?.match),
      };
    });
    if (!comparison.length) fail('An Evaluate node needs at least one comparison rule.');
    const combine = clean(op.combine) || 'all';
    if (!['all', 'any'].includes(combine)) fail('combine must be "all" or "any".');
    const op2 = combine === 'all' ? 'AND' : 'OR';
    const { inputRoot, outputRoot } = parseScoreMappingBundle({
      v: 2,
      input: { type: 'group', ops: Array(Math.max(0, pairing.length - 1)).fill('AND'), children: pairing },
      output: { type: 'group', ops: Array(comparison.length - 1).fill(op2), children: comparison },
    });
    return {
      mapping: JSON.parse(serializeScoreMappingBundle(inputRoot, outputRoot)),
      lines: [
        ...pairing.map((r) => `Pair rows: ${r.outputKey === '#' ? 'row number' : r.outputKey.slice(1, -1)} = ${r.gtColumns.join(' / ')}`),
        ...comparison.map((r) => `Compare ${r.outputKey} with ${r.gtColumns.join(' / ')}`),
        comparison.length > 1 ? `A row matches when ${combine === 'all' ? 'all' : 'any'} comparisons match` : null,
      ].filter(Boolean),
    };
  }

  /** Like the Process window: the inputs are df (`primary`, a source) and each Dataset or step output
   * the code declares as a process() parameter or uses, by the alias it already has. A name that
   * matches no input is left unconnected, as on the canvas, where it is an empty port. Returns the
   * inputs other than df, and the lines that name what is still unconnected. */
  function wireProcess(processNode, code, primary) {
    if (!/^\s*def\s+process\s*\(\s*df\b/m.test(code)) fail('Process code must define process(df).');
    if (!primary) {
      processNode.dfCode = code;
      processNode.activeMode = 'df';
      return { others: [], notes: ['Connect a Data input before running this Process.'] };
    }
    const primaryKey = primary.kind === 'dataset' ? primary.nodeId : `${primary.nodeId}:${primary.port}`;
    const bindings = processInputBindings(next, processNode.nodeId, { code, primaryId: primaryKey });
    const unknown = [...referencedDatasetAliasNames(code)]
      .filter((alias) => !bindings.some((b) => b.alias === alias));
    const inputs = bindings.filter((b) => b.input);
    processNode.dfCode = code;
    processNode.activeMode = 'df';
    setProcessInputs(next, processNode.nodeId, { primary: { nodeId: primary.nodeId, port: primary.port }, inputs });
    const notes = unknown.length
      ? [`Not connected yet: ${unknown.join(', ')} (no input has that name; it cannot run until one is connected). Inputs it could read: ${bindings.filter((b) => !b.primary).map((b) => `${b.alias} ("${b.label}")`).join(', ') || '(none)'}.`]
      : [];
    return { others: inputs.filter((b) => !b.primary), notes };
  }

  function samplerSpec(op, sourceNodeId, current = {}) {
    const modes = { random: 'without-replacement', random_with_replacement: 'with-replacement', rows: 'specify-rows' };
    if (op.sampling != null && !modes[op.sampling]) fail('sampling must be random, random_with_replacement or rows.');
    if (op.size_unit != null && !['rows', 'percent'].includes(op.size_unit)) fail('size_unit must be rows or percent.');
    let spec;
    try {
      spec = buildSamplerNodeSpec({
        sourceNodeId,
        samplingType: modes[op.sampling] || current.samplingType || 'without-replacement',
        sampleSizeType: op.size_unit ? (op.size_unit === 'rows' ? 'rows' : 'ratio') : current.sampleSizeType || (op.size == null ? 'ratio' : 'rows'),
        sampleSize: op.size ?? current.sampleSize ?? 100,
        rowSpec: op.rows ?? current.rowSpec,
        name: op.name || current.name || 'Sample',
      }, { strict: true });
    } catch (error) { fail(error.message); }
    delete spec.ensureUniqueName;
    return spec;
  }

  function createSampleDataset(sampler, op) {
    const source = resolve(sampler.sourceNodeId, 'source', ['dataset']);
    const content = normalizeDatasetContent(source.datasetContent || { headers: [], rows: [] });
    if (!content.headers.length) fail(`Dataset "${nodeTitle(source)}" has no columns to sample.`);
    // Keep generated IDs stable within this plan, including a source loaded from an older project.
    source.datasetContent = content;
    let indices;
    try { indices = sampleSourceIndices(content, sampledOutputs(next, sampler.nodeId), sampler); }
    catch (error) { fail(error.message); }
    const outputs = sampledOutputs(next, sampler.nodeId);
    const datasetName = uniqueName(clean(op.name) || `${nodeTitle(source)} sample ${outputs.length + 1}`, takenNames('dataset'));
    const dataset = addNode({
      type: 'dataset', nodeId: generateNodeId(), ...placeNear(sampler), name: datasetName,
      note: String(op.note ?? formatSamplerModeSummary(sampler)), samplerNodeId: sampler.nodeId,
      ...(sampler.samplingType === 'without-replacement' ? { sampledSourceRowIds: indices.map((i) => content.rowIds[i]) } : {}),
      datasetContent: normalizeDatasetContent({ headers: content.headers, columnTypes: content.columnTypes,
        rows: indices.map((i) => content.rows[i].map(cloneCell)) }),
      nodeOrigin: 'agent',
    });
    connect(sampler.nodeId, dataset.nodeId, 'sampler-to-dataset');
    return dataset;
  }

  function assertContentEditable(node) {
    if (!ctx.contentLocks?.get(node.nodeId)?.length && !contentLocks([], next).get(node.nodeId)?.length) return;
    const remedy = node.type === 'prompt' ? 'Use add_prompt_version to change a new version.'
      : 'Add a new dataset (add_dataset or duplicate_dataset) with the changed table instead.';
    fail(`${nodeTypeLabel(node.type)} "${nodeTitle(node)}" has produced results, so its content is locked. ${remedy}`);
  }

  // ---------- operations ----------

  const handlers = {
    add_dataset(op) {
      const content = normalizeTable(op);
      const { headers, rows } = content;
      const name = uniqueName(clean(op.name) || 'Dataset', takenNames('dataset'));
      const node = addNode({
        type: 'dataset',
        nodeId: generateNodeId(),
        ...placeNear(null),
        name,
        note: String(op.note ?? ''),
        datasetContent: content,
        nodeOrigin: 'agent',
      });
      registerRef(op, node.nodeId);
      return { kind: 'add', type: 'dataset', title: `New dataset "${name}"`, nodeIds: [node.nodeId],
        lines: [`${rows.length} rows; columns: ${headers.join(', ')}`] };
    },

    import_dataset(op, index) {
      const sourceKey = clean(op.source);
      const source = ctx.sources?.[sourceKey];
      if (!source) fail(`source must be one of: ${Object.keys(ctx.sources || {}).join(', ')}.`);
      const ids = (Array.isArray(op.ids) ? op.ids : []).map(clean).filter(Boolean);
      if (!ids.length) fail(`ids must list the ${source.id}s to import.`);
      if (ids.length > 5000) fail('At most 5000 records can be imported at once.');
      const fields = (Array.isArray(op.fields) ? op.fields : []).map(clean).filter(Boolean);
      const unknown = fields.filter((f) => !source.fields[f]);
      if (!fields.length || unknown.length) {
        fail(`fields must be chosen from: ${Object.keys(source.fields).join(', ')}${unknown.length ? ` (unknown: ${unknown.join(', ')})` : ''}.`);
      }
      const fetched = ctx.imported?.get(index);
      const headers = fetched ? fetched.headers : fields.map((f) => source.fields[f]);
      const rows = fetched ? fetched.rows : [];
      const name = uniqueName(clean(op.name) || `${source.label} import`, takenNames('dataset'));
      const node = addNode({
        type: 'dataset',
        nodeId: generateNodeId(),
        ...placeNear(null),
        name,
        note: String(op.note ?? `Imported from ${source.label}.`),
        datasetContent: normalizeDatasetContent({ headers, rows }),
        nodeOrigin: 'agent',
      });
      registerRef(op, node.nodeId);
      const lines = [`${ids.length} ${source.id}${ids.length === 1 ? '' : 's'} from ${source.label}; columns: ${headers.join(', ')}`];
      if (fetched?.notFound?.length) lines.push(`${fetched.notFound.length} not found: ${fetched.notFound.slice(0, 10).join(', ')}`);
      if (!fetched) lines.push('Records are fetched when the proposal is applied.');
      return { kind: 'add', type: 'dataset', title: `Import "${name}"`, nodeIds: [node.nodeId], lines };
    },

    add_sampler(op) {
      const source = resolve(op.source, 'source', ['dataset']);
      const spec = samplerSpec(op, source.nodeId);
      const samplerName = uniqueName(clean(op.name) || 'Sample', takenNames('sampler', (n) => n.sourceNodeId === source.nodeId));
      const sampler = addNode({
        ...spec,
        type: 'sampler',
        nodeId: generateNodeId(),
        ...placeNear(source),
        name: samplerName,
        note: '',
        sourceNodeId: source.nodeId,
        nodeOrigin: 'agent',
      });
      connect(source.nodeId, sampler.nodeId, 'dataset-to-sampler');
      registerRef(op, sampler.nodeId);
      if (op.create_dataset === false) {
        if (op.dataset_ref) fail('dataset_ref needs create_dataset: true.');
        return { kind: 'add', type: 'sampler', title: `New Sample "${samplerName}"`, nodeIds: [sampler.nodeId],
          lines: [formatSamplerModeSummary(sampler), 'No sample Dataset created yet; its settings stay editable.'] };
      }
      const dataset = createSampleDataset(sampler, { name: op.dataset_name });
      if (clean(op.dataset_ref)) registerRef({ ref: op.dataset_ref }, dataset.nodeId);
      return { kind: 'add', type: 'sampler', title: `New sample "${dataset.name}" of "${nodeTitle(source)}"`,
        nodeIds: [sampler.nodeId, dataset.nodeId], lines: [formatSamplerModeSummary(sampler), `${dataset.datasetContent.rows.length} rows`] };
    },

    sample_dataset(op) {
      const sampler = resolve(op.sampler, 'sampler', ['sampler']);
      const dataset = createSampleDataset(sampler, op);
      touched.add(sampler.nodeId);
      registerRef(op, dataset.nodeId);
      return { kind: 'add', type: 'dataset', title: `Create sample "${dataset.name}"`, nodeIds: [sampler.nodeId, dataset.nodeId],
        lines: [formatSamplerModeSummary(sampler), `${dataset.datasetContent.rows.length} rows`] };
    },

    duplicate_dataset(op) {
      const source = resolve(op.dataset, 'dataset', ['dataset']);
      const content = normalizeDatasetContent(source.datasetContent);
      const version = op.as_version === true;
      const name = uniqueName(clean(op.name) || `${nodeTitle(source)} ${version ? 'v2' : '(Copy 1)'}`, takenNames('dataset'));
      const node = addNode({
        type: 'dataset', nodeId: generateNodeId(), ...placeNear(source), name,
        note: String(op.note ?? source.note ?? ''), nodeOrigin: 'agent',
        ...(version && source.samplerNodeId ? { samplerNodeId: source.samplerNodeId } : {}),
        datasetContent: normalizeDatasetContent({ ...content, rowIds: version ? content.rowIds : undefined }),
      });
      if (version) connect(source.nodeId, node.nodeId, 'dataset-to-dataset');
      registerRef(op, node.nodeId);
      return { kind: 'add', type: 'dataset', title: `${version ? 'New version' : 'Duplicate'} of Dataset "${nodeTitle(source)}": "${name}"`,
        nodeIds: [node.nodeId], lines: [`${content.rows.length} rows, including all image and PDF cells`] };
    },

    move_image(op) {
      const node = resolve(op.dataset, 'dataset', ['dataset']);
      assertContentEditable(node);
      const content = normalizeDatasetContent(node.datasetContent);
      const fromColumn = content.headers.indexOf(clean(op.from_column));
      const toColumn = content.headers.indexOf(clean(op.to_column));
      const fromRow = Number(op.from_row) - 1;
      const toRow = Number(op.to_row) - 1;
      if (![fromColumn, toColumn].every((index) => content.columnTypes[index] === 'image')) fail('Both columns must be image columns.');
      if (![fromRow, toRow].every((row) => Number.isInteger(row) && row >= 0 && row < content.rows.length)) fail('Image rows must be existing 1-based Dataset row numbers.');
      if (fromRow === toRow && fromColumn === toColumn) fail('The source and target image cells are the same.');
      const moved = moveImageAsset(content.rows[fromRow][fromColumn], content.rows[toRow][toColumn], Number(op.image ?? 1) - 1);
      if (!moved) fail('image must name an existing image in the source cell (1-based).');
      content.rows[fromRow][fromColumn] = moved.source;
      content.rows[toRow][toColumn] = moved.target;
      node.datasetContent = content;
      touched.add(node.nodeId);
      return { kind: 'update', type: 'dataset', title: `Move image in "${nodeTitle(node)}"`, nodeIds: [node.nodeId],
        lines: [`Row ${fromRow + 1}, ${op.from_column} → row ${toRow + 1}, ${op.to_column}`, 'The image is removed from its source cell.'] };
    },

    add_process(op) {
      const code = String(op.code ?? 'def process(df):\n    return df').trim();
      const name = uniqueName(clean(op.name) || 'Process', takenNames('process'));
      const anchor = op.primary_input ? resolve(op.primary_input, 'primary_input', ['dataset', 'run', 'process']) : null;
      const node = addNode({ type: 'process', nodeId: generateNodeId(), ...placeNear(anchor), name, nodeOrigin: 'agent' });
      const primary = anchor ? resolveSource(op.primary_input, op.primary_branch, 'primary_input', node.nodeId) : null;
      const { others, notes } = wireProcess(node, code, primary);
      registerRef(op, node.nodeId);
      return {
        kind: 'add', type: 'process', title: `New process "${name}"`, nodeIds: [node.nodeId],
        lines: [...(primary ? [`df = "${stepSourceLabel(next, primary)}"`] : []), ...others.map((b) => `${b.alias} = "${b.label}"`), ...notes,
          'Not run yet: running it produces its output branches.'],
        diffs: [{ label: 'Code', before: '', after: code }],
      };
    },

    duplicate_process(op) {
      const source = resolve(op.process, 'process', ['process']);
      const name = uniqueName(clean(op.name) || `${nodeTitle(source)} (Copy 1)`, takenNames('process'));
      const node = addNode({ type: 'process', nodeId: generateNodeId(), ...placeNear(source), name,
        dfCode: String(source.dfCode || ''), activeMode: 'df', nodeOrigin: 'agent',
        ...(source.processOutputPorts ? { processOutputPorts: structuredClone(source.processOutputPorts) } : {}),
      });
      registerRef(op, node.nodeId);
      return { kind: 'add', type: 'process', title: `Duplicate Process "${nodeTitle(source)}": "${name}"`, nodeIds: [node.nodeId],
        lines: ['Copies its code and detected outputs. No inputs or results are copied.'] };
    },

    add_prompt(op) {
      const text = normalizeText(op.text);
      const outputFormat = normalizeOutput(op.output);
      if (op.input_types != null) fail(NO_INPUT_TYPES);
      const name = uniqueName(clean(op.name) || 'Prompt', takenNames('prompt'));
      const node = addNode({
        type: 'prompt', nodeId: generateNodeId(), ...placeNear(null), name, note: String(op.note ?? ''),
        text, outputFormat, nodeOrigin: 'agent',
      });
      registerRef(op, node.nodeId);
      return {
        kind: 'add', type: 'prompt', title: `New prompt "${name}"`, nodeIds: [node.nodeId],
        lines: [`Inputs: ${promptInputs(node, ctx.extractInputFields).join(', ') || '(none)'}`],
        diffs: [
          { label: 'Prompt', before: '', after: text },
          { label: 'Output', before: '', after: outputText(outputFormat) },
        ],
      };
    },

    add_prompt_version(op) {
      const source = resolve(op.prompt, 'prompt', ['prompt']);
      const text = nextText(source.text, op) ?? String(source.text || '');
      const outputFormat = op.output != null ? normalizeOutput(op.output, source.outputFormat) : JSON.parse(JSON.stringify(source.outputFormat || { returnShape: 'single', fields: [] }));
      if (op.input_types != null) fail(NO_INPUT_TYPES);
      const name = uniqueName(clean(op.name) || nodeTitle(source), takenNames('prompt'));
      const node = addNode({
        type: 'prompt', nodeId: generateNodeId(), ...placeNear(source), name,
        note: op.note != null ? String(op.note) : String(source.note || ''),
        text, outputFormat, nodeOrigin: 'agent',
      });
      connect(source.nodeId, node.nodeId, 'prompt-to-prompt');
      registerRef(op, node.nodeId);
      const diffs = [];
      if (op.text != null || op.text_edits != null) diffs.push({ label: 'Prompt', before: String(source.text || ''), after: text });
      if (op.output != null) diffs.push({ label: 'Output', before: outputText(source.outputFormat), after: outputText(outputFormat) });
      return { kind: 'add', type: 'prompt', title: `New version "${name}" of "${nodeTitle(source)}"`, nodeIds: [node.nodeId],
        lines: diffs.length ? [] : ['Same content as the source prompt.'], diffs };
    },

    add_run(op) {
      if ('input_dataset' in op) fail('add_run reads input (a dataset, run or process) plus input_branch for a process branch; input_dataset is not used.');
      const prompt = op.prompt ? resolve(op.prompt, 'prompt', ['prompt']) : null;
      // As Create Generate in the Prompt window: the model picked beside it, else the Settings → Generate default
      // when it first runs. Number settings belong to the model (Settings), not to the Generate.
      if (op.credential_id != null) fail('Pass the model as model (a tested model id from the workspace summary), not credential_id.');
      if (op.settings != null) fail('A Generate uses its model\'s settings from Settings; settings cannot be set per Generate.');
      const model = op.model != null ? pickModel(op.model) : null;
      const runsOfPrompt = new Set(next.connections.filter((c) => c.type === 'prompt-to-run' && c.fromId === prompt?.nodeId).map((c) => c.toId));
      const name = uniqueName(generateDisplayName(op.name), takenNames('run', (n) => runsOfPrompt.has(n.nodeId)));
      const node = addNode({ type: 'run', nodeId: generateNodeId(), ...placeNear(prompt), runName: name, nodeOrigin: 'agent',
        ...(model ? { runCredentialId: model.id } : {}) });
      const source = op.input ? resolveSource(op.input, op.input_branch, 'input', node.nodeId) : null;
      if ((!prompt || !source) && Object.keys(op.input_mapping || {}).length) fail('Connect a Prompt and Data input before setting input_mapping.');
      const mapping = prompt && source ? validateMapping(prompt, source, op.input_mapping) : {};
      node.runInputToColumn = JSON.stringify(mapping);
      if (source) setRunInputSource(next, node.nodeId, source);
      if (prompt) connect(prompt.nodeId, node.nodeId, 'prompt-to-run');
      registerRef(op, node.nodeId);
      return {
        kind: 'add', type: 'run', title: `New Generate "${name}"`, nodeIds: [node.nodeId],
        lines: [
          prompt ? `Prompt "${nodeTitle(prompt)}"${source ? ` on "${stepSourceLabel(next, source)}"` : '; Data input not connected'}` : 'Prompt input not connected',
          ...(source ? [mappingLine(mapping, source)] : []),
          model ? `Model: ${modelLabel(model)}` : 'Model: the default Generate model (Settings → Generate)',
          'Not started: it runs when you start it.',
        ],
      };
    },

    add_score(op) {
      if (op.rule_tree !== undefined && clean(op.match_code)) fail('Use rule_tree or match_code, not both.');
      const run = resolve(op.run, 'run', ['run']);
      const groundTruth = resolve(op.ground_truth, 'ground_truth', ['dataset']);
      const name = uniqueName(clean(op.name) || 'Evaluate', takenNames('score'));
      const node = addNode({
        type: 'score', nodeId: generateNodeId(), ...placeNear(run), scoreName: name,
        scoreGroundTruthId: groundTruth.nodeId, nodeOrigin: 'agent',
      });
      let lines;
      let ruleDiffs = [];
      if (clean(op.match_code)) {
        if (!/^\s*def\s+match\s*\(/m.test(op.match_code)) fail('match_code must define match(input_row, output_row, gt_row).');
        node.scoreActiveMatchMode = 'code';
        node.scoreMatchCode = String(op.match_code);
        lines = ['Matches rows with custom match code'];
      } else {
        const bundle = scoreBundle(op, run, groundTruth);
        node.scoreMapping = bundle.mapping;
        lines = bundle.lines;
        ruleDiffs = bundle.diffs || [];
      }
      if (op.review_method != null) fail('An Optimize node uses the review method from Settings → Optimize; review_method cannot be set per Evaluate.');
      connect(run.nodeId, node.nodeId, 'run-to-score');
      registerRef(op, node.nodeId);
      return { kind: 'add', type: 'score', title: `New Evaluate "${name}"`, nodeIds: [node.nodeId],
        lines: [`Generate "${nodeTitle(run)}" vs ground truth "${nodeTitle(groundTruth)}"`, ...lines],
        diffs: node.scoreMatchCode ? [{ label: 'Match code', before: '', after: node.scoreMatchCode }] : ruleDiffs };
    },

    // Change what one input reads, as dragging a line onto that input on the canvas does.
    connect(op) {
      const node = resolve(op.node, 'node', ['run', 'process', 'score', 'sampler', 'promptReview']);
      touched.add(node.nodeId);
      const port = inputPortOf(op, node);
      const from = connectSource(op, node, port);
      const before = port.source ? sourceLabel(port.source) : '';
      const codeBefore = String(node.dfCode || '');
      const mappingBefore = String(node.runInputToColumn || '');
      const done = connectPort(from, node, port.id);
      const kind = byId().get(from.nodeId)?.type;
      const label = sourceLabel({ nodeId: from.nodeId, port: from.portId, kind });
      // An output dropped on + becomes an input under its own alias.
      const reader = nodePorts(next, node.nodeId).inputs.find((item) => item.source?.nodeId === from.nodeId && String(item.source.port || RESULT_PORT) === from.portId);
      const name = reader?.id || port.id;
      const lines = [!done ? `${name} already reads "${label}"; nothing changes.` : before ? `${name} reads "${label}" instead of "${before}"` : `${name} reads "${label}"`];
      const diffs = [];
      if (String(node.dfCode || '') !== codeBefore) {
        diffs.push({ label: 'Code', before: codeBefore, after: String(node.dfCode || '') });
        codeChanged.add(node.nodeId);
        if (port.id === '+') lines.push(`${name} is added to process()'s parameters.`);
      }
      if (node.type === 'run' && String(node.runInputToColumn || '') !== mappingBefore) {
        const source = runInputSource(next, node.nodeId);
        if (source) lines.push(mappingLine(parseJson(node.runInputToColumn, {}), source));
      }
      return { kind: 'update', type: node.type, title: `Connect ${nodeTypeLabel(node.type)} "${nodeTitle(node)}"`, nodeIds: [node.nodeId], lines, diffs };
    },

    // Leave one input empty, as dragging its line off on the canvas does.
    disconnect(op) {
      const node = resolve(op.node, 'node', ['run', 'process', 'score', 'sampler', 'promptReview']);
      if (node.type === 'score' && node.scoreMatchPending) fail(`Evaluate "${nodeTitle(node)}" is matching; stop it before changing its inputs.`);
      touched.add(node.nodeId);
      const port = inputPortOf(op, node);
      const result = checkDisconnect(next, { nodeId: node.nodeId, portId: port.id });
      if (!result.ok) fail(`${nodeTitle(node)}: ${result.reason}`);
      const label = sourceLabel(port.source);
      const codeBefore = String(node.dfCode || '');
      const mappingBefore = String(node.runInputToColumn || '');
      applyPortOp(next, result.op, { promptInputs: promptInputNames });
      const lines = [`${port.id} no longer reads "${label}"; it stays empty until something is connected.`];
      const diffs = [];
      if (String(node.dfCode || '') !== codeBefore) {
        diffs.push({ label: 'Code', before: codeBefore, after: String(node.dfCode || '') });
        codeChanged.add(node.nodeId);
        lines.push(`${port.id} is removed from process()'s parameters.`);
      }
      if (node.type === 'run' && String(node.runInputToColumn || '') !== mappingBefore) lines.push('Its column mapping is cleared.');
      return { kind: 'update', type: node.type, title: `Disconnect ${nodeTypeLabel(node.type)} "${nodeTitle(node)}"`, nodeIds: [node.nodeId], lines, diffs };
    },

    update(op) {
      const node = resolve(op.node, 'node');
      const set = op.set && typeof op.set === 'object' ? op.set : fail('update needs set: {field: value}.');
      const keys = Object.keys(set);
      if (!keys.length) fail('set is empty.');
      touched.add(node.nodeId);
      const before = nodeTitle(node);
      const lines = [];
      const diffs = [];
      const allowed = {
        prompt: ['name', 'note', 'text', 'text_edits', 'output'],
        dataset: ['name', 'note', 'columns', 'rows', 'row_ids'],
        process: ['name', 'code', 'primary_input', 'primary_branch'],
        run: ['name', 'prompt', 'input', 'input_branch', 'input_mapping', 'model'],
        score: ['name', 'ground_truth', 'pairing', 'comparison', 'combine', 'rule_tree', 'match_code', 'exclude_row_keys', 'include_row_keys'],
        sampler: ['name', 'sampling', 'size', 'size_unit', 'rows'],
        promptReview: ['name'],
      }[node.type] || [];
      if (node.type === 'run' && 'input_dataset' in set) fail('A run reads input (a dataset, run or process) plus input_branch for a process branch; input_dataset is not used.');
      if (node.type === 'prompt' && 'input_types' in set) fail(NO_INPUT_TYPES);
      const bad = keys.filter((k) => !allowed.includes(k));
      if (bad.length) fail(`A ${node.type} cannot set ${bad.join(', ')}. Settable: ${allowed.join(', ')}.`);
      if (node.type === 'score' && node.scoreMatchPending && keys.some((key) => key !== 'name')) fail(`Evaluate "${before}" is matching; stop it before changing its configuration.`);
      if (isTaskLocked(node.nodeId) && keys.some((key) => !['name', 'note'].includes(key))) fail(`"${before}" is part of a run in progress; stop the run before changing it.`);

      if ('name' in set) {
        const name = clean(set.name);
        if (!name) fail('name cannot be empty.');
        const field = { prompt: 'name', dataset: 'name', process: 'name', sampler: 'name', run: 'runName', score: 'scoreName', promptReview: 'promptReviewName' }[node.type];
        const taken = takenNames(node.type, (n) => n.nodeId !== node.nodeId);
        if (['prompt', 'dataset'].includes(node.type) && taken.has(name)) fail(`Another ${node.type} is already called "${name}".`);
        node[field] = name;
        lines.push(`Rename to "${name}"`);
      }
      if ('note' in set) {
        node.note = String(set.note ?? '');
        lines.push('Update the note');
      }

      // Include samples added earlier in this proposal as well as locks from existing History.
      const contentKeys = { prompt: ['text', 'text_edits', 'output'], dataset: ['columns', 'rows', 'row_ids'] }[node.type] || [];
      if (contentKeys.some((k) => k in set)) assertContentEditable(node);

      if (node.type === 'sampler' && ['sampling', 'size', 'size_unit', 'rows'].some((key) => key in set)) {
        if (sampledOutputs(next, node.nodeId).length) fail(`Sample "${before}" already has output Datasets, so its settings are locked. Create a new Sample instead.`);
        const spec = samplerSpec(set, node.sourceNodeId, node);
        node.samplingType = spec.samplingType;
        delete node.rowSpec;
        delete node.sampleSize;
        delete node.sampleSizeType;
        if (spec.samplingType === 'specify-rows') node.rowSpec = spec.rowSpec;
        else { node.sampleSize = spec.sampleSize; node.sampleSizeType = spec.sampleSizeType; }
        lines.push(formatSamplerModeSummary(node));
      }

      if (node.type === 'prompt') {
        if ('text' in set || 'text_edits' in set) {
          const text = nextText(node.text, set);
          diffs.push({ label: 'Prompt', before: String(node.text || ''), after: text });
          node.text = text;
        }
        if ('output' in set) {
          const outputFormat = normalizeOutput(set.output, node.outputFormat);
          diffs.push({ label: 'Output', before: outputText(node.outputFormat), after: outputText(outputFormat) });
          node.outputFormat = outputFormat;
        }
      }

      if (node.type === 'dataset' && ('columns' in set || 'rows' in set || 'row_ids' in set)) {
        const current = normalizeDatasetContent(node.datasetContent || { headers: [], rows: [] });
        const content = normalizeTable(set, current);
        const { headers, rows } = content;
        lines.push(`Replace the table: ${current.rows.length} → ${rows.length} rows; columns: ${headers.join(', ')}`);
        node.datasetContent = content;
      }

      if (node.type === 'process' && ('code' in set || 'primary_input' in set || 'primary_branch' in set)) {
        const current = processPrimarySource(next, node.nodeId);
        const primary = 'primary_input' in set || 'primary_branch' in set
          ? resolveSource(set.primary_input ?? current?.nodeId, set.primary_branch, 'primary_input', node.nodeId)
          : current;
        const code = 'code' in set ? String(set.code ?? '').trim() : String(node.dfCode || '');
        if ('code' in set) {
          diffs.push({ label: 'Code', before: String(node.dfCode || ''), after: code });
          codeChanged.add(node.nodeId);
        }
        if ('primary_input' in set || 'primary_branch' in set) lines.push(`df = "${stepSourceLabel(next, primary)}"`);
        lines.push(...wireProcess(node, code, primary).notes);
        if (node.dfResults) lines.push('Its last output no longer reflects the code until it is run again.');
      }

      if (node.type === 'run') {
        if (node.runPending) fail(`Generate "${before}" is running; stop it before changing it.`);
        if ('model' in set) {
          // A Generate keeps the model it started with; before its first run it is still the one Create Generate sets.
          if (runResultsExist(node) || node.runCompleted === true || node.runCompleted === '1' || node.runResumable
            || clean(node.historyRecordId) || clean(node.historyStaleRecordId)) {
            fail(`Generate "${before}" has already run, so its model is fixed. Add a new Generate (add_run) with that model instead.`);
          }
          const model = pickModel(set.model);
          node.runCredentialId = model.id;
          lines.push(`Model: ${modelLabel(model)}`);
        }
        if ('prompt' in set || 'input' in set || 'input_branch' in set || 'input_mapping' in set) {
          // As on the canvas: without History, a Generate's Prompt, input and mapping lock once it has results.
          if (next.historyVersion !== 1 && (runResultsExist(node) || node.runCompleted === true || node.runCompleted === '1')) {
            fail(`Generate "${before}" already has results, so its prompt, input and mapping are fixed. Add a new Generate (add_run) instead.`);
          }
          const currentPromptId = next.connections.find((c) => c.type === 'prompt-to-run' && c.toId === node.nodeId)?.fromId;
          const prompt = 'prompt' in set
            ? resolve(set.prompt, 'prompt', ['prompt'])
            : resolve(currentPromptId, 'the run\'s prompt', ['prompt']);
          const current = runInputSource(next, node.nodeId);
          if (!current && !('input' in set)) fail(`Generate "${before}" has no input; set input.`);
          const source = 'input' in set || 'input_branch' in set
            ? resolveSource(set.input ?? current.nodeId, set.input_branch, 'input', node.nodeId)
            : current;
          // A new Prompt keeps only the old mapping for inputs it shares, as connecting one on the canvas does.
          const oldMapping = parseJson(node.runInputToColumn, {});
          const keptMapping = prompt.nodeId === currentPromptId
            ? oldMapping
            : keepSharedMapping(oldMapping, promptInputs(prompt, ctx.extractInputFields));
          const mapping = validateMapping(prompt, source, set.input_mapping ?? keptMapping);
          // The connections change as dragging them on the canvas would (nodePorts.js); the mapping is the one checked above.
          if (prompt.nodeId !== currentPromptId) {
            connectPort({ nodeId: prompt.nodeId, portId: 'prompt' }, node, 'prompt');
            lines.push(`Prompt "${nodeTitle(prompt)}"`);
          }
          connectPort({ nodeId: source.nodeId, portId: source.port }, node, 'input');
          node.runInputToColumn = JSON.stringify(mapping);
          lines.push(`Input "${stepSourceLabel(next, source)}"`, mappingLine(mapping, source));
        }
      }

      if (node.type === 'score') {
        if (['exclude_row_keys', 'include_row_keys'].some((key) => key in set)) {
          if (keys.some((key) => !['name', 'exclude_row_keys', 'include_row_keys'].includes(key))) fail('Change row inclusion separately from Evaluate inputs or rules.');
          const excluded = { ...parseJson(node.scoreRowExcludedFromScoring, {}) };
          const run = next.nodes.find((item) => next.connections.some((edge) => edge.type === 'run-to-score' && edge.fromId === item.nodeId && edge.toId === node.nodeId));
          const gt = next.nodes.find((item) => item.nodeId === node.scoreGroundTruthId);
          const validKeys = new Set([
            ...(gt ? normalizeDatasetContent(gt.datasetContent || {}).rows.map((_, index) => String(index)) : []),
            ...runResultsOf(run).map((row) => `run:${row.row_index}`),
          ]);
          for (const key of ['exclude_row_keys', 'include_row_keys']) {
            if (!(key in set)) continue;
            if (!Array.isArray(set[key]) || set[key].some((value) => !validKeys.has(String(value)))) fail(`${key} must contain existing GT indices ("0", "1", ...) or model output row keys ("run:0", ...).`);
          }
          const exclude = (set.exclude_row_keys || []).map(String);
          const include = (set.include_row_keys || []).map(String);
          if (exclude.some((key) => include.includes(key))) fail('The same row cannot be included and excluded.');
          for (const key of exclude) excluded[key] = true;
          for (const key of include) delete excluded[key];
          node.scoreRowExcludedFromScoring = excluded;
          const describeKey = (key) => key.startsWith('run:') ? `Output row ${Number(key.slice(4)) + 1}` : `GT row ${Number(key) + 1}`;
          if (exclude.length) lines.push(`Exclude from scoring and future Optimize inputs: ${exclude.map(describeKey).join(', ')}.`);
          if (include.length) lines.push(`Re-include in scoring and future Optimize inputs: ${include.map(describeKey).join(', ')}.`);
          if (node.reviewResult) {
            const saved = parseJson(node.reviewResult, {});
            delete saved.comparison_rows;
            node.reviewResult = JSON.stringify(saved);
          }
        }
        if ('ground_truth' in set) {
          const gt = resolve(set.ground_truth, 'ground_truth', ['dataset']);
          // As connecting a ground truth on the canvas: rules on columns it lacks are dropped.
          connectPort({ nodeId: gt.nodeId, portId: RESULT_PORT }, node, 'ground_truth');
          lines.push(`Ground truth "${nodeTitle(gt)}"`);
        }
        if ('match_code' in set) {
          const code = String(set.match_code ?? '');
          if (code.trim()) {
            if (!/^\s*def\s+match\s*\(/m.test(code)) fail('match_code must define match(input_row, output_row, gt_row).');
            diffs.push({ label: 'Match code', before: String(node.scoreMatchCode || ''), after: code });
            node.scoreMatchCode = code;
            node.scoreActiveMatchMode = 'code';
          } else {
            delete node.scoreActiveMatchMode;
            lines.push('Match with rules instead of code');
          }
        }
        if ('rule_tree' in set || 'pairing' in set || 'comparison' in set || 'combine' in set) {
          if (!('comparison' in set) && !('rule_tree' in set)) fail('Changing score rules needs the full comparison list or rule_tree.');
          const previous = parseScoreMappingBundle(node.scoreMapping);
          if (!('rule_tree' in set) && [previous.inputRoot, previous.outputRoot].some((root) => root.children.some((child) => child.type === 'group'))) {
            fail('This Evaluate has nested groups. Read rules.ruleTree and edit it with rule_tree to preserve its logic.');
          }
          const run = resolve(next.connections.find((c) => c.type === 'run-to-score' && c.toId === node.nodeId)?.fromId, 'the score\'s run', ['run']);
          const gt = resolve(node.scoreGroundTruthId, 'the score\'s ground truth', ['dataset']);
          const bundle = scoreBundle(set, run, gt);
          if (!('rule_tree' in set) && !('pairing' in set)) {
            bundle.mapping.input = previous.inputRoot;
          }
          diffs.push({ label: 'Evaluate rules', before: JSON.stringify(node.scoreMapping || {}, null, 2), after: JSON.stringify(bundle.mapping, null, 2) });
          node.scoreMapping = bundle.mapping;
          delete node.scoreActiveMatchMode;
          lines.push(...bundle.lines);
        }
        if (['ground_truth', 'match_code', 'pairing', 'comparison', 'combine', 'rule_tree'].some((k) => k in set) && node.reviewResult) {
          lines.push('Run Evaluate again to save results for the new settings. Existing Optimize evidence stays fixed.');
          const saved = parseJson(node.reviewResult, {});
          delete saved.comparison_rows;
          node.reviewResult = JSON.stringify(saved);
        }
        if (['ground_truth', 'match_code', 'pairing', 'comparison', 'combine', 'rule_tree'].some((key) => key in set)) {
          delete node.scoreMatchResult;
          delete node.scoreMatchError;
          delete node.scoreMatchInterrupted;
        }
      }

      return { kind: 'update', type: node.type, title: `Change ${nodeTypeLabel(node.type)} "${before}"`, nodeIds: [node.nodeId], lines, diffs };
    },

    save_run_results(op) {
      const run = resolve(op.run, 'run', ['run']);
      if (run.runPending) fail(`Generate "${nodeTitle(run)}" is still running; save its results once it finishes.`);
      const results = runResultsOf(run);
      if (!results.length) fail(`Generate "${nodeTitle(run)}" has no results yet.`);
      if (!clean(run.historyRecordId)) fail(`Generate "${nodeTitle(run)}" has no History record. Run it again before saving its results.`);
      // The same table and note as Save results in the UI (savedDatasets.js).
      const saved = savedRunOutput(next, run.nodeId);
      const { table } = saved;
      const completed = run.runCompleted === true || run.runCompleted === '1';
      const name = uniqueName(clean(op.name) || saved.name, takenNames('dataset'));
      const node = addNode({
        type: 'dataset',
        nodeId: generateNodeId(),
        ...placeNear(run),
        name,
        note: String(op.note ?? saved.notes),
        savedFrom: saved.savedFrom,
        datasetContent: normalizeDatasetContent(table),
        nodeOrigin: 'agent',
      });
      registerRef(op, node.nodeId);
      const lines = [`${table.rows.length} rows from Generate "${nodeTitle(run)}"; ${table.headers.length} columns`];
      if (!completed) lines.push('The run did not finish, so only the rows it produced are saved.');
      return { kind: 'add', type: 'dataset', title: `Save the results of Generate "${nodeTitle(run)}" as "${name}"`, nodeIds: [node.nodeId], lines };
    },

    save_process_output(op) {
      const processNode = resolve(op.process, 'process', ['process']);
      const outputs = processOutputsOf(processNode);
      const branches = Object.keys(outputs);
      if (!branches.length) fail(`Process "${nodeTitle(processNode)}" has no output yet. Run it first.`);
      const branch = clean(op.branch) || (branches.length === 1 ? branches[0] : '');
      if (!branch) fail(`Process "${nodeTitle(processNode)}" has several branches (${branches.join(', ')}); name the branch to save.`);
      if (!outputs[branch]) fail(`Process "${nodeTitle(processNode)}" has no branch "${branch}". Branches: ${branches.join(', ')}.`);
      if (!clean(processNode.historyRecordId)) fail(`Process "${nodeTitle(processNode)}" has no History record. Run it again before saving its output.`);
      const title = nodeTitle(processNode);
      // The same Dataset as Save to workspace for this branch in the UI (savedDatasets.js).
      const [saved] = savedProcessOutputs(next, processNode.nodeId, { branch });
      const name = uniqueName(clean(op.name) || saved.name, takenNames('dataset'));
      const content = normalizeDatasetContent(saved.table);
      const node = addNode({
        type: 'dataset',
        nodeId: generateNodeId(),
        ...placeNear(processNode),
        name,
        note: String(op.note ?? saved.notes),
        savedFrom: saved.savedFrom,
        datasetContent: content,
        nodeOrigin: 'agent',
      });
      registerRef(op, node.nodeId);
      return {
        kind: 'add', type: 'dataset', title: `Save branch "${branch}" of process "${title}" as "${name}"`, nodeIds: [node.nodeId],
        lines: [`${content.rows.length} rows; columns: ${content.headers.join(', ')}`],
      };
    },

    save_score_results(op) {
      const score = resolve(op.score, 'score', ['score']);
      if (score.scoreMatchPending) fail(`Evaluate "${nodeTitle(score)}" is matching; save its results once it finishes.`);
      // The same Dataset as Save to workspace in the Evaluate window: the table of its displayed History record.
      const saved = ctx.scoreTables?.get(score.nodeId);
      if (!saved?.headers?.length) fail(`Evaluate "${nodeTitle(score)}" has no saved result. Run it first (run_nodes score).`);
      const title = nodeTitle(score);
      const name = uniqueName(clean(op.name) || `${title} comparison`, takenNames('dataset'));
      const content = normalizeDatasetContent({ headers: saved.headers, rows: saved.rows });
      const node = addNode({
        type: 'dataset',
        nodeId: generateNodeId(),
        ...placeNear(score),
        name,
        note: String(op.note ?? `Exported from Evaluate "${title}". Model outputs vs ground truth comparison.`),
        savedFrom: scoreSavedFrom(score.nodeId, saved.recordId),
        datasetContent: content,
        nodeOrigin: 'agent',
      });
      registerRef(op, node.nodeId);
      const lines = [`${content.rows.length} rows; columns: ${content.headers.join(', ')}`];
      if (saved.stale) lines.push('This is its last saved result; its rules or inputs have changed since (Needs update).');
      return { kind: 'add', type: 'dataset', title: `Save the comparison of Evaluate "${title}" as "${name}"`, nodeIds: [node.nodeId], lines };
    },

    apply_review(op) {
      const review = resolve(op.review, 'review', ['promptReview']);
      if (review.reviewPending) fail(`Optimize "${nodeTitle(review)}" is still running.`);
      const reviewResult = parseJson(review.reviewResult, {});
      const suggestions = Array.isArray(reviewResult.suggestions) ? reviewResult.suggestions : [];
      if (!suggestions.length) fail(`Optimize "${nodeTitle(review)}" has no suggestions.`);
      const ids = (Array.isArray(op.suggestion_ids) ? op.suggestion_ids : []).map(clean).filter(Boolean);
      if (!ids.length) fail('suggestion_ids must list the suggestions to apply.');
      const known = new Set(suggestions.map((s) => clean(s?.suggestion_id)));
      const unknown = ids.filter((id) => !known.has(id));
      if (unknown.length) fail(`Optimize "${nodeTitle(review)}" has no suggestion ${unknown.join(', ')}. Ids: ${[...known].join(', ')}.`);
      const score = byId().get(review.evaluateNodeId || next.connections.find((c) => c.type === 'score-to-prompt-review' && c.toId === review.nodeId)?.fromId);
      const applyBlockReason = optimizationApplyBlockReason(review, score);
      if (applyBlockReason) fail(applyBlockReason);
      const run = score ? byId().get(next.connections.find((c) => c.type === 'run-to-score' && c.toId === score.nodeId)?.fromId) : null;
      const source = run ? byId().get(next.connections.find((c) => c.type === 'prompt-to-run' && c.toId === run.nodeId)?.fromId) : null;
      if (!source) fail(`Optimize "${nodeTitle(review)}" is not connected through a score and run to a prompt.`);
      const snapshot = ctx.evaluationPrompts?.get(review.evaluateRecordId);
      if (review.evaluateRecordId && ctx.evaluationPrompts && !snapshot) fail('The original Prompt snapshot is unavailable. Refresh the proposal before applying.');
      const sourcePrompt = snapshot || source;
      const originalText = snapshot ? String(snapshot.text || '') : typeof reviewResult.promptText === 'string' && reviewResult.promptText.trim()
        ? reviewResult.promptText
        : String(source.text || '');
      const chosen = new Set(ids);
      const marked = suggestions.map((s) => ({ ...s, applied: chosen.has(clean(s?.suggestion_id)) }));
      const text = rebuildWorkingFromApplied(originalText, marked);
      if (text == null || text === originalText) {
        fail('None of the chosen suggestions could be applied: their text no longer matches the prompt the Optimize node analyzed.');
      }
      const unverified = ids.filter((id) => (reviewResult.verify_states?.[id] || '') !== 'verified');
      if (unverified.length) warnings.push(`Not verified yet: suggestion ${unverified.join(', ')}. Its effect on the failing rows is unknown until the new version is run.`);
      review.reviewResult = JSON.stringify({ ...reviewResult, suggestions: marked, workingText: text });
      const name = uniqueName(clean(op.name) || nodeTitle(sourcePrompt), takenNames('prompt'));
      const node = addNode({
        type: 'prompt', nodeId: generateNodeId(), ...placeNear(review), name,
        note: String(op.note ?? `Created from Optimize "${nodeTitle(review)}" (suggestions ${ids.join(', ')}).`),
        text: normalizeText(text),
        outputFormat: JSON.parse(JSON.stringify(sourcePrompt.outputFormat || { returnShape: 'single', fields: [] })),
        nodeOrigin: 'agent',
      });
      connect(review.nodeId, node.nodeId, 'prompt-review-to-prompt');
      registerRef(op, node.nodeId);
      return {
        kind: 'add', type: 'prompt', title: `New prompt "${name}" from Optimize "${nodeTitle(review)}"`, nodeIds: [node.nodeId],
        lines: [`Applies suggestion${ids.length === 1 ? '' : 's'} ${ids.join(', ')} to "${nodeTitle(source)}"`],
        diffs: [{ label: 'Prompt', before: originalText, after: text }],
      };
    },

    remove(op) {
      const node = resolve(op.node, 'node');
      if (node.type === 'run' && node.runPending) fail(`Generate "${nodeTitle(node)}" is running; stop it before removing it.`);
      if (node.type === 'promptReview' && node.reviewPending) fail(`Optimize "${nodeTitle(node)}" is running; stop it before removing it.`);
      if (node.type === 'score' && node.scoreMatchPending) fail(`Evaluate "${nodeTitle(node)}" is matching; stop it before removing it.`);
      const id = node.nodeId;
      const removingIds = new Set(operations.filter((operation) => operation?.op === 'remove')
        .map((operation) => clean(operation.node)).map((ref) => ref.startsWith('$') ? refs[ref] : ref));
      if (next.connections.some((edge) => edge.fromId === id && !removingIds.has(edge.toId))) {
        fail(`"${nodeTitle(node)}" is connected to downstream nodes. Disconnect them first, or remove them in the same proposal.`);
      }
      if (node.type === 'dataset' && next.nodes.some((other) => !removingIds.has(other.nodeId)
        && ((other.type === 'run' && runInputSource(next, other.nodeId)?.nodeId === id)
          || (other.type === 'score' && other.scoreGroundTruthId === id)))) {
        fail(`Dataset "${nodeTitle(node)}" is selected by a Generate or Evaluate. Disconnect it first, or remove the reader in the same proposal.`);
      }
      const lines = [];
      // Every step reading this node loses that input (a Process its df or its df_<alias> input).
      for (const edge of next.connections.filter((c) => c.type === DATA_EDGE && c.fromId === id)) {
        const reader = byId().get(edge.toId);
        if (!reader) continue;
        lines.push(reader.type === 'run' ? `Generate "${nodeTitle(reader)}" loses its input`
          : `Process "${nodeTitle(reader)}" loses its input ${edge.alias || 'df'}`);
      }
      for (const other of next.nodes) {
        if (other.type === 'score' && other.scoreGroundTruthId === id) {
          delete other.scoreGroundTruthId;
          lines.push(`Evaluate "${nodeTitle(other)}" loses its ground truth`);
        }
        if (other.type === 'dataset' && other.samplerNodeId === id) delete other.samplerNodeId;
      }
      for (const c of next.connections) {
        if (c.fromId !== id && c.toId !== id) continue;
        const other = byId().get(c.fromId === id ? c.toId : c.fromId);
        if (other && ['prompt-to-run', 'run-to-score', 'score-to-prompt-review'].includes(c.type) && c.fromId === id) {
          lines.push(`${nodeTypeLabel(other.type)} "${nodeTitle(other)}" is disconnected`);
        }
      }
      disconnectWhere((c) => c.fromId === id || c.toId === id);
      next.nodes = next.nodes.filter((n) => n.nodeId !== id);
      return { kind: 'remove', type: node.type, title: `Remove ${nodeTypeLabel(node.type)} "${nodeTitle(node)}"`, nodeIds: [id], lines };
    },
  };

  function runResultsExist(node) {
    const results = parseJson(node.runResults, []);
    return Array.isArray(results) && results.length > 0;
  }

  operations.forEach((op, index) => {
    const handler = handlers[clean(op?.op)];
    try {
      if (!handler) fail(`Unknown op "${clean(op?.op)}". Use one of: ${Object.keys(handlers).join(', ')}.`);
      const item = handler(op, index);
      items.push({ index, op: clean(op.op), diffs: [], lines: [], ...item });
    } catch (error) {
      if (error instanceof ChangeSetError && error.operationIndex == null) throw new ChangeSetError(error.message, index);
      throw error;
    }
  });

  const present = new Set(next.nodes.map((n) => n.nodeId));
  return { state: next, items, refs, warnings, nodeIds: [...touched].filter((id) => present.has(id)) };
}
