# 运行到这里：实施计划

日期：2026-10-16
设计：[ANNOBIO_V2_FUNCTIONAL_DESIGN.md](ANNOBIO_V2_FUNCTIONAL_DESIGN.md)（先读第 1、3、4、7 节）
状态：未开始。每做完一步，在本文对应步骤下写"实现记录"：改了哪些文件、测试结果、已知问题。

本文写给接手实现的人。每一步写了：要先读的代码、要改的文件和函数、具体做法、测试和验收标准。行号是 2026-10-16 的，代码改过以后以函数名为准。

## 0. 接手前要知道的

### 0.1 本文写成时的代码状态

当前分支 `261014-log-dark-ui`，下面这些改动**还没有提交**，接手前先和用户确认是否已提交：

- 新建 Run / 发起 Optimize 时选模型（`app/src/modelPicker.js`）；每个 Optimize 记住自己的模型（`runAnalysisHistory.js`、`workflowCanvas.js` 读项目时的补齐）。
- Settings 的 Run / Optimize / Agent 页按模型保存参数（`app/src/perModelSettings.js`、`backend/model_settings.py`）。
- 删除凭据时刷新设置窗口的修复（`settingsModal.js` 的 `bindCredDeleteButtons`）。
- 去掉下游窗口"上游有 N 行出错"的提示（`stepInputs.js`、`runDetailModal.js`、`processDetailModal.js`）。
- 设计文档：本文、v2 设计、`NODE_MODEL_REVIEW.md` §4 的更新。

### 0.2 规矩

- **用户能做的 Agent 也能做，反过来也一样。** 加了界面入口，Agent 要有对应操作；删了界面入口，Agent 的对应操作也删。
- **窗口的规矩**：表单在窗口内原地编辑，展示用侧栏；弹出框只用于确认和简短对话。本文的"运行计划"是确认框，可以弹出。
- **用过的 Prompt 和 Dataset 锁定**（`app/src/contentLocks.js`），本计划不改这条。
- **提交**：每步单独提交。用户的仓库直接推到 main（先问用户）。提交信息里**不要**加 Co-Authored-By 或 Claude 的署名。
- 用户界面是英文，文档和讨论用中文。

### 0.3 怎么测试

- 前端单元测试：`cd app && node --test tests/*.test.mjs`（本文写成时 363 项全过）。
- 后端测试：在仓库根目录 `backend/.venv/Scripts/python.exe -m unittest backend.test_xxx ...`，要把模块逐个列出来，`unittest discover` 不能用（本文写成时 145 项全过）。
- 前端构建检查：`cd app && npx vite build -c vite.renderer.config.mjs --outDir <临时目录> --emptyOutDir`。不要输出到 `app/dist`。
- 界面实测（无头浏览器）：
  1. 把 `backend/`（不含 .venv、python-embed、data、logs、__pycache__）复制到 `%TEMP%\ab8020`，用 `backend/.venv/Scripts/python.exe -m uvicorn main:app --port 8020` 启动，环境变量 `PROMPT_STUDIO_BACKEND_PORT=8020 PROMPT_STUDIO_VITE_DEV_SERVER_PORT=5180`。
  2. 在 `app/` 里 `npx vite --config vite.renderer.config.mjs --port 5180`。
  3. Playwright 的 chromium 加 `--headless=new --remote-debugging-port=9334`，通过 CDP 控制；打开 `Emulation.setFocusEmulationEnabled`；把 `window.alert` 换成记录函数（原生 alert 会卡住无头页面）。
  4. 点开节点窗口用对 `.workflow-node` 的单击。导入项目："Open a project"，再给 `.project-picker-yc-input` 设文件。
  5. 测试用的凭据把 base_url 设成 `http://127.0.0.1:9/v1`，任何模型调用都会在本地失败，不会花钱。
  6. 结束后结束命令行含 `--port 5180`、`--port 8020`、`remote-debugging-port=9334` 的进程，删除 `%TEMP%\ab8020`。
  - 示例项目 `examples/Kinase–Substrate Evidence Curation - direct connections.yc` 有完整的 Run / Process 链。

### 0.4 相关代码地图

