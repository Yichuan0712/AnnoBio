// Each scene opens a fresh page, builds as much of the example project as it needs through the
// real canvas actions, and saves one screenshot named after the scene.

const AGENT_PANEL = '?agent=1';

async function buildBase({ evaluate }, layout = {}) {
  const at = { prompt: [60, 90], abstracts: [60, 320], generate: [380, 190], ...layout };
  await evaluate(`
    const f = window.fixture;
    await window.app.load({
      schemaVersion: 3, version: 3, historyVersion: 1, zoomLevel: ${layout.zoom ?? 1},
      nodes: [
        { type: 'prompt', nodeId: 'prompt', name: 'Extract gene\u2013disease pairs', note: 'One row per supported pair.', left: ${at.prompt[0]}, top: ${at.prompt[1]}, colorIndex: 0, text: f.PROMPT_TEXT, outputFormat: f.OUTPUT_FORMAT, inputTypes: {} },
        { type: 'dataset', nodeId: 'abstracts', name: 'disease_abstracts', note: 'Five example abstracts.', left: ${at.abstracts[0]}, top: ${at.abstracts[1]}, colorIndex: 1, datasetContent: f.dataset },
        { type: 'run', nodeId: 'generate', runName: 'Generate', left: ${at.generate[0]}, top: ${at.generate[1]}, runCredentialId: 'cred-demo', runInputToColumn: JSON.stringify({ title: 'Title', abstract: 'Abstract' }) },
      ],
      connections: [
        { type: 'prompt-to-run', fromId: 'prompt', toId: 'generate' },
        { type: 'data', fromId: 'abstracts', fromPort: 'result', toId: 'generate' },
      ],
    });
    return true;`);
}

async function runGenerate({ evaluate, until, wait }, id = 'generate') {
  await evaluate(`await window.app.canvas.startRunNode({ runNodeId: '${id}' }); return true;`);
  await until(`window.app.node('${id}').dataset.runCompleted === '1'`);
  await wait(300);
}

async function addProcess({ evaluate, until, wait }, at = [720, 190]) {
  await evaluate(`
    const s = window.app.state();
    s.nodes.push({ type: 'process', nodeId: 'process', name: 'Tidy pairs', left: ${at[0]}, top: ${at[1]}, activeMode: 'df', dfCode: window.fixture.PROCESS_CODE });
    s.connections.push({ type: 'data', fromId: 'generate', fromPort: 'result', toId: 'process', alias: 'df' });
    await window.app.load(s);
    await window.app.canvas.runProcessNode('process');
    return true;`);
  await until(`window.app.records.some(r => r.kind === 'process' && r.status === 'completed')`);
  await wait(300);
}

async function addEvaluate({ evaluate, wait }, at = { reference: [380, 430], evaluate: [720, 190] }) {
  await evaluate(`
    const s = window.app.state();
    s.nodes.push({ type: 'dataset', nodeId: 'reference', name: 'Reviewed pairs', note: 'Expected pairs, checked by a curator.', left: ${at.reference[0]}, top: ${at.reference[1]}, colorIndex: 3, datasetContent: window.fixture.reference });
    s.nodes.push({ type: 'score', nodeId: 'evaluate', scoreName: 'Evaluate pairs', left: ${at.evaluate[0]}, top: ${at.evaluate[1]}, scoreGroundTruthId: 'reference', scoreMapping: JSON.stringify(window.fixture.SCORE_MAPPING), reviewMethod: 'issue_analysis_suggestions', reviewCredentialId: 'cred-demo' });
    s.connections.push({ type: 'run-to-score', fromId: 'generate', toId: 'evaluate' });
    await window.app.load(s);
    return true;`);
  await wait(300);
}

/** Opens Evaluate and runs it; the Evaluate window stays open. */
async function runEvaluate({ evaluate, wait, click, until }, id = 'evaluate', count = 1) {
  await evaluate(`window.app.node('${id}').click(); return true;`);
  await wait(600);
  await click('.score-detail-code-run-btn');
  await until(`window.app.records.filter(r => r.kind === 'score' && r.status === 'completed').length === ${count}`);
  await wait(800);
}

