// Runs inside the capture page. Real AnnoBio front-end modules, with every backend call answered
// from the example data below, so the guide shows the actual UI without model calls.
import { buildWorkflowCanvas } from '/src/workflowCanvas.js';
import { buildTopBar } from '/src/topBar.js';
import { openSettingsModal } from '/src/settingsModal.js';
import { openAddPromptModal } from '/src/addPromptModal.js';
import { openAddDatasetModal } from '/src/addDatasetModal.js';
import { RunHistorySession } from '/src/runHistorySession.js';
import { setTheme } from '/src/theme.js';
import { initModalDrag } from '/src/modalDrag.js';
import { initModalMaximize } from '/src/modalMaximize.js';
import { setCurrentProjectId } from '/src/currentProject.js';

window.errors = [];
window.calls = [];
window.addEventListener('error', (e) => window.errors.push(e.error?.stack || e.message));
window.addEventListener('unhandledrejection', (e) => window.errors.push(e.reason?.stack || String(e.reason)));
window.alert = (message) => window.errors.push('alert: ' + String(message));

const PROJECT_ID = 'guide-example';
const MODEL = 'gpt-4.1-mini';

const ABSTRACTS = [
  ['P1', 'BRCA1 germline variants in early-onset breast cancer',
    'We sequenced BRCA1 in 412 women diagnosed with breast cancer before age 40. Pathogenic BRCA1 variants were found in 9% of cases and were enriched in triple-negative tumours. Carriers also had a higher lifetime risk of ovarian cancer.'],
  ['P2', 'CFTR genotype and lung function in cystic fibrosis',
    'Cystic fibrosis is caused by loss-of-function variants in CFTR. In a registry of 1,150 patients, homozygosity for F508del was associated with lower lung function than other CFTR genotypes.'],
  ['P3', 'APOE ε4 and amyloid burden in late-onset Alzheimer\u2019s disease',
    'Carriers of the APOE \u03b54 allele showed greater cortical amyloid on PET imaging and an earlier onset of Alzheimer\u2019s disease. After adjustment for age, CLU variants showed no association with disease risk.'],
  ['P4', 'HTT CAG repeat length and age of onset in Huntington\u2019s disease',
    'Expanded CAG repeats in HTT cause Huntington\u2019s disease. In 287 participants, longer repeats predicted earlier motor onset.'],
  ['P5', 'LRRK2 G2019S in familial Parkinson\u2019s disease',
    'We screened 600 families with Parkinson\u2019s disease for LRRK2 variants. The G2019S variant was the most common and segregated with disease in 14 families.'],
];

const REFERENCE = [
  ['P1', 'BRCA1', 'breast cancer'],
  ['P1', 'BRCA1', 'ovarian cancer'],
  ['P2', 'CFTR', 'cystic fibrosis'],
  ['P3', 'APOE', 'Alzheimer\u2019s disease'],
  ['P4', 'HTT', 'Huntington\u2019s disease'],
  ['P5', 'LRRK2', 'Parkinson\u2019s disease'],
];

// First Prompt version: reports alleles in the gene field and keeps a negative finding.
const OUTPUT_V1 = [
  [0, 'BRCA1', 'breast cancer', 'Pathogenic BRCA1 variants were found in 9% of cases'],
  [0, 'BRCA1', 'ovarian cancer', 'Carriers also had a higher lifetime risk of ovarian cancer.'],
  [1, 'CFTR', 'cystic fibrosis', 'Cystic fibrosis is caused by loss-of-function variants in CFTR.'],
  [2, 'APOE \u03b54', 'Alzheimer\u2019s disease', 'Carriers of the APOE \u03b54 allele showed greater cortical amyloid'],
  [2, 'CLU', 'Alzheimer\u2019s disease', 'CLU variants showed no association with disease risk.'],
  [3, 'HTT', 'Huntington\u2019s disease', 'Expanded CAG repeats in HTT cause Huntington\u2019s disease.'],
  [4, 'LRRK2 G2019S', 'Parkinson\u2019s disease', 'The G2019S variant was the most common and segregated with disease'],
];
const OUTPUT_V2 = [
  [0, 'BRCA1', 'breast cancer', 'Pathogenic BRCA1 variants were found in 9% of cases'],
  [0, 'BRCA1', 'ovarian cancer', 'Carriers also had a higher lifetime risk of ovarian cancer.'],
  [1, 'CFTR', 'cystic fibrosis', 'Cystic fibrosis is caused by loss-of-function variants in CFTR.'],
  [2, 'APOE', 'Alzheimer\u2019s disease', 'Carriers of the APOE \u03b54 allele showed greater cortical amyloid'],
  [3, 'HTT', 'Huntington\u2019s disease', 'Expanded CAG repeats in HTT cause Huntington\u2019s disease.'],
  [4, 'LRRK2', 'Parkinson\u2019s disease', 'The G2019S variant was the most common and segregated with disease'],
];