| 内容 | 位置 |
|---|---|
| 单步运行 Run | `workflowCanvasRuntime.js` 的 `startRunNode`；窗口按钮在 `runDetailModal.js` 的 `refreshButton`（约 300–330 行） |
| 单步运行 Process | `workflowCanvas.js` 的 `runProcessNode`；窗口按钮在 `processDetailModal.js` 的 `refreshUpstreamState`、`startRun` |
| 一个步骤的输出能不能被下游读 | `stepOutputs.js` 的 `stepOutputTable`：返回 `{table}` 或 `{waiting: 'no-result'|'running'|'stopped'|'missing-port'}` |
| 一个步骤读哪些来源 | `stepInputs.js` 的 `runInputSource`、`processInputSources`、`processRequiredInputs`，以及 `stepInputWaitingMessage`、`stepSourceLabel` |
| 当前结果怎么选出来 | `runHistoryResolver.js` 的 `resolveHistoryCanvasState`（按签名找记录，找不到就清掉结果） |
| Agent 一步步跑多个任务 | `agent/execution/runJobs.js`：`previewRun`、`previewProcess`（检查和估算）、`executeRun`、`executeProcess`（执行并等完成）、`executeRunRequest`（依次执行） |
| Agent 用的画布接口（`startRunNode`、`stopRunNode`、`runProcessNode`、`inspectNode`、`getCanvasState`） | `workflowCanvas.js` 约 3150–3400 行的 workspace 对象；`agentChatSession.js` 约 683 行组装成 `runWorkspace` |
| 节点执行中的停止句柄 | `nodeExecutionControl.js` |
| 节点右键菜单 | `workflowCanvas.js` 的 `showNodeContextMenu`（约 3496 行） |
| 底部面板页签 | `workflowCanvas.js` 约 6037–6041 行的 `bottomTabs`；布局在 `workspacePanels.js` |
| 运行中不能改输入 | `nodePorts.js` 的 `isRunning`、`changeBlocked` |
| 内容锁定 | `contentLocks.js` |
| 要删的整条运行界面 | `pipelineOverviewModal.js`、`pipelineRunDialog.js`、`pipelineRunInputs.js`、`pipelineRunClient.js`、`pipelineHistoryImport.js` |
| Agent 的整条运行操作 | `agent/pipeline/pipelineActions.js`、`agent/tools/agentTools.js` 的 `pipeline_action`、`backend/agent/system_prompt.py` |

## 第 1 步：规划函数

**目标**：给一个目标节点，算出哪些步骤复用、哪些要跑、读哪些输入、有什么问题、大概多少行。纯函数，不碰界面、不发请求。用户看不到变化。

**新文件** `app/src/runPlan.js`，导出：

```js
/**
 * @param {object} state  getCanvasState() 的结果（节点上已经带着当前结果）
 * @param {string} targetId  Run 或 Process 节点
 * @param {{ settings: object, credentialIds: Set<string>, extractInputFields: (text) => string[] }} context
 * @returns {{
 *   targetId: string,
 *   steps: Array<{ nodeId, kind: 'run'|'process', name, action: 'reuse'|'run'|'resume',
 *                  inputRows: number|null, calls: number|null, model?: string }>,   // 上游在前
 *   inputs: Array<{ nodeId, name, rows: number, readBy: string[] }>,              // 读到的 Dataset
 *   problems: Array<{ nodeId, message }>,                                         // 有问题就不能开始
 *   toRun: number,                                                                // action 不是 reuse 的步骤数
 * }}
 */
export function planRunTo(state, targetId, context) {}
```

**做法**

1. **找上游**：从目标出发往上走。Run 用 `runInputSource(state, id)`；Process 用 `processInputSources(state, id)`。来源是 Run / Process 就继续往上，是 Dataset 就记为输入。用 visited 集合防止重复；正常情况下连线不会成环（连线时已经检查过）。
2. **目标只能是 Run 或 Process**。Evaluate、Optimize、Prompt、Dataset、Sample 返回一条 problem："Run to here works on Run and Process steps."
3. **每一步的 action**：用 `stepOutputTable(state, { nodeId, port })` 看它当前的输出能不能读。`port` 取下游读它的那个端口；目标自己用 `result`（Process 用它识别出的任意一个分支，没有就 `result`）。
   - 返回 `table`：`reuse`。
   - `waiting: 'no-result'`：`run`。
   - `waiting: 'stopped'`：`resume`（Run 会从断的地方接着跑，Process 会从头再跑一遍）。
   - `waiting: 'running'`：problem："X is already running."
   - `waiting: 'missing-port'`：problem，文字用 `stepInputWaitingMessage` 生成。
   - 不用另外判断"上游要跑所以下游也要跑"：上游没有当前结果时，下游一定也没有（签名里含上游记录 ID），所以下游自己就会是 `run`。