/** Starts Optimize from the open Evaluate window and places the new node at `at`. */
async function runOptimize({ evaluate, wait, click, until }, at = [1040, 190]) {
  await click('#score-detail-add-prompt-review');
  await until(`window.app.state().nodes.some(n => n.type === 'promptReview' && n.reviewProgress === 100)`, 20000);
  await wait(300);
  await evaluate(`
    window.app.closeDialogs();
    const s = window.app.state();
    const opt = s.nodes.find(n => n.type === 'promptReview');
    window.app.optimizeId = opt.nodeId;
    opt.left = ${at[0]}; opt.top = ${at[1]};
    await window.app.load(s);
    return true;`);
  await wait(300);
}

async function openOptimize({ evaluate, wait }, tab) {
  await evaluate(`window.app.node(window.app.optimizeId).click(); return true;`);
  await wait(700);
  await evaluate(`[...document.querySelectorAll('.review-detail-tab')].find(b => b.textContent.trim() === ${JSON.stringify(tab)}).click(); return true;`);
  await wait(500);
}

async function acceptSuggestion({ click, wait }) {
  await click('.review-detail-accept-btn');
  await wait(600);
}

export const scenes = [
  {
    name: 'empty-canvas',
    async run({ open, shot }) {
      await open();
      await shot('empty-canvas');
    },
  },
  {
    name: 'llm-settings',
    async run({ open, evaluate, wait, shot }) {
      await open();
      await evaluate(`window.app.openSettingsModal(); return true;`);
      await wait(800);
      await shot('llm-settings');
    },
  },
  {
    name: 'add-dataset-modal',
    async run({ open, evaluate, wait, click, shot }) {
      await open();
      await evaluate(`
        window.app.openAddDatasetModal();
        await new Promise(r => setTimeout(r, 400));
        const set = (sel, value) => { const el = document.querySelector(sel); el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); };
        set('#dataset-name-input', 'disease_abstracts');
        set('#dataset-notes-input', 'Five example abstracts.');
        return true;`);
      await click('.dataset-add-btn-next');
      await wait(700);
      await shot('add-dataset-modal');
    },
  },
  {
    name: 'dataset-table',
    async run(ctx) {
      const { open, evaluate, wait, shot } = ctx;
      await open();
      await buildBase(ctx);
      await evaluate(`window.app.node('abstracts').click(); return true;`);
      await wait(700);
      // Maximize the real table and resize through the same handles a reader can drag.
      await evaluate(`
        document.querySelector('.modal-overlay .modal-maximize').click();
        return true;`);
      await wait(150);
      await evaluate(`
        const wrap = document.querySelector('.working-dataset-table-wrap');
        const style = getComputedStyle(wrap);
        const available = wrap.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
        const widths = [60, 300, Math.floor(available) - 400];
        const handles = [...document.querySelectorAll('.wd-header-row .wd-col-resize-handle')];
        handles.forEach((handle, i) => {
          handle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 100 }));
          document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 100 + widths[i] - 140 }));
          document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        });
        for (const row of document.querySelectorAll('.wd-tbody tr')) {
          const height = row.querySelector('.wd-cell-textarea').offsetHeight;
          row.querySelector('.wd-row-resize-handle').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientY: 100 }));
          document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientY: 100 + 68 - height }));
          document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        }
        return true;`);
      await wait(300);
      await shot('dataset-table');
    },
  },
  {
    name: 'add-prompt-modal',
    async run(ctx) {
      const { open, evaluate, wait, shot } = ctx;
      await open();
      await buildBase(ctx);
      await evaluate(`window.app.node('prompt').click(); return true;`);
      await wait(700);
      await evaluate(`document.querySelector('.modal-overlay .modal-maximize').click(); return true;`);
      await wait(150);
      await shot('add-prompt-modal');
    },
  },
  {
    name: 'canvas-connected',
    async run(ctx) {
      await ctx.open();
      await buildBase(ctx);
      await ctx.shot('canvas-connected');
    },
  },
  {
    name: 'run-results',
    async run(ctx) {
      const { open, evaluate, wait, shot } = ctx;
      await open();
      await buildBase(ctx);
      await runGenerate(ctx);
      await evaluate(`window.app.node('generate').click(); return true;`);
      await wait(700);
      await shot('run-results');
    },
  },
  {
    name: 'process-node',
    async run(ctx) {
      const { open, evaluate, wait, shot } = ctx;
      await open();
      await buildBase(ctx);
      await runGenerate(ctx);
      await addProcess(ctx);
      await evaluate(`window.app.node('process').click(); return true;`);
      await wait(900);
      await shot('process-node');
    },
  },
  {
    name: 'pipeline-overview',
    async run(ctx) {
      const { open, wait, shot } = ctx;
      await open('?panel=pipeline');
      await buildBase(ctx, { prompt: [60, 40], abstracts: [60, 240], generate: [380, 120] });
      await runGenerate(ctx);
      await addProcess(ctx, [720, 120]);
      await wait(800);
      await shot('pipeline-overview');
    },
  },
  {
    name: 'review-method-picker',
    async run(ctx) {
      await ctx.open();
      await buildBase(ctx);
      await runGenerate(ctx);
      await addEvaluate(ctx);
      await runEvaluate(ctx);
      await ctx.shot('review-method-picker');
    },
  },
  {
    name: 'optimize-findings',
    async run(ctx) {
      await ctx.open();
      await buildBase(ctx);
      await runGenerate(ctx);
      await addEvaluate(ctx);
      await runEvaluate(ctx);
      await runOptimize(ctx);
      await openOptimize(ctx, 'Issue analysis');
      await ctx.shot('optimize-findings');
    },
  },
  {
    name: 'optimize-suggestion',
    async run(ctx) {
      await ctx.open();
      await buildBase(ctx);
      await runGenerate(ctx);
      await addEvaluate(ctx);
      await runEvaluate(ctx);
      await runOptimize(ctx);
      await openOptimize(ctx, 'Suggested changes');
      await acceptSuggestion(ctx);
      await ctx.shot('optimize-suggestion');
    },
  },
  {
    name: 'prompt-versions',
    async run(ctx) {
      const { open, evaluate, wait, click, until, shot } = ctx;
      await open('?panel=optimization');
      await buildBase(ctx, { zoom: 0.68, prompt: [40, 30], abstracts: [40, 230], generate: [330, 110] });
      await runGenerate(ctx);
      await addEvaluate(ctx, { reference: [330, 380], evaluate: [640, 110] });
      await runEvaluate(ctx);
      await runOptimize(ctx, [950, 110]);
      await openOptimize(ctx, 'Suggested changes');
      await acceptSuggestion(ctx);
      await click('.review-detail-export-btn');
      await until(`window.app.state().nodes.some(n => n.type === 'prompt' && n.nodeId !== 'prompt')`);
      await wait(500);
      await evaluate(`
        const s = window.app.state();
        const v2 = s.nodes.find(n => n.type === 'prompt' && n.nodeId !== 'prompt');
        v2.left = 1260; v2.top = 110;
        s.nodes.push({ type: 'run', nodeId: 'generate2', runName: 'Generate', left: 1260, top: 290, runCredentialId: 'cred-demo', runInputToColumn: JSON.stringify({ title: 'Title', abstract: 'Abstract' }) });
        s.nodes.push({ type: 'score', nodeId: 'evaluate2', scoreName: 'Evaluate pairs v2', left: 1570, top: 290, scoreGroundTruthId: 'reference', scoreMapping: JSON.stringify(window.fixture.SCORE_MAPPING), reviewMethod: 'issue_analysis_suggestions', reviewCredentialId: 'cred-demo' });
        s.connections.push({ type: 'prompt-to-run', fromId: v2.nodeId, toId: 'generate2' });
        s.connections.push({ type: 'data', fromId: 'abstracts', fromPort: 'result', toId: 'generate2' });
        s.connections.push({ type: 'run-to-score', fromId: 'generate2', toId: 'evaluate2' });
        await window.app.load(s);
        return true;`);
      await runGenerate(ctx, 'generate2');
      await runEvaluate(ctx, 'evaluate2', 2);
      await evaluate(`window.app.closeDialogs(); return true;`);
      await wait(1200);
      await shot('prompt-versions');
    },
  },
  {
    name: 'home-pipeline',
    viewport: { width: 1180, height: 760 },
    async run(ctx) {
      const { open, evaluate, until, wait, shot } = ctx;
      await open('?title=Gene%E2%80%93Disease%20Evidence');
      await evaluate(`
        const f = window.fixture;
        await window.app.load({
          schemaVersion: 3, version: 3, historyVersion: 1, zoomLevel: 1,
          nodes: [
            { type: 'prompt', nodeId: 'prompt', name: 'Extract associations', note: 'Gene, disease, and evidence', left: 64, top: 82, colorIndex: 0, text: f.PROMPT_TEXT.replace(f.OLD_SENTENCE, f.NEW_SENTENCE), outputFormat: f.OUTPUT_FORMAT, inputTypes: {} },
            { type: 'dataset', nodeId: 'abstracts', name: 'Biomedical abstracts', note: 'Five example research records', left: 64, top: 342, colorIndex: 1, datasetContent: f.dataset },
            { type: 'run', nodeId: 'generate', runName: 'Extract relations', left: 365, top: 205, runCredentialId: 'cred-demo', runInputToColumn: JSON.stringify({ title: 'Title', abstract: 'Abstract' }) },
            { type: 'process', nodeId: 'process', name: 'Tidy extracted pairs', left: 735, top: 205, activeMode: 'df', dfCode: f.PROCESS_CODE },
            { type: 'dataset', nodeId: 'reference', name: 'Reviewed pairs', note: 'Curator-checked reference data', left: 365, top: 500, colorIndex: 3, datasetContent: f.reference },
            { type: 'score', nodeId: 'evaluate', scoreName: 'Evaluate extraction', left: 735, top: 460, scoreGroundTruthId: 'reference', scoreMapping: JSON.stringify(f.SCORE_MAPPING), reviewMethod: 'issue_analysis_suggestions', reviewCredentialId: 'cred-demo' },
          ],
          connections: [
            { type: 'prompt-to-run', fromId: 'prompt', toId: 'generate' },
            { type: 'data', fromId: 'abstracts', fromPort: 'result', toId: 'generate' },
            { type: 'data', fromId: 'generate', fromPort: 'result', toId: 'process', alias: 'df' },
            { type: 'run-to-score', fromId: 'generate', toId: 'evaluate' },
          ],
        });
        return true;`);
      await runGenerate(ctx);
      await evaluate(`await window.app.canvas.runProcessNode('process'); return true;`);
      await until(`window.app.records.some(r => r.kind === 'process' && r.status === 'completed')`);
      await runEvaluate(ctx);
      await evaluate(`window.app.closeDialogs(); return true;`);
      await wait(500);
      await evaluate(`
        const clipped = [...document.querySelectorAll('.workflow-node')].filter(n => {
          const r = n.getBoundingClientRect();
          return r.left < 20 || r.right > innerWidth - 20 || r.top < 64 || r.bottom > innerHeight - 20;
        }).map(n => n.dataset.nodeId);
        if (clipped.length) throw new Error('Clipped home nodes: ' + clipped.join(', '));
        return true;`);
      await shot('home-pipeline');
    },
  },
  {
    name: 'agent-assistant',
    async run(ctx) {
      await ctx.open(AGENT_PANEL);
      await buildBase(ctx);
      await ctx.wait(800);
      await ctx.shot('agent-assistant');
    },
  },
];