const PROMPT_TEXT = [
  'You are curating gene\u2013disease associations from biomedical abstracts.',
  '',
  'Title: {title}',
  'Abstract: {abstract}',
  '',
  'List every gene that the abstract reports as associated with a disease.',
  'Return one row per gene\u2013disease pair, with a short quote from the abstract as evidence.',
].join('\n');

const OLD_SENTENCE = 'List every gene that the abstract reports as associated with a disease.';
const NEW_SENTENCE = 'List every gene that the abstract reports as associated with a disease. Write the gene as its official HGNC symbol only (e.g. APOE, not \u201cAPOE \u03b54\u201d); keep variants and alleles in the evidence. Skip genes the abstract reports as not associated.';

const OUTPUT_FORMAT = {
  returnShape: 'table',
  fields: [
    { key: 'gene', type: 'str', description: 'Gene symbol, e.g. BRCA1.', examples: ['BRCA1', 'CFTR'] },
    { key: 'disease', type: 'str', description: 'Disease associated with the gene.', examples: ['breast cancer'] },
    { key: 'evidence', type: 'str', description: 'Short quote from the abstract supporting the association.', examples: [] },
  ],
};
const OUTPUT_FIELDS = OUTPUT_FORMAT.fields.map((f) => ({ key: f.key, display: f.key }));

const table = (headers, rows, prefix) => ({
  schemaVersion: 2,
  headers,
  columnTypes: headers.map(() => 'text'),
  rowIds: rows.map((_, i) => `${prefix}-${i + 1}`),
  rows,
});

const rule = (outputKey, gtColumn, flags = {}) => ({
  type: 'rule', outputKey, gtColumns: [gtColumn], matchType: 'exact',
  matchFlags: {
    semanticAlign: false, embeddingSimilarity: false, rxnormMatch: false, meshMatch: false, contains: false,
    ignoreCase: false, ignoreSymbols: false, ignoreWhitespace: false, numericMode: 'exact',
    numericAbsEpsilon: 0, numericRelEpsilon: 0, numericDecimalPlaces: 2, ...flags,
  },
});

export const SCORE_MAPPING = {
  v: 2,
  input: { type: 'group', ops: [], children: [rule('[ID]', 'ID')] },
  output: { type: 'group', ops: ['AND'], children: [rule('gene', 'Gene'), rule('disease', 'Disease', { ignoreCase: true })] },
};

const PROCESS_RENAME = { 'Input: ID': 'paper', 'Output: gene': 'gene', 'Output: disease': 'disease' };
const PROCESS_CODE = [
  'def process(df):',
  '    out = df.rename(columns={',
  ...Object.entries(PROCESS_RENAME).map(([from, to]) => `        "${from}": "${to}",`),
  '    })',
  '    out = out[["paper", "gene", "disease"]]',
  '    return out.drop_duplicates()',
].join('\n');

const AGENT_MESSAGES = [
  {
    role: 'user',
    content: 'Use disease_abstracts to extract gene\u2013disease pairs. Read Title and Abstract and return gene, disease, and a short evidence quote. One abstract may contain several pairs. Show me the proposed nodes before running anything.',
  },
  {
    role: 'assistant',
    content: [
      'Here is the plan. Nothing has been created or run yet.',
      '',
      '1. **Prompt** \u201cExtract gene\u2013disease pairs\u201d with inputs `{title}` and `{abstract}`, returning multiple rows with the fields `gene`, `disease`, and `evidence`.',
      '2. **Generate** connected to that Prompt and to **disease_abstracts**, mapping Title \u2192 `title` and Abstract \u2192 `abstract`, using gpt-4.1-mini.',
      '',
      'Shall I add these two nodes to the canvas? I will ask again before running Generate on the 5 abstracts.',
    ].join('\n'),
  },
];

window.fixture = {
  ABSTRACTS, REFERENCE, PROMPT_TEXT, OUTPUT_FORMAT, SCORE_MAPPING, PROCESS_CODE, OLD_SENTENCE, NEW_SENTENCE,
  dataset: table(['ID', 'Title', 'Abstract'], ABSTRACTS, 'abstract'),
  reference: table(['ID', 'Gene', 'Disease'], REFERENCE, 'reference'),
};