4. **目标已经有当前结果**、而且所有步骤都是 `reuse`：`toRun` 为 0，界面提示 "Everything up to here is up to date."。（想用同样配置再生成一次，仍用窗口里的 Generate again。）
5. **检查**（每条都是 problem，带 nodeId），参考 `runJobs.js` 的 `previewRun` / `previewProcess`，只对要跑的步骤检查：
   - Run：有没有 `prompt-to-run` 连线；Prompt 有没有输出字段；有没有输入连线；Prompt 的每个输入（`extractInputFields(prompt.text)`）在 `runInputToColumn` 里有没有映射；模型（`runCredentialId`，没有就用 `settings.default_run_credential_id`）在不在 `credentialIds` 里。
   - Process：代码里有没有 `def process(df`；有没有 df 输入；`settings.python_path` 有没有设。
   - **注意**：上游这次才会跑出结果时，现在不知道它会输出哪些列，所以只能检查"映射填了没有"，不能检查"映射的列存不存在"。列不存在会在那一步运行时报错，这是可以接受的。
6. **顺序**：上游在前（拓扑排序）。同一层按画布上的位置或节点 ID 排，保证同样的画布每次排出一样的顺序。
7. **估算**：
   - Dataset 的行数已知。
   - Run 的 `inputRows` 是它读的表的行数（来源是 Dataset，或来源步骤是 `reuse`、行数已知时）；`calls` 等于 `inputRows`，`resume` 时减去已完成的行（参考 `previewRun` 里的 `done` 集合）。
   - Run 的 Prompt 是 single 形状时，输出行数等于输入行数，可以继续往下传；table 形状、Process 的输出：行数未知（`null`）。
   - 不估价格。Agent 卡片里的价格估算逻辑以后需要可以从 `previewRun` 搬过来。

**测试** `app/tests/runPlan.test.mjs`，画布状态的写法参考 `app/tests/stepInputs.test.mjs`：

- 三步链全都没结果：三步都是 `run`，顺序正确。
- 第一步有结果、后两步没有：第一步 `reuse`，后两步 `run`。
- 两个 Dataset 接同一个 Process；以及中间的 Process 另外接一个 Dataset：`inputs` 都列出来，`readBy` 正确。
- 目标上游之外的分支不在计划里。
- Run 停在一半（`runResumable`）：`resume`，`calls` 减去已完成行。
- 某步正在跑、某个分支不存在、缺映射、缺模型、Process 没有 python_path：各有一条 problem。
- 全部是最新的：`toRun === 0`。
- 目标是 Evaluate：problem。
- 行数：Dataset 1000 行 → single Run 1000 次调用 → 下游 Run 1000 次；中间有 Process 时下游是 `null`。

**验收**：测试全过；函数里没有 DOM、fetch、对画布的修改。

## 第 2 步：执行

**目标**：按计划依次运行，处理停止和失败。Agent 改用同一段代码。用户看不到变化。

**新文件** `app/src/runTo.js`：

```js
/**
 * @param {string} targetId
 * @param {object} env  Agent 用的那套画布接口（startRunNode、stopRunNode、runProcessNode、inspectNode、getCanvasState）
 * @param {{ signal?: AbortSignal, onStep?: (step, status) => void, approvedPlan?: object }} options
 * @returns {Promise<{ status: 'completed'|'failed'|'stopped', steps: Array<{ nodeId, status, recordId?, errorRows?, error? }> }>}
 */
export async function runTo(targetId, env, options) {}
```

**做法**

1. **共用执行代码**：把 `runJobs.js` 里的 `executeRun`、`executeProcess` 和它们用的 `waitWhile`、`currentNode` 移到一个新模块（例如 `app/src/stepExecution.js`）并导出，`runJobs.js` 改成从那里引入。行为不变，`runJobs` 的现有测试要照样通过。
2. **开始前再算一次计划**：用当前画布调 `planRunTo`。如果传了 `approvedPlan`，比较两份计划的 `steps`（nodeId + action），不一样就返回 failed："The canvas changed after the plan was shown. Check the plan again."。有 problem 也不开始。
3. **依次执行** `action !== 'reuse'` 的步骤：Run 调 `executeRun`，Process 调 `executeProcess`。
   - 每步开始前，用 `stepOutputTable` 再确认它读的上游都能读了；读不了就停下，状态 failed，写明原因。
   - Run 跑完、个别行出错：算完成，继续往下（v2 第 7 节已定第 1 条）。错误行数用 `inspectNode(id).details.errorRows`。
   - Run 停下或失败、Process 报错：整个任务停在这里，后面的步骤状态记为 `not-started`。
   - 每步结束后调 `onStep`，第 4 步的运行记录靠它更新。