// The home carousel uses a consistent, closer viewport; guide figures retain their wider context.
scenes.push({
  name: 'home-prompt',
  viewport: { width: 1180, height: 760 },
  async run({ open, evaluate, wait, shot }) {
    await open('?title=Biomedical%20Evidence%20Curation');
    await evaluate(`
      const text = [
        'Task',
        'Curate gene-disease associations for a systematic evidence review using only the supplied record.',
        '',
        'Source record',
        'Record ID: {record_id}',
        'Title: {title}',
        'Abstract: {abstract}',
        '',
        'Annotation rules',
        '1. Extract study findings; exclude background mentions, negated associations, and speculative hypotheses.',
        '2. Use an HGNC symbol only when unambiguous from the text. Keep variant and allele names in evidence; never invent identifiers.',
        '3. Preserve the reported disease and population/model context. Distinguish association from explicitly supported causal, susceptibility, or protective relations.',
        '4. Quote supporting text verbatim. Flag unresolved entity mapping or contradictory findings in review_note; use null when no review is needed.',
        '',
        'Output contract',
        'Return one row per distinct, directly supported gene-disease pair using the configured schema. Include gene, disease, relation, evidence, and review_note. Return an empty table when no pair qualifies.',
      ].join('\\n');
      await window.app.load({
        schemaVersion: 3, version: 3, historyVersion: 1, zoomLevel: 1,
        nodes: [{ type: 'prompt', nodeId: 'evidence-protocol', name: 'Curate gene-disease evidence', left: 64, top: 82, colorIndex: 0, text,
          outputFormat: { returnShape: 'table', fields: [
            { key: 'gene', type: 'str', description: 'Supported HGNC symbol or reported gene mention.', examples: ['BRCA1'] },
            { key: 'disease', type: 'str', description: 'Disease or phenotype as reported.', examples: ['breast cancer'] },
            { key: 'relation', type: 'str', description: 'association, causal, susceptibility, or protective.', examples: ['association'] },
            { key: 'evidence', type: 'str', description: 'Verbatim supporting quote with reported context.', examples: [] },
            { key: 'review_note', type: 'str', allowNone: true, description: 'Unresolved ambiguity; null when no review is needed.', examples: [] },
          ] }, inputTypes: {} }],
        connections: [],
      });
      window.app.node('evidence-protocol').click();
      return true;`);
    await wait(700);
    await evaluate(`document.querySelector('.modal-overlay .modal-maximize').click(); return true;`);
    await wait(150);
    await shot('home-prompt');
  },
});

