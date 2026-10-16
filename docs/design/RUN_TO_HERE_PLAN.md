# 运行到这里：实施计划

日期：2026-10-16
设计：[ANNOBIO_V2_FUNCTIONAL_DESIGN.md](ANNOBIO_V2_FUNCTIONAL_DESIGN.md)（先读第 1、3、4、7 节）
状态见下面的进度表。每做完一步：在表里把那一步改成"✅ 已完成"并写上日期，在那一步的标题后面加"✅"，在那一步下面写"实现记录"（改了哪些文件、测试结果、已知问题）。

## 进度

| 步骤 | 内容 | 状态 |
|---|---|---|
| 1 | 规划函数 | ✅ 已完成（2026-10-16，未提交） |
| 2 | 执行 | ✅ 已完成（2026-10-16，未提交） |
| 3 | 入口和计划窗口 | ✅ 已完成（2026-10-16，未提交） |
| 4 | 运行记录页签（Executions） | ✅ 已完成（2026-10-16，未提交） |
| 5 | "需要更新"的显示 | ✅ 已完成（2026-10-16，未提交） |
| 6 | 删除整条运行的旧入口 | ✅ 已完成（2026-10-16，未提交） |
| 7 | 改名 Execute，加"只跑这一步"，都已是当前结果时重跑 | ✅ 已完成（2026-10-16，未提交） |

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

## 第 1 步：规划函数 ✅

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

**实现记录（2026-10-16）**

- 新文件 `app/src/runPlan.js`，导出 `planRunTo(state, targetId, { settings, credentialIds })`。和上面的接口相比：
  - 没有 `extractInputFields` 参数，直接从 `promptText.js` 引入。
  - Run 的步骤多了 `credentialId`（实际会用的模型，没有就是 Settings 里选中的）。
  - 计划多了总调用次数 `calls`，有任何一步未知就是 `null`。
- 一个步骤的状态直接读节点上的字段：Run 看 `runPending` / `runCompleted` / `runResumable`；Process 看 `processPending` / `processResumable` / `dfResults`。不用 `stepOutputTable` 判断，因为 Process 的输出可能不叫 `result`。`stepOutputTable` 只用来检查下游读的分支存不存在、Dataset 有没有内容、已有结果的实际行数。
- Process 的输入用 `processRequiredInputs`，和它运行、签名用的是同一份，包括代码里用别名引用的输入。
- `inputs` 按读它的步骤的执行顺序排。
- 还没做的检查：Process 代码里引用了、但画布上没连的别名（Agent 的 `previewProcess` 通过 `inspectWorkflowNode` 检查这一项）。现在这种情况会在那一步运行时报错。第 2 步如果改用共享检查，可以一并补上。
- 测试 `app/tests/runPlan.test.mjs`，13 项，覆盖上面列的所有情况。前端全部 376 项通过。

## 第 2 步：执行 ✅

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

**实现记录（2026-10-16）**

- **共用执行代码**：新文件 `app/src/stepExecution.js`，从 `agent/execution/runJobs.js` 移过来 `waitWhile`、`currentNode`，以及执行函数 `executeRunStep`、`executeProcessStep`（原来叫 `executeRun`、`executeProcess`）。
  - `executeRunStep` 多返回两项：`inspected`（跑到了结尾）和 `errorRows`。
  - Evaluate 分数的汇总留在 `runJobs.js` 自己的 `executeRun` 里，Agent 的行为不变。
- **执行**：新文件 `app/src/runTo.js`。
  - `runTo(targetId, env, { context, signal, approvedPlan, onStep })` 按上面的做法执行。
  - 另外导出 `planHeldNodeIds`（任务要占用哪些节点）和 `samePlanSteps`（比较两份计划）。
  - 一个 Run 不是被用户停下、却没跑完所有行，算失败。`executeRunStep` 对这种情况返回 `stopped`，`runTo` 根据有没有 abort 区分。