4. **停止**：`signal` 被 abort 时，`executeRun` 已经会调 `stopRunNode`；Process 把 `signal` 传给 `runProcessNode`。任务状态 `stopped`。
5. **继续**：不用单独实现。再调一次 `runTo`，完成的步骤会是 `reuse`，停在一半的 Run 是 `resume`。
6. **锁住计划里的节点**：任务开始到结束这段时间，计划里所有步骤、它们的 Prompt、它们读的 Dataset 都不能改。
   - 新建一个小模块（例如 `runTaskLocks.js`）记录"哪些节点正在被一个任务占用"，开始时登记、结束时（包括出错）释放。
   - 改输入：`nodePorts.js` 的 `isRunning` 已经接受一个 `running` 集合，找到 `workflowCanvas.js` 里调用 `checkConnect` / `applyPortOp` 的地方，把占用的节点并进去。
   - 改内容：`contentLocks.js` 的锁定判断加上"被任务占用"，Run 窗口的列映射、Process 的代码编辑器、Prompt 和 Dataset 窗口都靠它变成只读。逐个打开窗口确认确实不能改。
   - 同一个节点已经被另一个任务占用时，`runTo` 不开始，返回 problem。
7. **Agent**：`run_nodes` 加一种 job：`{ kind: 'run_to', node }`。
   - 预览（`previewJob`）：调 `planRunTo`，把计划写成卡片上的几行（复用哪些、跑哪些、输入、行数），有 problem 就报错。
   - 执行：调 `runTo`，传入预览时的计划作为 `approvedPlan`。
   - 同步更新 `agentTools.js` 里 `run_nodes` 的说明、`backend/agent/system_prompt.py`、Agent guides 里讲运行的段落；`app/tests/agentCapabilityParity.test.mjs` 如果有能力清单，也要加上。

**测试**：

- `app/tests/runTo.test.mjs`：用假的 env（几个函数改一个内存里的画布状态），覆盖：全部成功；第二步失败后第三步不开始；中途 abort；再次调用时跳过已完成的步骤；画布在确认后变了导致拒绝；锁在结束和出错时都会释放。
- `runJobs` 的现有测试全部通过。

**验收**：测试全过；用 Agent 在示例项目上跑一次 `run_to`（用本地失败的假凭据即可看到第一步失败、后续不开始）。

## 第 3 步：入口和计划窗口

**目标**：用户可以在窗口和右键菜单里连同上游一起跑。

**做法**

1. **计划窗口**：新文件 `app/src/runPlanDialog.js`，样式和交互参考 `pipelineRunDialog.js`（`modal-overlay--alert`、确认 / 取消、点步骤在画布上定位节点）。内容按 v2 设计 §3.1：
   - 运行到：目标节点名
   - Inputs：每个 Dataset、行数、被哪一步读
   - Using existing results：复用的步骤（带记录编号）
   - Will run：要跑的步骤，依次列出，每步写模型和预计调用次数，未知写 "unknown"
   - 有 problem：列出来，每条可点击定位节点，"Start" 按钮不可用
   - 返回 `Promise<boolean>`（是否开始）。
2. **Run 窗口**（`runDetailModal.js` 的 `refreshButton`）：现在 `status.waiting` 时把按钮设成灰色的 "Waiting for upstream"。改为：**按钮文字和样子不变**，保持可点。点击时：
   - 用 `planRunTo` 算计划。`toRun` 为 1（只有自己要跑）：和现在一样直接开始。
   - `toRun` 大于 1：弹出计划窗口，确认后调 `runTo`。
   - 有 problem：弹出计划窗口显示 problem。
   - 注意：这一步的列映射在上游没结果时可能填不了（不知道有哪些列）。这时计划里会有"缺映射"的 problem，用户要先跑一次上游，或者在上游有过结果时先填好映射。窗口里原来"等待上游"的说明文字（`waitingBannerEl`）保留，改成说明点 Run 会连同上游一起跑。