scenes.push({
  name: 'home-dataset',
  viewport: { width: 1180, height: 760 },
  async run({ open, evaluate, wait, shot }) {
    await open('?title=Biomedical%20Evidence%20Review');
    await evaluate(`
      const contexts = ['Early-onset cases; n=412', 'CF registry; n=1,150', 'APOE allele; PET imaging', 'HTT repeats; n=287', 'Familial PD; 600 families'];
      const rows = window.fixture.ABSTRACTS.map((row, i) => [
        'EX-' + String(i + 1).padStart(3, '0'), contexts[i], row[1], row[2],
      ]);
      await window.app.load({
        schemaVersion: 3, version: 3, historyVersion: 1, zoomLevel: 1,
        nodes: [{ type: 'dataset', nodeId: 'evidence-corpus', name: 'Gene-disease evidence corpus', note: 'Synthetic study records for evidence curation', left: 64, top: 82, colorIndex: 1,
          datasetContent: { schemaVersion: 2, headers: ['record_id', 'study_context', 'title', 'abstract'], columnTypes: ['text', 'text', 'text', 'text'], rowIds: rows.map((_, i) => 'evidence-' + i), rows } }],
        connections: [],
      });
      window.app.node('evidence-corpus').click();
      return true;`);
    await wait(600);
    await evaluate(`document.querySelector('.modal-overlay .modal-maximize').click(); return true;`);
    await wait(150);
    await evaluate(`
      const wrap = document.querySelector('.working-dataset-table-wrap');
      const style = getComputedStyle(wrap);
      const available = wrap.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const widths = [88, 160, 255, Math.floor(available) - 543];
      [...document.querySelectorAll('.wd-header-row .wd-col-resize-handle')].forEach((handle, i) => {
        handle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 100 }));
        document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 100 + widths[i] - 140 }));
        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      });
      for (const row of document.querySelectorAll('.wd-tbody tr')) {
        const height = row.querySelector('.wd-cell-textarea').offsetHeight;
        row.querySelector('.wd-row-resize-handle').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientY: 100 }));
        document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientY: 100 + 70 - height }));
        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      }
      return true;`);
    await wait(250);
    await shot('home-dataset');
  },
});