- **占用**：新文件 `app/src/runTaskLocks.js`（`holdNodes`、`isTaskLocked`、`taskLockedIds`），占用变化时发出 `workflow:run-task-locks-changed` 事件。接入了这几处：
  - `nodePorts.js` 的 `changeBlocked`：被占用的节点不能改输入，提示 "is part of a run in progress"。拖线、断开、Agent 改连线都经过这里。
  - `workflowCanvas.js` 的 `getContentLocksForCanvas`：被占用的节点算内容锁定，Prompt、Dataset 窗口和 Agent 改内容都受它管。拿到的锁表先复制一份再加，因为 History 会话可能缓存这张表。
  - `agent/operations/changeSet.js` 的 `update`：被占用的节点，除了改名和备注，什么都不能改。
  - Run 窗口（`runDetailModal.js` 的 `applyTaskHold`）、Process 窗口（`processDetailModal.js` 的 `applyTaskHold`）：被占用、自己又没在跑时，输入或代码只读，Run 按钮不可用，悬停说明原因；占用变化时自动刷新。按钮文字不变。
- **Agent**：`run_nodes` 加了 `run_to` 这种 job。
  - 卡片列出输入、复用、执行顺序和调用次数。
  - 执行时用卡片上确认过的计划（`planSteps` 随卡片的 preview 一起保存）去比较，计划变了就拒绝。
  - `agentTools.js` 的说明和 `backend/agent/system_prompt.py` 都已更新。
- **测试**：新文件 `app/tests/runTo.test.mjs`，10 项，用一个假的画布接口，覆盖：
  - 全部成功、中途失败、再次运行时跳过已完成的步骤；
  - Run 没跑完算失败、用户停止；
  - 计划变了被拒绝、有 problem 被拒绝、没什么要跑；
  - 占用和释放、被另一个任务占用时拒绝、占用时不能改输入；
  - Agent 卡片的内容。
  - 前端 386 项、后端 145 项全过，构建通过。
- **已知问题**：
  - 还没在真实界面里跑过：这一步没有界面入口，Agent 的 `run_to` 需要真实的 Agent 模型才能在界面里试。第 3 步做完入口后一起实测。
  - 任务开始前就已经打开的 Prompt / Dataset 窗口不会变成只读：它们只在打开时判断一次锁定，之后边输入边保存，不再检查。这样任务进行中仍能改到还没开始的步骤读的 Prompt。第 3 步要让这两个窗口也监听 `workflow:run-task-locks-changed`（做法同 Run 窗口的 `applyTaskHold`）。Agent 改内容时会再检查，不受影响。
  - 第 1 步记下的"代码里引用了但没连线的别名"检查还没补。

## 第 3 步：入口和计划窗口 ✅

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

**实现记录（2026-10-16）**

- **计划窗口**：新文件 `app/src/runPlanDialog.js`。
  - `runPlanView(plan, { modelLabel })` 是纯函数，生成窗口里的文字：Reads、Uses existing results、Runs, in order、调用次数，以及各条 problem 的位置。
  - `openRunPlanDialog({ plan, modelLabel, showNode })` 返回是否开始。
  - 样式是 `modals.css` 里的 `.run-plan-dialog*`，没有用 `pipelineRunDialog` 的样式，因为第 6 步要删掉它。
  - 只跑 Process 的计划不显示调用次数那一行。
- **画布入口**：`workflowCanvas.js` 的 `runToHere(nodeId, { single, onShowNode })`。
  - 读 Settings 和凭据，算计划。全部是最新的就提示 "Everything up to here already has current results."。
  - 只有这一步要跑：`single: 'skip'` 时交回窗口按原来的方式跑，否则直接跑。
  - 其余情况弹计划窗口，确认后调 `runTo`，失败时弹提示。
  - `onShowNode` 让发起的窗口在定位节点前先关掉，免得挡住节点。
- **Run / Process 窗口**：上游没结果时，按钮不再变成灰的 "Waiting for upstream"，文字不变，可以点；点了走 `runToHere`。传入的参数是 `runToHere`（`workflowNodeFactories.js`）。
- **右键菜单**：Run 和 Process 的菜单最前面加了 "Run" 组和 "Run to here"。节点被占用时这一项不可用。
- **停止**：计划跑到某一步、这一步的 Run 窗口开着时，Run 窗口会接管这个任务（`onRunResultsUpdated` 里拿 `getPendingRunId()`），所以窗口里的 Stop 能停下这一步，整个计划也就停了。为此 `runTo.js` 改成：Run 没跑完所有行一律算 `stopped`，不算 `failed`，再运行一次会接着跑；只有报错才算 `failed`。
- **补上第 2 步的已知问题**：
  - Prompt 窗口（`promptDetailModal.js` 的 `heldByRun`）在占用期间不能编辑，任务开始前就打开的窗口也一样。
  - Dataset 窗口：保存被拒绝时弹提示，并立即把窗口内容恢复成已保存的内容（`datasetDetailModal.js` 的 `persistContent`）。