// ---- Backend stand-ins ---------------------------------------------------------------------

const credential = { id: 'cred-demo', model: MODEL, provider: 'openai', type: 'litellm', last_check_ok: true, api_key: 'example-only' };
const settings = {
  default_run_credential_id: credential.id, default_review_credential_id: credential.id, default_agent_credential_id: credential.id,
  run_max_tokens: 8192, run_max_retries: 2, run_concurrency: 4, review_max_tokens: 32768, python_path: 'python', model_settings: {},
};
window.mockState = { credentials: [credential] };

function runResultsFor(body) {
  const text = JSON.stringify(body);
  const outputs = text.includes('HGNC symbol') ? OUTPUT_V2 : OUTPUT_V1;
  return outputs.map(([input, gene, disease, evidence], i) => ({
    row_index: i, input_row_index: input, output: { gene, disease, evidence }, error: null,
  }));
}

function reviewEvents() {
  return [
    { type: 'plan', summary: 'Analyzing 2 papers with unmatched rows.', diagnosis_total: 2 },
    {
      type: 'diagnosis_row', input_index: 2, row_indices: [3, 4, 5], done: 1, total: 2,
      opinion: {
        card_title: 'Allele in gene field; negative finding extracted',
        issue_summary: 'The model wrote \u201cAPOE \u03b54\u201d instead of the gene symbol APOE, and listed CLU even though the abstract reports no association.',
        rough_modification_opinion: 'Ask for the official gene symbol only, and exclude genes reported as not associated.',
        problem_category_hint: 'format-and-scope',
        gt_suspect_note: '',
      },
    },
    {
      type: 'diagnosis_row', input_index: 4, row_indices: [7, 8], done: 2, total: 2,
      opinion: {
        card_title: 'Variant name in gene field',
        issue_summary: 'The model reported \u201cLRRK2 G2019S\u201d; the reference expects the gene symbol LRRK2.',
        rough_modification_opinion: 'Keep variant names in the evidence instead of the gene field.',
        problem_category_hint: 'format',
        gt_suspect_note: '',
      },
    },
    {
      type: 'suggestions',
      suggestions: [{
        name: 'Prompt edit',
        phase1_addresses: ['Allele in gene field; negative finding extracted', 'Variant name in gene field'],
        old_sentence: OLD_SENTENCE,
        new_sentence: NEW_SENTENCE,
        reason: 'Two of three failures put a variant or allele in the gene field, and one extracted a gene the abstract reports as not associated.',
        target_score_row_indices: [3, 4, 5, 7, 8],
        row_indices: [3, 4, 5, 7, 8],
        issue_cluster_index: 0,
        issue_cluster_label: 'gene-symbol-format',
      }],
    },
    { type: 'done' },
  ];
}