scenes.push({
  name: 'home-optimize',
  viewport: { width: 1180, height: 760 },
  async run(ctx) {
    const { open, evaluate, wait, click, shot } = ctx;
    await open('?evidence-review=1&title=Evidence-guided%20Prompt%20Revision');
    await evaluate(`window.fixture.PROMPT_TEXT = window.fixture.HOME_REVIEW_PROTOCOL.prompt; return true;`);
    await buildBase(ctx);
    await runGenerate(ctx);
    await addEvaluate(ctx);
    await runEvaluate(ctx);
    await runOptimize(ctx);
    await evaluate(`
      const state = window.app.state();
      state.nodes.find(n => n.nodeId === window.app.optimizeId).promptReviewName = 'Evidence-guided revision';
      await window.app.load(state);
      return true;`);
    await openOptimize(ctx, 'Suggested changes');
    await evaluate(`document.querySelector('.modal-overlay .modal-maximize').click(); return true;`);
    for (let i = 0; i < 2; i++) {
      await click('.review-detail-accept-btn:not(.review-detail-accept-btn--revert)');
      await wait(250);
    }
    await evaluate(`
      if (document.querySelectorAll('.review-detail-accept-btn--revert').length !== 2) throw new Error('Both protocol edits must be selected.');
      return true;`);
    await shot('home-optimize');
  },
});