- **规划函数补充**：从来没打开过的 Process 没有代码，提示改为 "has no code yet. Open it to write its code."。
- **测试**：
  - 新文件 `app/tests/runPlanDialog.test.mjs`，4 项。
  - `runPlan.test.mjs` 加 1 项，`runTo.test.mjs` 改 1 项。
  - 前端全部 391 项通过，构建通过。
- **界面实测（无头浏览器，示例项目 direct connections，假凭据）**，通过的有：
  - 改了上游 Process 的代码后，下游窗口的按钮仍可点，计划正确；
  - 取消后什么都没跑；点步骤卡片能定位节点，并关掉发起的窗口；
  - 依次运行，Process 用 Python 跑，Run 在模型全部失败时以出错行完成；
  - 占用期间改连线被拒，Prompt 不能编辑，Dataset 的修改被拒并恢复，菜单项不可用，结束后全部释放；
  - 全部是最新时给出提示；没设 Python 时 problem 标红、Start 不可用；
  - 深色模式正常，控制台没有错误。
- **已知问题（都不是这一步引入的）**：
  - Run 步骤用 Prompt 的名字称呼，和 Current Pipeline、Agent 一致。几个 Run 共用一个 Prompt 时，计划里分不清是哪一个；要不要改用 Run 自己的名字，待用户定。
  - 输入 0 行的 Run 完成后，窗口仍显示 "Run to see results"。
  - 凭据不通时每行都要重试多次，8 行跑了约 3.5 分钟，计划里的节点在这段时间里一直被占用。
  - 计划跑到某一步的 Process 时，Process 窗口没法停下它，第 4 步的 Executions 页签会提供 Stop。
  - 含图片 / PDF 列的数据进入 Process 时报 "Image/PDF inputs require a project session."，从 Process 窗口直接运行也一样，是现有问题。

## 第 4 步：运行记录页签 ✅

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

**实现记录（2026-10-16）**

- **存储**：
  - 网页版：`backend/project_store.py` 新增 `GET / PUT /{project_id}/run-records`，记录存在 `project.json` 的 `runRecords`。新建、复制（History 也一起复制，所以记录也复制）、合并（加上源项目里目标没有的记录）、导出 `.yc`、导入 `.yc` 都处理了这个字段。画布保存（`save_project`）本来就不碰别的字段。
  - 桌面版：`app/src/projectAssets.js` 新增 `loadRunRecords`、`saveRunRecords`。`.yc` 包里多一个 `runRecords` 字段，跟着 History 走：另存时复制，新项目为空，合并时加上源项目的。
  - IPC 是 `run-records:load` / `run-records:save`（`main.js`、`preload.js`）。
  - 旧的 `.json` 项目没有记录。
- **记录**：新文件 `app/src/executionRecords.js`。
  - 读写：`loadExecutionRecords`、`saveExecutionRecords`。桌面用 `electronAPI`，网页用接口。
  - 纯函数：`newExecutionRecord`、`updateExecutionRecord`、`endInterruptedRecords`、`executionCounts`、`executionSummary`。
  - 格式和上面写的一样。另外多一个步骤状态 `interrupted`：窗口关闭或刷新时正在跑的那一步。网页版刷新不会停掉服务器上的任务，这一步可能其实已经跑完了，所以不说它停了。记录里的说明是 "The window closed before this run finished…"。
- **画布**：`workflowCanvas.js` 新增 `runPlanned(nodeId, { context, approvedPlan, signal, source, onStep })`。
  - 包着 `runTo`：第一步开始时新建记录，每步结束时更新，结束时写入最终状态。开始前就被拒绝的运行不留记录。
  - Run to here 和 Agent 的 `run_to` 都走它（Agent 的 workspace 里有 `runPlanned`，记录的 `source` 是 `agent`）。
  - 记录按项目加载（`ensureExecutionRecords`，项目切换时重新加载）。保存按顺序排队，切换项目后不会写错项目。