// The same result PROCESS_CODE gives in pandas.
function processOutput(body) {
  const { headers = [], rows = [] } = body;
  const columns = Object.entries(PROCESS_RENAME).map(([from, to]) => [headers.indexOf(from), to]);
  const seen = new Set();
  return rows
    .map((r) => Object.fromEntries(columns.map(([i, to]) => [to, r[i]])))
    .filter((r) => {
      const key = JSON.stringify(r);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

const lastCall = (suffix) => window.calls.filter((c) => c.url.endsWith(suffix) && c.method === 'POST').at(-1)?.body;
const originalFetch = window.fetch;
window.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (!u.includes('/api/')) return originalFetch(url, opts);
  let parsed = null;
  try { parsed = opts.body ? JSON.parse(opts.body) : null; } catch (_) { parsed = opts.body; }
  window.calls.push({ url: u, method: opts.method || 'GET', body: parsed });
  let body = {};
  let status = 200;
  if (u.endsWith('/api/settings')) body = settings;
  else if (u.endsWith('/api/credentials')) body = window.mockState.credentials;
  else if (u.includes('/api/credentials/')) body = credential;
  else if (u.includes('/api/review/methods')) body = [
    { id: 'issue_analysis_suggestions', label: 'Thompson Prompt Search (issue-guided local search)', name: 'Thompson Prompt Search', supports_segment_optimization: true },
    { id: 'gepa', label: 'GEPA (reflective evolution)', name: 'GEPA' },
    { id: 'miprov2', label: 'MIPROv2 (instructions + few-shot)', name: 'MIPROv2' },
  ];
  else if (u.includes('/agent-conversations')) body = {
    format_version: 2, activeConversationId: 'guide',
    conversations: [{ id: 'guide', title: 'Gene\u2013disease pipeline', updatedAt: Date.now(), messages: AGENT_MESSAGES, unsentDraft: '' }],
  };
  else if (u.includes('agent-hints')) body = {};
  else if (u.includes('/api/agent/context')) body = { context_window: 128000 };
  else if (u.endsWith('/api/process/outputs')) body = { ports: ['result'], dynamic: false, error: '' };
  else if (u.endsWith('/api/process/df/run') && opts.method === 'POST') { body = { job_id: 'process-job' }; status = 202; }
  else if (u.includes('/api/process/df/run/result/')) body = { status: 'done', outputs: { result: processOutput(lastCall('/api/process/df/run')) } };
  else if (u.endsWith('/api/run') && opts.method === 'POST') { body = { run_id: 'run-job-' + window.calls.length }; status = 202; }
  else if (u.includes('/api/run/result/by-node/')) { body = { detail: 'Run not found' }; status = 404; }
  else if (u.includes('/api/run/result/')) {
    const results = runResultsFor(lastCall('/api/run'));
    body = { status: 'done', progress: 100, completed: ABSTRACTS.length, total: ABSTRACTS.length, results, output_fields: OUTPUT_FIELDS };
  }
  else if (u.endsWith('/api/review/analyze')) { body = { review_id: 'review-job', review_method_id: 'issue_analysis_suggestions' }; status = 202; }
  else if (u.includes('/api/review/result/')) body = { status: 'done', events: reviewEvents() };
  else if (u.includes('/api/projects/') && u.endsWith('/run-records')) body = { version: 1, records: [] };
  else if (opts.method && opts.method !== 'GET') body = {};
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
};

// ---- Application shell ---------------------------------------------------------------------

const params = new URLSearchParams(location.search);
if (params.has('desktop')) {
  window.electronAPI = {
    platform: 'win32',
    isWindowMaximized: async () => false,
    onWindowMaximizedChanged: () => {},
  };
}
localStorage.clear();
localStorage.setItem('annobio.workspacePanels.v1', JSON.stringify({
  agent: params.has('agent'), pipeline: params.has('panel'), height: 300, width: 460, tab: params.get('panel') || 'pipeline',
}));
setTheme('light');
initModalDrag();
initModalMaximize();
setCurrentProjectId(PROJECT_ID);

const canvas = buildWorkflowCanvas(document.querySelector('#surface'), { getCurrentProjectPath: () => PROJECT_ID, isElectron: false });
const top = buildTopBar(document.querySelector('#bar'), {
  openAddPromptModal: () => openAddPromptModal(canvas),
  openAddDatasetModal: () => openAddDatasetModal(canvas),
  onNewProject: () => {}, onOpenProject: () => {}, panelToggles: canvas.panelToggles,
});
top.setProjectTitle(params.get('title') || 'Gene\u2013Disease Associations');
top.setAddMenuEnabled(true);

const records = [];
const session = new RunHistorySession({
  loadIndex: async () => ({ version: 1, records: records.map((r) => ({ ...r })) }),
  loadRecord: async (_p, id) => records.find((r) => r.id === id),
  saveRecord: async (_p, r) => { const i = records.findIndex((x) => x.id === r.id); if (i < 0) records.push(r); else records[i] = r; },
  deleteRecords: async () => {},
  saveCanvas: async () => {},
});

window.app = {
  canvas, top, session, records,
  openSettingsModal, openAddPromptModal: () => openAddPromptModal(canvas), openAddDatasetModal: () => openAddDatasetModal(canvas),
  async load(state) {
    canvas.loadCanvasState(state);
    const resolved = await session.open(PROJECT_ID, canvas.getCanvasState());
    canvas.setHistorySession(session);
    canvas.loadCanvasState(resolved.state);
    await canvas.syncProjectPanels?.();
  },
  node: (id) => document.querySelector(`.workflow-node[data-node-id="${id}"]`),
  state: () => canvas.getCanvasState(),
  closeDialogs: () => document.querySelectorAll('.modal-overlay .modal-close').forEach((b) => b.click()),
};

await window.app.load({ schemaVersion: 3, version: 3, historyVersion: 1, zoomLevel: 1, nodes: [], connections: [] });
window.ready = true;