3. **Process 窗口**（`processDetailModal.js` 的 `refreshUpstreamState`、`startRun`）：同样处理。
4. **右键菜单**：`showNodeContextMenu` 里给 Run 和 Process 加一项 "Run to here"，点了直接算计划，`toRun` 大于 1 或有 problem 时弹计划窗口，否则直接开始。正在被任务占用的节点，这一项不可用并说明原因。
5. **进度**：每一步用的是现有的单步运行，节点上的进度条、窗口里的进度照旧显示，不用另做。

**测试**：`runPlanDialog` 的文字生成写成纯函数单独测（参考 `pipelineRunDialog.js` 的 `pipelineRunIntro`）。界面实测：示例项目里把一个中间 Process 的代码改一下（Process 代码不锁），在最后一个节点上点 Run，看计划、确认、依次运行（用假凭据时第一个 Run 会失败，验证失败后停下）。

**验收**：只跑一步时和现在完全一样；连同上游时先看到计划；有问题时能定位到节点。

## 第 4 步：运行记录页签

**目标**：每次连同上游的运行（`runTo`）留一条记录，在底部面板查看、停止、继续。只跑一步的运行不进这里（它在节点 History 里已经有记录）。如果用户要求单步也进，再加。

**存储**（跟着项目走，不放进画布状态，因为画布状态每次变化都会进撤销栈）：

- 照着 Agent 对话（`agentSession`）的做法存：
  - 网页版：`backend/project_store.py` 加 `GET / PUT /{project_id}/run-records`，存在 `project.json` 的 `runRecords` 字段，写法照抄 `agent-conversations` 那两个接口。
  - 桌面版：`.yc` 包里加 `runRecords` 字段，照 `agentSession` 在 `app/src/projectAssets.js` 和 `app/src/main.js` 里的读写方式。
  - 复制项目、Save As、合并、导出、导入都要带上：在前后端全局搜 `agentSession`，每个出现的地方都要考虑 `runRecords`。
- 记录格式：

```json
{ "id": "...", "createdAt": 0, "updatedAt": 0,
  "targetNodeId": "...", "targetName": "...",
  "status": "running|completed|failed|stopped",
  "inputs": [{ "nodeId": "...", "name": "...", "rows": 1000 }],
  "steps": [{ "nodeId": "...", "name": "...", "kind": "run|process",
              "action": "reuse|run|resume",
              "status": "reused|pending|running|completed|failed|stopped|not-started",
              "recordId": "...", "errorRows": 3, "error": "..." }] }
```

- 开始时写一条，`onStep` 每次更新，结束时更新状态。
- 打开项目时，状态还是 `running` 的记录（上次关 app 时没跑完）改成 `stopped`。
- 先不做数量上限和删除。用户说过运行历史的保留和删除要先问他，不要自己加。

**界面**：

- `workflowCanvas.js` 的 `bottomTabs` 在 Prompt Version 和 Log 之间加 `{ id: 'executions', label: 'Executions' }`。名字已和用户定好（2026-10-16）：不用 "Runs"，因为 Process 的运行也记在这里，而且会和 Run 节点混淆。
- 新文件 `app/src/executionsPanel.js`：最新的在上面；每条显示时间、目标、状态、"跑了几步 / 复用几步"、出错行数；展开后列出每一步，点一步在画布上定位节点（用现有的 `revealCanvasNode`）。
- 正在跑的那条有 Stop（abort 这次 `runTo` 的 signal）；`stopped` 或 `failed` 的那条有 Resume：对同一个目标重新算计划，弹计划窗口，确认后再跑，新跑一次就新增一条记录。
- Agent 发起的 `run_to` 也写记录，和用户发起的一样，记录里可以标明来源。

**测试**：后端接口的单元测试（参考 `backend/test_project_history.py`）；前端记录更新逻辑写成纯函数测；界面实测：跑一次、停一次、继续一次、关掉再打开项目。

## 第 5 步："需要更新"的显示

**目标**：输入变了以后，节点继续显示上一次的结果并标"需要更新"，而不是显示"没有结果"。

**做法**