- **页签**：新文件 `app/src/executionsPanel.js`、`executionsPanel.css`。
  - 页签 ID 是 `executions`，名字是 Executions，放在 Prompt Version 和 Log 之间。
  - 最新的记录在上面，正在跑的那条自动展开；点一步会在画布上定位节点。
  - Stop 会 abort 这次运行，Process 步骤也能停。Resume 会对同一个目标重新走 `runToHere`，有计划窗口，并新增一条记录。
  - 停止、中断的说明用灰色，失败的用红色。
- **测试**：
  - 新文件 `app/tests/executionRecords.test.mjs`，3 项。
  - `app/tests/runHistoryStorage.test.mjs` 加 1 项：桌面 `.yc` 在保存、另存、合并时都保留记录。
  - 新文件 `backend/test_run_records.py`，3 项。
  - 前端全部 395 项、后端全部测试通过，构建通过。
- **界面实测（网页版，无头浏览器）**，10 项全部通过：
  - 页签和空状态；
  - 运行中的记录实时更新，服务器上也有；
  - Stop 后后面的步骤 Not started，后端没有再收到运行请求；
  - Resume 新增一条记录并完成，旧的保持 Stopped；
  - 点步骤定位节点、展开和收起；
  - 单独一步的 Run to here 也留记录，从窗口直接运行的不留；
  - 刷新后记录还在，运行中刷新会把那条标为中断；
  - 复制项目后记录一致；
  - 深色模式正常，控制台没有错误。
  - 另外验证了：失败的记录显示 traceback；同一步正在跑时，新的计划显示 "already running"，Start 不可用。
  - 实测后改了几处小问题（中断的说法、"1 rows" 的单复数、失败提示里重复的步骤名、停止说明的颜色），只跑了单元测试，没有再次实测。
- **已知问题**：
  - 停下后 Resume 时，停在一半的 Run 会接着写同一条 History 记录（这是现有的单步运行行为）。所以停止那条记录里，这一步链接到的 History 最后显示的是"已完成"。界面上目前不显示这个链接。
  - 单独一步的 Run to here 记录也会列出上游被复用的步骤（"1 ran · 4 reused"），这是有意的，记录完整的计划。
  - 桌面版没有界面实测，只有存储的单元测试。

## 第 5 步："需要更新"的显示 ✅

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

**实现记录（2026-10-16）**

和上面的做法相比，改成了一种更保守的方式。

上面原本打算把过期的旧结果写回节点的结果字段，再用 `historyStale` 区分。但读结果的地方太多（Evaluate 算分、保存结果、Agent、按钮状态、内容锁定……），每处都要认得"过期"，容易漏。

现在的做法是：节点的结果字段照旧清空，所有读结果的地方看到的仍是"没有结果"，行为和以前完全一样。另外记一个指针 `historyStaleRecordId`，只给"显示"用。

- **`runHistoryResolver.js`**：
  - 签名对不上时，如果节点上一次显示的记录（`historyRecordId`，或者已有的 `historyStaleRecordId`）是这个节点自己的、已完成的记录，就把它记成 `historyStaleRecordId`，然后照旧 `clearResult`。
  - 对上了就删掉这个字段。
  - 记录被删除后，这个字段也随之消失。
  - 它不进 `currentRecordIds`，所以下游照旧等待，Evaluate 和 Optimize 的分析键也不会用到它。
- **`stepOutputs.js`**：节点没有当前结果、但有这个指针时，返回 `waiting: 'stale'`。`stepInputs.js` 的 `stepInputWaitingMessage` 为它生成 `"X" needs updating: its inputs changed since its last run.`。规划函数把它当作要跑的步骤，不用改。
- **画布（`workflowCanvas.js`）**：
  - 保存：`getCanvasState` / `loadCanvasState` 保存并读回这个字段，所以刷新后还在。
  - 写回：History 解析后由 `setHistoryStale` 写回节点，加上 `workflow-node--stale` 类；`workflowCanvas.css` 用它画 "Needs update" 小标签，并设置悬停说明。
  - 读状态：`liveInputState` 也带上了这个字段，窗口顶部的提示、变淡节点的悬停说明才会用上"需要更新"的说法。界面实测时发现漏了这一处，已修好。
  - `loadStaleRecord(nodeId)` 用来读那条旧记录，传给 Run / Process 窗口。
  - `undoHistory.js` 把它列为易变字段，不进撤销快照。