for (const [name, source] of [
  ['home-evaluation', 'review-method-picker'],
  ['home-agent', 'agent-assistant'],
]) {
  const scene = scenes.find(item => item.name === source);
  scenes.push({
    name,
    viewport: { width: 1180, height: 760 },
    run: ctx => scene.run({ ...ctx, shot: async () => {
      if (name === 'home-evaluation') {
        await ctx.click('.modal-overlay .modal-maximize');
        await ctx.wait(200);
      }
      await ctx.shot(name);
    } }),
  });
}

scenes.push({
  name: 'agent-welcome',
  async run(ctx) {
    await ctx.open('?agent=1&welcome=1');
    await ctx.until(`document.querySelector('.agent-window__welcome')`);
    await ctx.shot('agent-welcome');
  },
});

// README hero (not a guide figure): the full evaluate -> optimize -> re-evaluate loop, with the
// Agent comparing versions and the Prompt version chain below. To refresh the README image:
//   node scripts/guide-screenshots/capture.mjs --out <tmp> readme-hero, then copy readme-hero.png
//   to images/screenshot.png.
scenes.push({
  name: 'readme-hero',
  viewport: { width: 1920, height: 940 },
  async run(ctx) {
    const { open, evaluate, wait, click, until, shot } = ctx;
    await open('?agent=1&hero=1&panel=optimization&panelHeight=230&title=Gene%E2%80%93Disease%20Evidence%20Curation');
    await buildBase(ctx, { zoom: 0.66 });
    await runGenerate(ctx);
    await addProcess(ctx);
    await addEvaluate(ctx);
    await runEvaluate(ctx);
    await runOptimize(ctx);
    await openOptimize(ctx, 'Suggested changes');
    await acceptSuggestion(ctx);
    await click('.review-detail-export-btn');
    await until(`window.app.state().nodes.some(n => n.type === 'prompt' && n.nodeId !== 'prompt')`);
    await wait(500);
    await evaluate(`
      const s = window.app.state();
      const v2 = s.nodes.find(n => n.type === 'prompt' && n.nodeId !== 'prompt');
      window.app.v2Id = v2.nodeId;
      s.nodes.push({ type: 'run', nodeId: 'generate2', runName: 'Generate v2', left: 0, top: 0, runCredentialId: 'cred-demo', runInputToColumn: JSON.stringify({ title: 'Title', abstract: 'Abstract' }) });
      s.nodes.push({ type: 'score', nodeId: 'evaluate2', scoreName: 'Evaluate v2', left: 0, top: 0, scoreGroundTruthId: 'reference', scoreMapping: JSON.stringify(window.fixture.SCORE_MAPPING), reviewMethod: 'issue_analysis_suggestions', reviewCredentialId: 'cred-demo' });
      s.connections.push({ type: 'prompt-to-run', fromId: v2.nodeId, toId: 'generate2' });
      s.connections.push({ type: 'data', fromId: 'abstracts', fromPort: 'result', toId: 'generate2' });
      s.connections.push({ type: 'run-to-score', fromId: 'generate2', toId: 'evaluate2' });
      await window.app.load(s);
      return true;`);
    await runGenerate(ctx, 'generate2');
    await runEvaluate(ctx, 'evaluate2', 2);
    await evaluate(`window.app.closeDialogs(); return true;`);
    await wait(500);
    await evaluate(`
      const s = window.app.state();
      const at = {
        prompt: [30, 50], abstracts: [30, 450], reference: [340, 660],
        generate: [340, 220], process: [650, 30], evaluate: [650, 300],
        [window.app.optimizeId]: [960, 300], [window.app.v2Id]: [1270, 320],
        generate2: [1580, 570], evaluate2: [1890, 570],
      };
      for (const n of s.nodes) if (at[n.nodeId]) [n.left, n.top] = at[n.nodeId];
      s.nodes.find(n => n.nodeId === 'generate').runName = 'Generate v1';
      s.nodes.find(n => n.nodeId === 'evaluate').scoreName = 'Evaluate v1';
      await window.app.load(s);
      return true;`);
    await wait(1200);
    await shot('readme-hero');
  },
});
