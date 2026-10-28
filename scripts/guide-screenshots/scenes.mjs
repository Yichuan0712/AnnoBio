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
      // The widths a user would drag to: a narrow ID column and a wide Abstract column.
      await evaluate(`
        const cols = document.querySelectorAll('.modal-overlay colgroup col');
        [40, 56, 380, 583].forEach((w, i) => { if (cols[i]) cols[i].style.width = w + 'px'; });
        return true;`);
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
    name: 'agent-assistant',
    async run(ctx) {
      await ctx.open(AGENT_PANEL);
      await buildBase(ctx);
      await ctx.wait(800);
      await ctx.shot('agent-assistant');
    },
  },
];