- **窗口**：
  - Run 窗口（`showStaleResults`）没有当前结果时，显示旧记录的结果表和说明。Save to workspace / Create Evaluate 是针对当前结果的，所以隐藏。
  - Process 窗口（`showStaleResults`）显示旧记录的各分支和说明。Save to workspace 仍可用，保存出来的 Dataset 的 `savedFrom.recordId` 是那条旧记录。
- **Agent**：`inspect_node` 的 details 多了 `needsUpdate` 说明（`agent/canvas/workflowNodeInspector.js`）。
- **测试**：
  - `runHistoryResolver.test.mjs` 加 1 项：过期时指向旧记录、下游读不到、刷新后还在、改回去恢复、记录删除后消失。
  - `runPlan.test.mjs` 加 1 项。
  - 测试数据 `historyGraphFixture.mjs` 的 History 索引补上了 `status`，和真实存储一致。
  - 前端全部 397 项通过，构建通过。
- **界面实测（网页版，无头浏览器）全部通过**：
  - 改了 Process 代码后，它和下游有结果的步骤都显示 "Needs update"，下游同时变淡（在等上游）。
  - 窗口里显示旧结果和说明，Run 窗口隐藏 Save / Create Evaluate。
  - 依赖这个 Run 的 Evaluate 不用旧结果算分。
  - 撤销代码修改后，旧结果恢复为当前结果，没有调用任何运行。
  - 刷新后标签还在；Run to here 时，每一步开始运行时标签消失。
  - 下游窗口的提示和悬停说明都用"需要更新"的说法（修复后复查通过）。
  - 深色模式可读，控制台没有错误。
- **实测后按用户决定补的（2026-10-16）**：
  - Evaluate 读的 Run 没有当前结果时，Evaluate 窗口不再显示一排 0%，改成 `No result yet: "<Run>" needs updating…` 或 `… has not run…`，并隐藏 Save to workspace / Optimize prompt（`scoreDetailModal.js` 的 `runNotReadyMessage`；由 `workflowNodeFactories.js` 传入 `getRunState`）。正在跑、已有部分结果的 Run 照旧实时打分。Run 的名字和其他地方一样：改过名用它自己的名字，否则用 Prompt 的名字。
  - Process 窗口的说明条加了左右边距，和 Run 窗口一样（`.run-detail-stale-note--outside`）。
  - Process 窗口另存旧结果时不额外标注，用户决定不改。
  - 实测通过（"has not run" 的情况没有可用的示例，没测）。

## 第 6 步：删除整条运行的旧入口 ✅

**前提**：第 3、4 步已经上线。

**做法**

1. **`pipelineOverviewModal.js`**：删除 `renderRunActions`（Run Pipeline / Stop / Resume）、Run History 按钮和窗口（约 262–520 行）、运行状态的轮询、`publishPipelineRun` 的调用和"是否已导入"的 localStorage 记录。卡片上只留 Export Python Project。顶部注释改写。
2. **删除不再用的文件和函数**：`pipelineRunDialog.js`；`pipelineRunInputs.js`（先确认没有别的地方用）；`pipelineRunClient.js` 里只给运行用的函数；`pipelineHistoryImport.js` 及 `workflowCanvas.js` 里导入整条运行结果的代码。相应的测试一起删或改，CSS 一起删。
3. **后端**：Pipeline Runner 和 `/api/pipeline/runs*` 接口先保留不删，导出仍用编译器。在 `PIPELINE_EXECUTION_PLAN.md` 写明界面已不再调用这些运行接口。
4. **Agent**：`agent/pipeline/pipelineActions.js` 删除 run / stop / resume，只留 export；同步 `agentTools.js` 里 `pipeline_action` 的说明、`backend/agent/system_prompt.py`、Agent guides、`app/tests/agentPipelineActions.test.mjs`。
5. **文档**：`NODE_PORTS_DESIGN.md` §11 标为由 v2 取代；`PIPELINE_EXECUTION_PLAN.md` P1.4 注明运行入口已移除；v2 设计第 4 节标为已完成。
6. **用户指南**：`hub/templates/guide.html` 和 `docs/PIPELINE_GUIDE.md` 里讲 Run Pipeline 的地方，改成讲 Run to here 和 Executions 页签。

**验收**：全局搜 `Run Pipeline`、`Run History`、`pipeline-run-action`，界面代码里不再出现；前后端测试全过；界面实测 Current Pipeline 卡片只有导出，导出照常可用。