1. **`runHistoryResolver.js` 的 `resolveNode`**：现在找不到匹配记录时走 `clearResult`。改为：如果节点的 `historyRecordId` 指向这个节点自己的一条已完成记录（在 `byId` 里能找到），就加载它、`applyResult`，并设 `node.historyStale = true`；**不要**放进 `currentRecordIds`，`resolvedNodes` 里存 `null`，这样下游仍然算"上游没有结果"。找不到时照旧 `clearResult`。
2. **`stepOutputs.js`**：节点 `historyStale` 时返回 `{ waiting: 'stale' }`。`stepInputs.js` 的 `stepInputWaitingMessage` 给 `stale` 加一句文字，例如 `Upstream "X" needs updating.`。第 1 步的规划函数把 `stale` 当成 `run`。
3. **画布节点**：参考 `waitingForUpstream` 的显示（`workflowCanvas.js` 的 `setWaitingForUpstream`、`workflowCanvas.css` 约 664 行），给过期节点加一个 "Needs update" 标记。
4. **Run / Process 窗口**：结果区上方说明 "These results are from an earlier setup. Run to update them."，按钮照常可用。
5. **`historyStale` 是推导出来的字段**，不能存进项目文件，也不能进撤销快照。跟 `waitingForUpstream` 走同一条处理路径，并检查 `undoHistory.js` 的 `VOLATILE_FIELDS_BY_TYPE`。
6. **逐个检查读结果的地方**：全局搜 `runCompleted`、`runResults`、`dfResults`、`historyRecordId`，确认每处对过期结果的处理是对的：
   - Evaluate 读 Run 的结果算分：过期时不该算分，当作没有结果。
   - 输出菜单的 "Save to workspace"：过期结果是一条真实记录，可以保存，`savedFrom.recordId` 写它的记录 ID。
   - History 列表：当前记录的标记不要打在过期记录上。
   - Agent 的 `inspect_node`、工作区摘要：说明这一步需要更新。
   - Pipeline 导出：不读结果，不受影响。

**测试**：`app/tests/runHistoryResolver.test.mjs` 加用例：改了 Process 代码后显示旧结果并标过期，下游 waiting；改回原代码后恢复为当前结果，不再过期；记录被删除后照旧显示没有结果。

**验收**：示例项目里改一个 Process 的代码，它和下游都显示旧结果加 "Needs update"；改回去，标记消失。

## 第 6 步：删除整条运行的旧入口

**前提**：第 3、4 步已经上线。

**做法**

1. **`pipelineOverviewModal.js`**：删除 `renderRunActions`（Run Pipeline / Stop / Resume）、Run History 按钮和窗口（约 262–520 行）、运行状态的轮询、`publishPipelineRun` 的调用和"是否已导入"的 localStorage 记录。卡片上只留 Export Python Project。顶部注释改写。
2. **删除不再用的文件和函数**：`pipelineRunDialog.js`；`pipelineRunInputs.js`（先确认没有别的地方用）；`pipelineRunClient.js` 里只给运行用的函数；`pipelineHistoryImport.js` 及 `workflowCanvas.js` 里导入整条运行结果的代码。相应的测试一起删或改，CSS 一起删。
3. **后端**：Pipeline Runner 和 `/api/pipeline/runs*` 接口先保留不删，导出仍用编译器。在 `PIPELINE_EXECUTION_PLAN.md` 写明界面已不再调用这些运行接口。
4. **Agent**：`agent/pipeline/pipelineActions.js` 删除 run / stop / resume，只留 export；同步 `agentTools.js` 里 `pipeline_action` 的说明、`backend/agent/system_prompt.py`、Agent guides、`app/tests/agentPipelineActions.test.mjs`。
5. **文档**：`NODE_PORTS_DESIGN.md` §11 标为由 v2 取代；`PIPELINE_EXECUTION_PLAN.md` P1.4 注明运行入口已移除；v2 设计第 4 节标为已完成。
6. **用户指南**：`hub/templates/guide.html` 和 `docs/PIPELINE_GUIDE.md` 里讲 Run Pipeline 的地方，改成讲 Run to here 和 Executions 页签。

**验收**：全局搜 `Run Pipeline`、`Run History`、`pipeline-run-action`，界面代码里不再出现；前后端测试全过；界面实测 Current Pipeline 卡片只有导出，导出照常可用。

## 以后再做

- **关掉 app 后在后端继续跑**：要改用后端 Pipeline Runner，并把它的结果和节点 History 合成一份存储。
- **不相关的分支在一条分支失败后继续跑。**
- **Current Pipeline 面板的去留**：删掉运行入口后它只剩导出，可以考虑改成"导出到这里"后去掉。