**实现记录（2026-10-16）**

- **`pipelineOverviewModal.js` 重写**：只保留路线显示、选择器、悬停高亮和点击定位节点、Export Python Project，以及给 Agent 读的 `getPipelineSelections`。
  - 删除了 Run / Stop / Resume、Run History 按钮和窗口、运行状态轮询、运行结束后导入 History 的代码，还有 localStorage 里的运行记录。
  - 打开它的参数只剩 `host`、`getCanvasState`、`highlightCanvasNodes`、`focusCanvasNodes`。
- **删除的文件**：
  - `pipelineRunDialog.js`、`pipelineRunInputs.js`、`pipelineHistoryImport.js`；
  - 测试 `pipelineRunInputs.test.mjs`、`pipelineHistoryImport.test.mjs`。
- **精简的文件**：
  - `pipelineRunClient.js` 只留导出前用的 `compileCurrentPipeline`。
  - `pipelineRunDefinition.js` 只留 `buildPipelineCompileRequest`、`pipelineRunCanvasDefinition`、`pipelineRouteKey`。
  - 相应的测试改成只测这些。
  - `pipelineInputAvailability.js` 导出还在用，保留。
- **画布（`workflowCanvas.js`）**：打开 Current Pipeline 时不再传 `publishPipelineRun` 等参数。Agent workspace 去掉了 `registerPipelineRun`、`getPipelineRunNeedsAssets`、`getPipelineProjectId`、`showPipelinePanel`。
- **Agent**：
  - `pipeline_action` 只剩 `export`；传 run / stop / resume 会报错，并提示改用 `run_nodes` 的 `run_to`。
  - 只读工具 `get_pipeline_runs` 删除。Run History 没有了，留着它就成了只有 Agent 能看的整条运行历史。
  - 已同步：`agentTools.js` 的工具定义、`agentChatSession.js` 的按钮文字、`backend/agent/system_prompt.py`、Agent guide `pipeline-building.md`。
  - 测试 `agentPipelineActions.test.mjs` 改为测导出，以及 run / stop / resume 被拒。
- **样式**：`modals.css` 删掉了旧 Run Pipeline 窗口、Run History 窗口、运行按钮和运行状态的样式。这次新加的计划窗口、说明条样式保留。
- **文档**：
  - 用户文档：`docs/PIPELINE_GUIDE.md` 改讲 Run to here 和 Executions，`docs/AGENT_CAPABILITIES.md` 同步更新。
  - 设计文档：`PIPELINE_EXECUTION_PLAN.md` 加了更新说明，`NODE_PORTS_DESIGN.md` §11 标为已取代，v2 设计第 4 节标为已删除。
  - 用户指南 `hub/templates/guide.html` 里本来就没有讲 Run Pipeline。
- **后端**：Pipeline Runner 和 `/api/pipeline/runs*` 接口保留，界面不再调用。编译器和导出照常使用。
- **测试**：前端 387 项通过（删掉的旧测试和旧功能一起删了），后端全部通过，构建通过。
- **界面实测（网页版）全部通过**：
  - Current Pipeline 卡片只有导出；选择器、悬停高亮、点击定位节点正常；
  - 导出成功下载 zip（21 个文件）；
  - 开了约 10 个窗口和菜单，页面里都找不到 "Run Pipeline" "Run History" "Prepare inputs"；
  - Run to here 从计划到完成正常，Executions 记录完整；
  - 底部页签是 Current Pipeline | Prompt Version | Executions；
  - 控制台没有错误。
- **已知问题**：示例项目 `examples/Kinase–Substrate Evidence Curation - direct connections.yc` 里存着一段旧的 Agent 对话，说 Agent 能运行、停止整条 Pipeline，现在已经过时。这是项目文件里的聊天内容，不是界面文字，没有改。

## 第 7 步：改名 Execute，加"只跑这一步"，都已是当前结果时重跑 ✅

用户在第 6 步之后提的（2026-10-16）：

- 界面上的 "Run to here" 改叫 **Execute to here**。
- 右键菜单加 **Execute this step**，只跑这一步。
- 如果这一步和它前面都已经是当前结果，原来会提示"都已是当前结果"、什么也不跑。现在改成重跑这一步。

**实现记录（2026-10-16）**

- **规划（`runPlan.js`）**：
  - `planRunTo(state, targetId, context, { onlyThis, rerun })` 多了第四个参数，返回值多了 `scope`（`'to-here'` 或 `'this'`）。
  - `onlyThis` 时不把上游步骤放进计划。上游没有当前结果就报问题：`"X" has no current result. Use Execute to here to run it first.`
  - `rerun` 时，目标步骤如果有当前结果，动作是 `'rerun'`（会跑），上游照常复用。
  - 新增 `upstreamWithoutResult(state, nodeId)`，返回这一步读的步骤里第一个没有当前结果的名字。菜单用它决定 Execute this step 能不能点。
- **执行（`runTo.js`）**：
  - `runTo` 多了 `planOptions`，用同样的选项规划。
  - 每一步开始前检查"能不能跑"，改用 `onlyThis` 的子计划，不用再单独判断上游。
  - 重跑走原来的单步执行：Run 节点在 `startRunNode` 里本来就会把已完成的结果重跑（`rerunCompleted`）。
- **画布（`workflowCanvas.js`）**：
  - 右键菜单的组名从 Run 改为 **Execute**，里面有两项：
    - **Execute to here**：这一步在运行中时禁用。
    - **Execute this step**：运行中，或它读的步骤没有当前结果时禁用，提示框写原因。
  - `runToHere(nodeId, { onlyThis })`：规划结果是零步要跑时，用 `rerun: true` 再规划一次。只有一步要跑时照旧不弹计划窗口。
  - 提示框标题改为 Execute to here / Execute this step。
  - `runPlanned` 多了 `planOptions`，用它建 Executions 记录、传给 `runTo`。
  - 节点窗口里的 Run / Run code 按钮不变。它们只在输入没有结果时调用 `runToHere`。
- **记录和窗口**：
  - Executions 记录多了 `scope`。
  - 记录和计划窗口的标题写成 `Execute to "X"` 或 `Execute "X"`。
  - 重跑的步骤在计划里注明 "runs again: it already has a current result"。
- **Agent**：
  - `run_nodes` 的 `run_to` 多了 `only_this`。都已是当前结果时也重跑，卡片标题和用户的一样，重跑的步骤注明 "(again; its result is current)"。
  - 已同步：`agentTools.js`、`backend/agent/system_prompt.py`、`pipeline-building.md`。
- **文档**：`docs/PIPELINE_GUIDE.md` 的 "Run to here" 一节改写为 "Execute"，`docs/AGENT_CAPABILITIES.md` 同步更新。
- **测试**：新增和更新的测试在 `runPlan.test.mjs`、`runTo.test.mjs`、`runPlanDialog.test.mjs`、`executionRecords.test.mjs`。前端 391 项、后端 148 项全过，构建通过。
- **顺带修的问题**：画布的 `escapeHtml` 不转义双引号，放进 `title="…"` 时，遇到带引号的提示（如 `"UniProt search" has no …`）会被截断成空。新增了 `escapeAttr`，右键菜单的提示都改用它。
- **界面实测（网页版，示例项目）**：
  - 右键菜单的 Execute 组有两项。上游有当前结果时两项都能点；"Combine UniProt candidates" 的上游需要更新时，Execute this step 是灰的，提示写 `"UniProt search" has no current result yet. Use Execute to here.`
  - 在都已是当前结果的 Tidy 上点 Execute this step：不弹窗，直接重跑。Executions 记录为 `Execute "Tidy extracted pairs"`。
  - 在 Check UniProt availability 上点 Execute to here：复用前两步，跑这一步。它有当前结果后再点一次，会重跑，也不弹窗。
  - Run 步骤在没有可用模型时，重跑会弹出计划窗口，显示 "runs again" 和缺模型的问题，Start 是灰的。
  - 控制台没有错误。
- **要知道的行为**：重跑一步之后，它下游的步骤都会变成 Needs update，即使输出一模一样。这是因为下游的 History 签名里记的是上游那条记录的 id，不是内容。

## 以后再做

- **关掉 app 后在后端继续跑**：要改用后端 Pipeline Runner，并把它的结果和节点 History 合成一份存储。
- **不相关的分支在一条分支失败后继续跑。**
- **Current Pipeline 面板的去留**：删掉运行入口后它只剩导出，可以考虑改成"导出到这里"后去掉。
