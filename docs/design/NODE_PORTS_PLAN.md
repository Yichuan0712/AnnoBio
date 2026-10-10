# 节点端口：实施计划

状态：第 1、2 步完成（2026-10-09），下一步是第 3 步。基于 `261009-node-ports` / `cf83fc4`（2026-10-09）。

本文把 [NODE_PORTS_DESIGN.md](NODE_PORTS_DESIGN.md)（下称“设计”）的第一部分（端口和拖线：设计第 1–10 节、第 12 节）拆成 7 个可以独立执行的步骤。第二部分（统一的运行入口、Pipeline 里的 Prompt：设计第 11、13 节）还在讨论，不在本计划内。

每一步都写明要先读的代码、要改的文件和函数、要加的测试和验收标准，供不了解前面讨论的执行者（人或 LLM）一步一步完成。

## 0. 执行规则

每一步都适用：

1. **一次只做一个步骤。** 开始前完整阅读设计第 1–10 节和第 12 节、本文 §0–§3，以及该步骤全文。不要提前做后面步骤的内容，也不要顺手重构无关代码。
2. **先检查前置条件。**
   - 上一步在 §5 进度表中已标为完成；
   - 当前分支是 `261009-node-ports`，`git status` 干净；
   - §1 的基线命令全部通过。
   任何一条不满足，就停下来告诉用户。
3. **遇到没覆盖的情况就停下来问。** 本文和设计都没写到的情况，或者文中描述的事实与代码不符（只是行号漂移除外），先问用户，不要自行决定。设计第 11、13 节的内容不要做。
4. **行号只用来定位。** 以函数名为准，行号会随修改漂移。§2 的行号取自 `cf83fc4`。
5. **风格。** 代码、注释、标识符用英文，跟随周围代码的写法和注释密度。界面文字用英文。文档用中文。
6. **测试。**
   - 每步都要新增或更新测试。
   - 不要为了让测试通过而删除或放宽测试；只有本步骤明确要求删除的测试才能删。
   - 本仓库没有 DOM 测试环境（没有 jsdom）。`workflowCanvas.js` 在 Node 里导入不了，因为它的导入链里有 CSS。所以规则一律放进纯函数模块再测，界面部分靠手工验证。
7. **不调用付费模型。** 手工验证中需要运行 Run 或 Review 时，按 [DATA_FLOW_PLAN.md](DATA_FLOW_PLAN.md) 第 12、13 步完成记录的做法：后端换成模型调用是假的版本，或在渲染进程拦截 `/api/run`。Process 可以真实运行。
8. **Agent 与用户能力一致。** 用户能做的 Agent 能做，反之亦然。第 7 步之前，Agent 只做各步写明的“最低适配”，保证它不会出错，也不会写出界面做不出的状态。
9. **内容锁定规则不变。** 产出过结果的 Prompt 和 Dataset 只读（`contentLocks.js`），Process 代码始终可改。改连线不算改内容。
10. **提交。**
    - 每步一个功能提交，信息用英文，格式 `feat(node-ports): step N - <摘要>`；纯重构用 `refactor(node-ports): ...`。
    - 完成记录另外一个提交：`docs(node-ports): record step N`。
    - 不要添加 `Co-Authored-By` 之类的 AI 署名行。
    - 两个提交完成后 push 到 `261009-node-ports`。不要合并到任何分支，不要改动 `261007-data-flow-design` 和 `main`。
11. **完成后要登记。**
    - 在 §5 进度表中填写日期、提交哈希和测试数量。
    - 在该步骤末尾的“完成记录”中写下与计划不同的地方和遗留问题。
    - 如果改动了设计，同时更新设计文档。
12. **发布边界。**
    - 第 1、2 步完成后可以发布：只改显示，不改行为。
    - 第 3–7 步的中间状态不能发布，必须全部完成后一起发布。原因：中间状态下用户能做的事 Agent 做不了；第 6 步之后，Agent 的说明文字还在让用户去窗口里选输入。
13. **第 2 步要先给用户看。** 第 2 步完成后，把截图给用户看，外观确认后才能开始第 3 步。截图要包括：每种节点、Process 的多个分支、带版本线和来源线的画布、缩放 0.5 和 2、深色主题。

## 1. 基线与常用命令

以下命令都在仓库根目录、Git Bash 中执行。基线于 `cf83fc4` 实测：前端 210 项、后端 126 项全部通过，构建通过。

```bash
# 前端全部测试 / 单个测试
node --test "app/tests/*.test.mjs"
node --test app/tests/<名字>.test.mjs

# 后端全部测试 / 单个测试
backend/.venv/Scripts/python.exe -m unittest $(ls backend/test_*.py | sed 's#backend/#backend.#; s#\.py$##')
backend/.venv/Scripts/python.exe -m unittest backend.test_pipeline_compile -v

# 渲染进程构建（有一条已存在的“大 bundle”警告，忽略）
cd app && npx vite build --config vite.renderer.config.mjs --outDir ../.cache/renderer-check --emptyOutDir

# 运行桌面应用做手工验证（会在 8000 端口启动后端）
cd app && npm start
```

**手工验证。** 用程序驱动桌面应用的方法见 [DATA_FLOW_PLAN.md](DATA_FLOW_PLAN.md) §1，这里不重复。其中包括：CDP 调试端口 9333、绕过系统对话框、关闭后台节流、窗口最小化时只读 DOM、结束后关闭进程。本计划另外注意：

- **拖线用 CDP 的 `Input.dispatchMouseEvent`**（依次发送 `mousePressed`、多次 `mouseMoved`、`mouseReleased`，坐标是视口坐标），它产生的是可信的指针事件。不要用页面里 `dispatchEvent` 合成的事件来验证拖拽，合成事件和真实事件的行为可能不同。
- **不要替用户还原、最小化或移动窗口。** 弹出系统对话框时一律取消。
- **示例项目。** 示例只在本机的 `examples/` 下，`.gitignore` 忽略了 `examples/*.yc`，仓库里没有。验证时另存一份，不要修改原文件。
  - `Kinase–Substrate Evidence Curation.yc`：旧版，有保存出来的 Dataset 和来源线。
  - `Kinase–Substrate Evidence Curation - direct connections.yc`：步骤直接相连。14 个节点、10 条数据连线，9 个步骤都有结果，其中有带分支的 Process。

说明：

- 前端测试用 Node 自带的测试工具（`node:test`），测试对象是纯函数和普通的 `{nodes, connections}` 画布状态。
- `app/tests/pipelineSelectionBridge.mjs` 和 `historyStorageBenchmark.mjs` 不是测试，不要改名成 `.test.mjs`；`canvasFormatFixture.mjs` 和 `historyGraphFixture.mjs` 是共用的测试数据。
- 后端测试用 `unittest`，`unittest discover` 在本仓库不能用。本计划预计不改后端。
- 不要把构建输出到 `app/dist`，那里是发布用的构建。

## 2. 代码地图

执行前先读这一节，可以省去大部分代码探索。

### 2.1 节点 DOM（`app/src/workflowNodeFactories.js`）

- `createWorkflowNodeFactories(deps)`（约 51）返回七个节点的创建函数，依赖由 `workflowCanvas.js` 约 2955–3024 传入。
- **每个节点都有：**
  - `div.workflow-node.workflow-node--<type>`，带 `data-node-id`；
  - 标题栏 `.workflow-node__header`，里面是图标、标题和删除按钮；
  - 拖动 `attachDrag(node)`、点击打开窗口、右键 `showNodeContextMenu(e.clientX, e.clientY, node)`。
- **各类型：**
  - Prompt：`createPromptNode`（约 229），没有说明时加 `--no-body`。它没有设 `dataset.nodeType`。
  - Sampler：`createSamplerNode`（约 337），只有标题栏。
  - Dataset：`createDatasetNode`（约 404），总有正文 `.workflow-node__dataset-desc`。
  - Run：`createRunNode`（约 485），只有标题栏，底部有进度条。点击时传给 Run 窗口的回调里有 `selectPrompt`（约 573）和 `setInputSource`（约 604）。
  - Process：`createProcessNode`（约 625），标题栏下面是分支条 `.workflow-node__process-outputs`，然后是进度条。
  - Score：`createScoreNode`（约 742）。
  - Review：`createPromptReviewNode`（约 951），`dataset.nodeType='promptReview'`。
- **Process 分支条：** `refreshProcessOutputStrip(node)`（约 10–34，已导出）。每个分支一个 `span.workflow-node__process-port[data-port]`，CSS 在它右边画了一个 5px 的点（`workflowCanvas.css` 约 406）。动态输出时只显示一个 `--dynamic` 标签；与上次结果不符时加 `--mismatch`。调用处：创建时、读档（canvas 约 4905）、History 同步（约 5427）、代码识别同步（约 5544）、运行 Process（约 5589、5648）。
- **点击分支标签** 弹出只含这个分支的右键菜单（约 684–688）。

### 2.2 连线绘制（`app/src/workflowCanvas.js`）

- **存储。** `let connections = []`（约 1201），元素是 `{fromId, toId, type}`；`data` 连线另有 `fromPort`，连到 Process 的还有 `alias`。这个数组有时会被整体替换（约 3283、5063），所以一律通过 `() => connections` 读取。连线类型常量在约 133–150。
- **`liveInputState()`**（约 1873）返回 `{nodes, connections}`，`stepInputs.js` 的写函数直接改其中的 `connections`。
- **绘制函数：**
  - `collectNodeBoxes()`（约 2399）每次重画时量一遍所有节点的位置和大小；
  - `getEdgeGeometry(startX, startY, endX, endY, fromNode, toNode, nodeBoxes)`（约 2445）决定画直线还是绕开节点的曲线；
  - `createEdgeShape`（约 2484）；
  - `renderEdge(g, edge, edgeIndex, nodeBoxes)`（约 2492–2596）。
- **线的起点和终点（本计划要改的核心）：**
  ```js
  const startX = x1 + w1;
  const startY = portLabel ? y1 + offsetWithin(portLabel, fromNode) + portLabel.offsetHeight / 2 : y1 + h1 / 2;
  const endX = x2;
  const toHeight = edge.type === EDGE_TYPE_PROMPT_TO_PROMPT ? h2 : (isRunOrScore ? RUN_NODE_FALLBACK_HEIGHT : h2);
  const endY = y2 + (toHeight > 0 ? toHeight / 2 : RUN_NODE_FALLBACK_HEIGHT / 2);
  ```
  - 起点：起点节点右边的垂直中点。只有 Process 分支的 `data` 连线从分支标签的中点出发。
  - 终点：终点节点的左边。Run、Score、Review 取标题栏中点（`RUN_NODE_FALLBACK_HEIGHT = 40` 的一半），其他取整个节点的中点。
  - `offsetWithin`（约 2599）把 `offsetTop` 一路加到节点上。
- **线的样式：**
  - 普通线：`.workflow-edge-line`，`stroke: var(--text-muted)`，宽 2，带箭头 `marker-end: url(#workflow-arrow)`。箭头定义在约 1043–1069。
  - 来源线（`saved-from`，约 2551–2563）：宽 1、虚线 `3 4`、不透明度 0.55，没有箭头。
  - 推导出的线（约 2565）：加 class `workflow-edge--derived`。
  - 缺分支（约 2569–2580）：`missingBranch(edge, fromNode)`（约 2606）为真时变红，并加 `<title>`。
  - 以上 class 都没有 CSS 规则，样式全写在属性里。
- **能点的线：** `canCompare`（约 2522）只对非推导的 `prompt-to-prompt`、`prompt-review-to-prompt`、`dataset-to-dataset` 为真，线中间画一个对比图标。`onEdgesLayerClick`（约 2856）打开对应的对比窗口。
- **推导出的线：** `getDerivedDataFlowEdges()`（约 2616–2642）从 `dataset.savedFrom` 推出 `saved-from` 线，从 Score 的 `scoreGroundTruthId` 推出 `ground-truth-to-score` 线。
- **`updateEdges()`**（约 2670–2680）每次新建一个 `<g pointer-events="none">`，先画推导出的线，再画 `connections`。调用非常频繁：节点拖动的每次 pointermove、每次 `workflow:canvas-changed`、读档、History 同步、分支识别，以及几十处改连线的地方。**所以 `updateEdges` 里不能做重的计算（例如 `getCanvasState()`）。**
- **删除节点：** 有出边的节点不能删（`getOutgoingEdgesFromNode` 约 1858、`getWorkflowNodeDeleteBlockReason` 约 2044）。

### 2.3 坐标、平移、缩放、拖动、选择

- **DOM 层次**（约 1022–1081）：`.workflow-canvas` > `.workflow-canvas__scroll`（`scrollWrapper`，`overflow: hidden`）> `.workflow-canvas__zoom-outer` > `.workflow-canvas__scale`（`transform: scale(zoomLevel)`）> `.workflow-canvas__inner` > SVG `.workflow-canvas__edges` 和 `div.workflow-canvas__nodes`。
- **缩放：** `zoomLevel`（约 1181），0.5–2；`applyZoom`（约 1192）、`changeZoomLevel`（约 3251）。Ctrl+滚轮缩放。
- **平移：** 在空白处按下拖动（约 1162–1179），改 `scrollLeft` / `scrollTop`（`onPanMove` 约 1088）。
- **视口坐标换算成画布坐标** 没有共用函数，各处直接写：`(clientX - scrollWrapper.getBoundingClientRect().left + scrollWrapper.scrollLeft) / zoomLevel`（factories 约 161–187）。
- **节点拖动：** `attachDrag(node)`（factories 约 136–227），监听 `document` 的 pointermove/pointerup，没有处理 pointercancel，也没有 pointer capture。拖动阈值 `DRAG_THRESHOLD_PX = 4`；各节点的点击处理先检查 `wasDrag()`。
- **选择：** `selectedNodeIds`（约 1204）、`applySelectionVisuals`（约 1206）、`clearSelection`、`toggleNodeSelection`；Ctrl/Shift 拖动框选（约 1103–1160）。
- **自动平移：** 目前没有。

### 2.4 右键菜单

- `showNodeContextMenu(clientX, clientY, node, { port } = {})`（约 3316–3917）。
  - 步骤输出相关的菜单项来自 `stepOutputMenuItems(liveInputState(), nodeId, {port})`（约 3371）。传了 `port` 时只显示这些项。
  - 其余菜单项按类型直接写在 HTML 里（约 3376–3423）。
  - 动作表 `actions`（约 3464–3886），与本计划有关的：`add-sampler`（约 3598）、`create-working-dataset`、`process-this-dataset`（约 3628）、`run-this-prompt`（约 3629）、`run-prompt-on-output`（约 3631）、`process-output`（约 3632）、`new-version`、`add-version-of-dataset`、`score-add-review`。
- `app/src/stepOutputMenu.js`：只导出 `stepOutputMenuItems(state, nodeId, {port})`。Run 给 `result`，Process 给 `effectiveProcessOutputs` 的分支；每个端口给 “Run a prompt on …” 和 “Process … with code” 两项。测试在 `app/tests/stepOutputMenu.test.mjs`。
- **线上没有右键菜单，也不能删线。**
- **新建并接好线的函数：** `newRunNode({ promptNode, inputSource, open })`（约 4392）、`newProcessNode({ inputSource, open })`（约 4375）；`workflow:add-score-node`（约 4448）新建 Score 并接 `run-to-score`；`workflow:add-sampler-node`（约 4426）。

### 2.5 撤销与 History

- **改动的通知：** `document.dispatchEvent(new CustomEvent('workflow:canvas-changed'))`，工厂里叫 `emitCanvasChanged`。
- **撤销：** `renderer.js` 约 359 在每次 canvas-changed 时 `undoHistory.push(getCanvasState())`。`connections` 整体进快照，所以改连线自动成为一个撤销步骤。一次操作只应该发一次 canvas-changed。
- **History：** `renderer.js` 约 360–365 在 canvas-changed 后 150ms 调 `reconcileHistory()`（canvas 约 5271），它按新的输入重新找每个步骤的记录。换输入后显示匹配的记录，没有就显示“没有结果”，这一套已经有了，拖线只要发 canvas-changed 即可。
- **运行中的状态：**
  - Run：节点上有 `runPending` 等字段（Run 窗口的 `isRunning`，`runDetailModal.js` 约 292）。
  - Process：只记在画布内部的 `pendingProcesses` 集合里（约 5589），节点上没有标记。Process 窗口的锁只认这个窗口自己发起的运行。

### 2.6 窗口里的来源选择器（第 6 步删除）

- **Run 窗口（`runDetailModal.js`）：**
  - “Input prompt” 选择器（约 171–174、220–235），用 `nodePicker.js`，选项来自 `getPrompts`（factories 约 588）。选中后 `selectPrompt`：换掉 `prompt-to-run` 连线；列映射只保留新 Prompt 也有的输入（约 226–229）。
  - “Input” 选择器（约 175–185），`populateDropdown`（约 727）每次展开时用 `candidateGroups` 分组列出候选；选中后经 `setInputSource` → `writeRunInputSource`（canvas 约 1914）→ `stepInputs.setRunInputSource`。
  - 换输入后 `renderInputMappings`（约 755–803）清掉新表没有的列。
  - 锁定规则（约 864）：`isRunning() || (!historyMode && (isCompleted() || 有结果))`。打开了 History 的项目里，有结果不锁，只有运行中锁。
- **Process 窗口（`processDetailModal.js` 约 158–254，`processInputPicker.js`）：**
  - 勾选或取消一个输入、“Use as df”、“Change source…”。
  - 勾选改写代码参数：`codeDeclaringInputs`（`processDatasetBindings.js` 约 86）→ `withProcessParameters`（`processSignature.js` 约 84），然后 `syncProcessDependencies`（factories 约 711）→ `setProcessInputs`。
  - 代码还是没改过的示例时，换 `df` 会按新列重新生成示例代码（`buildDefaultCode`，`processDetailModal.js` 约 41，未导出）。
  - “Change source…” → `replaceProcessInputSource`：换来源，保留别名和 df 身份，代码不变。
  - 代码里用到（签名以外出现）的输入不能取消（`used`，提示 “Remove that use to stop reading this input.”）。
  - 关窗口和点 Run 时也会 `syncProcessDependencies`：代码里任何地方出现某个候选的别名，这个候选就被连上。
- **Score 窗口（`scoreDetailModal.js`）：**
  - “Ground truth dataset” 选择器（约 1502–1511），选项是所有 Dataset，在点开 Score 时取一次。
  - `selectGroundTruth`（约 3585）：写 `scoreGroundTruthId`，发 `workflow:score-ground-truth-changed` 和 canvas-changed，然后删掉新 Dataset 没有的列上的规则（`filterRootByGtHeaders` 约 1431、`persistBundle` 约 1153，都在窗口的闭包里）。
  - Score 读哪个 Run 在窗口里不能改。
- **Review 窗口、Sampler 窗口：** 不能改来源。Review 读哪个 Score、Sampler 从哪个 Dataset 抽样，只在新建时定一次。
- **提示用户去窗口里选输入的文字：**
  - `pipelineRunDialog.js` 约 16–19、34（“Open a step to change what it reads.” 等）；
  - `runDetailModal.js` 的 “Input prompt”“Select input prompt”“Input”“Select input”“Choose an Input prompt first.”；
  - `processDetailModal.js` 的 “Input”“Select inputs”、约 166 的提示、约 53–54 示例代码里的注释、“Choose an input before running.”；
  - `scoreDetailModal.js` 的 “Ground truth dataset”“Select ground truth dataset”，以及约 2591；
  - `docs/PIPELINE_GUIDE.md` 约 10–11。

### 2.7 `app/src/stepInputs.js`

- 常量 `RESULT_PORT = 'result'`、`DATA_EDGE = 'data'`。
- `sourceKey`：Dataset 是节点 ID，步骤输出是 `node:port`。`stepSourceLabel`：Dataset 名、Run 的 Prompt 名，或 “Process · 分支”。
- `readsFromStep(state, nodeId, stepId)`（约 118）：防环检查。
- `runCandidateSources` / `processCandidateSources`（约 165、170）：所有 Dataset，每个 Run 的 `result`，每个 Process 已知的分支；排除自己和下游。分支未知或动态的 Process 不给候选。**不检查是否在运行。**
- Run：`runInputSource`、`setRunInputSource`（替换唯一的那条 `data` 连线）、`runInputTable`。
- Process：`processPrimarySource`、`setProcessPrimarySource`、`processInputAliases`、`processInputSources`、`processInputBindings`、`processRequiredInputs`、`setProcessInputs`（整体替换）、`replaceProcessInputSource`（换来源，保留别名）。
- **别名规则（`processDatasetBindings.js` 的 `processDatasetInputs`）：** 连线上存的别名只要符合 `^df_[A-Za-z0-9_]+$` 就沿用，可以与来源的名字无关；没有存别名的候选用名字推出别名，重名时加 `_2`、`_3`。所以“把一个来源接到代码里已有的 `df_notes` 参数上”在现有数据模型里可行。
- 同一个来源在一个 Process 里只能是一个输入（别名表按来源键存）。

### 2.8 Agent

- `app/src/agent/operations/changeSet.js` 的 `planChangeSet`（约 106）：
  - `resolveSource`（约 142–163）：来源可以是 Dataset、Run、Process；用 `readsFromStep` 防环；同一提案里新建或改了代码的 Process 不能读；多分支时必须指定分支。
  - `wireProcess`（约 413–428）：代码里出现、却对不上任何输入的 `df_<别名>` 报错（约 416–421）。
  - `add_run`（约 622）、`add_process`（约 564）、`add_score`（约 647，标准答案写字段）、`update`（约 683 起：Run 的 `prompt`/`input`/`input_branch`/`input_mapping`，Process 的 `code`/`primary_input`/`primary_branch`，Score 的 `ground_truth`，不能改 Score 的 Run）。
  - Run 换 Prompt 时只保留共有输入的映射（约 775–778）。
  - `remove`（约 931–961）列出读者失去的输入。
  - **没有“断开一个输入、保留节点”的操作。** 只能替换，或删掉节点。
- `app/src/agent/canvas/workflowNodeInspector.js`：`inspectRun`、`inspectProcess`（`inputs`、`availableInputs`、`branches`、`readBy`、`waitingFor`）、`inspectScore`（`groundTruth` 读字段）。
- `app/src/agent/context/workspaceSummary.js`：`runLine`、`processLine`、`scoreLine`。
- `app/src/agent/tools/agentTools.js`：`propose_changes` 的 `op` 枚举里没有 connect/disconnect（约 160）。
- **第 6 步之后会说错的 Agent 文字：**
  - `backend/agent/system_prompt.py` 约 18（“`df` is the one picked in the Process window”）、约 20（“Its prompt and input are picked in the Run window”）；
  - `backend/agent/guides/pipeline-building.md` 约 37–38、40–41；
  - `backend/agent/guides/process-code.md` 约 24–25。
- 测试：`agentStepInputs.test.mjs`（连线的主要用例）、`agentRunPrompt.test.mjs`、`agentNodeSettings.test.mjs`。

### 2.9 已知的现有问题（相关步骤顺带处理）

| 问题 | 处理 |
|---|---|
| Process 代码里写了 `df_x`，却没有对应的来源时，窗口不显示也不提示；只有 Agent 会报错 | 第 5 步：显示为一个空的端口 |
| Process 运行中只记在 `pendingProcesses` 里，Process 窗口的锁只认自己发起的运行 | 第 1 步：端口规则从画布取运行状态 |
| 候选列表不检查是否在运行，只靠窗口的锁 | 第 1 步：端口规则检查 |
| `nodePicker.js` 开头的注释说 Process 窗口也用它，实际没有 | 第 6 步：删掉或改正 |
| `prompt-design.md` 约 42–43 说 Run 有自己的模型凭据，与现在的设计（一律用 Settings 默认值）不符 | 第 7 步改正 |
| `workflow:add-score-node` 里给标准答案上色的代码（约 4462–4471）对新建的 Score 永远不会执行 | 不处理，记录即可 |
| Agent 的 `remove` 不报告版本线、Sampler 线、Review → Prompt 线的消失 | 不处理，记录即可 |

## 3. 规则

设计已定的内容，执行时以这里为准。

### 3.1 端口

端口 ID 在代码、DOM（`data-port-id`）和 Agent 里通用。类型只有三种：`table`、`prompt`、`score`。

| 节点 | 左边：输入 | 右边：输出 |
|---|---|---|
| Dataset | 无 | `result`（table） |
| Prompt | 无 | `prompt`（prompt） |
| Run | `prompt`（prompt）、`input`（table） | `result`（table） |
| Process | `df`（table）；每个 `df_<别名>` 一个（table，ID 就是别名）；第 5 步起再加一个 `+` | 每个分支一个（table，ID 是分支名）；单一输出时一个 `result` |
| Sampler | `source`（table，只接 Dataset） | 无 |
| Score | `run`（只接 Run 的 `result`）、`ground_truth`（table，只接 Dataset） | `score`（score） |
| Review | `score`（score） | 无 |

**来历点**（空心，不能拖，只在有这条关系时出现；左边最多一个，右边最多一个）：

| 关系 | 起点（右边的空心点） | 终点（左边的空心点） |
|---|---|---|
| `prompt-to-prompt` | 原来的 Prompt | 新版本 |
| `prompt-review-to-prompt` | Review | Apply 生成的 Prompt |
| `dataset-to-dataset` | 原来的 Dataset | 新版本 |
| `sampler-to-dataset` | Sampler | 样本 Dataset |
| `saved-from`（从 `savedFrom` 推出） | Run、Process 或 Score | 保存出来的 Dataset |

**连线和端口的对应：**

| 连线 | 起点端口 | 终点端口 |
|---|---|---|
| `prompt-to-run` | Prompt 的 `prompt` | Run 的 `prompt` |
| `data` → Run | 来源的输出端口（`fromPort`） | Run 的 `input` |
| `data` → Process | 来源的输出端口（`fromPort`） | Process 的 `alias`（`df` 或 `df_<别名>`） |
| `run-to-score` | Run 的 `result` | Score 的 `run` |
| `ground-truth-to-score`（从 `scoreGroundTruthId` 推出） | Dataset 的 `result` | Score 的 `ground_truth` |
| `score-to-prompt-review` | Score 的 `score` | Review 的 `score` |
| `dataset-to-sampler` | Dataset 的 `result` | Sampler 的 `source` |
| 来历类（上表） | 右边的空心点 | 左边的空心点 |

### 3.2 显示

- 实心点是数据端口，按类型着色，可以拖。空心点是来历，不能拖。
- 所有线都是实线，保持现在的灰色；悬停或选中一个节点时，高亮和它相连的线。`saved-from` 的细虚线改为普通实线。
- 端口名在需要时才显示：某一边有两个以上端口，或名字本身有意义（Process 的 `df`、`df_<别名>`、分支名）时显示。Dataset、Prompt 只有一个输出，不写名字。不做“折叠端口名”的开关。
- 版本线、Review → Prompt 线点击后打开对比窗口，这个功能不变。

### 3.3 实施细节

设计没有写到、但实施时必须定下来的地方。全部已由用户确认（2026-10-09）。

1. **哪些输入能拖。** 现在界面上能改的输入，拖线也能改：Run 的 `prompt` 和 `input`、Process 的所有输入、Score 的 `ground_truth`。现在界面上改不了的，端口照样画，但不能替换或断开，悬停时说明原因：Score 的 `run`、Review 的 `score`、Sampler 的 `source`。原因是 Score 的规则和结果是针对那个 Run 的，Review 是针对那个 Score 的分析。
2. **断开以后可以是空的。** 断开 Run 的 `prompt`、`input`，Process 的 `df`，或 Score 的 `ground_truth` 以后，端口就空着，节点不能运行，窗口里提示缺什么。断开 Process 的 `df_<别名>` 时，同时从代码参数中去掉它（第 5 步）。
   - 例外（第 1 步发现，用户 2026-10-09 回复“继续”，按此处理）：Process 还有其他输入时，`df` 不能断开，只能替换。现有数据模型里，没有标记为 `df` 的输入时，第一个输入就是 `df`（`stepInputs.js` 的 `processPrimarySource`），所以“`df` 空着、别的输入还在”存不下来。
3. **从输入端口拖走一条线。** 按住一个已接线的输入端口拖动，就把这条线从这个端口上拿起来：
   - 放到另一个能接的输入端口上：改接到那里（一个撤销步骤）；
   - 在空白处松开：断开，不弹菜单；
   - 放回原处：不变。
4. **反向拖。** 从一个空的输入端口拖到一个输出端口，也能接上，规则相同；在空白处松开就取消。
5. **箭头。** 线的终点已经有圆点，去掉箭头（第 2 步看过截图后确认）。
6. **同一个来源在一个 Process 里只能接一次。** 把一个已经是 `df_lookup` 的来源拖到同一个 Process 的 `df` 上时，拒绝，并说明 “Already df_lookup of this Process; disconnect it there first.”。
7. **线上的右键菜单。** 能断开的线，右键有一项 “Disconnect”；不能断开的线和来历线没有右键菜单（版本线照旧点击打开对比窗口）。

## 4. 步骤

### 步骤 1：端口规则模块 `nodePorts.js`（纯函数）

**目标：** 把 §3.1 的端口定义和“能不能连”的规则写成一个纯函数模块，画布、拖线和 Agent 以后都调用它，规则只写一处。

**前置：** 无。

**发布：** 可以单独发布（没有界面变化）。

**先读：** 设计第 4、5 节；本文 §2.5、§2.7、§3；`stepInputs.js` 全文；`processOutputPorts.js`；`changeSet.js` 的 `resolveSource`、`update` 中 Run 换 Prompt 的部分（约 760–790）；`runDetailModal.js` 的锁定规则（约 292、864）。

**改动：**

1. 新建 `app/src/nodePorts.js`，输入一律是普通的 `{nodes, connections, historyVersion}` 画布状态，不碰 DOM。导出：
   - `PORT_TYPES`：`{ TABLE: 'table', PROMPT: 'prompt', SCORE: 'score' }`。
   - `nodePorts(state, nodeId)` → `{ inputs, outputs, lineageIn, lineageOut }`。
     - `inputs` / `outputs` 的元素：`{ id, type, label, showLabel, source?, readers?, fixed?, unavailable? }`。
       - `source`：输入当前接的来源；
       - `fixed`：不能替换或断开时的原因（§3.3 第 1 条）；
       - `unavailable`：输出现在不能被读时的原因（例如 Process 分支未知或是动态的）。
     - `lineageIn` / `lineageOut`：有没有来历点。
     - `showLabel` 按 §3.2 的规则算。
     - Process 的输入：`df` 总是有；`df_<别名>` 来自连线上的 `alias`（第 5 步再加上代码参数和 `+`）。
     - Process 的输出：分支来自 `effectiveProcessOutputs`；分支未知或动态时给一个带 `unavailable` 的 `result`。
   - `edgeEndpoints(state, edge)` → `{ from: { nodeId, portId, lineage? }, to: { nodeId, portId, lineage? } }`，按 §3.1 的对应表，包括推导出的 `saved-from` 和 `ground-truth-to-score`。对不上任何端口时返回 `null`（画布按老办法画）。
   - `checkConnect(state, from, to, { running })` → `{ ok: true, op }` 或 `{ ok: false, reason }`。`from` / `to` 都是 `{ nodeId, portId }`，`running` 是正在运行的节点 ID 集合。依次检查：
     - 两端的方向和类型对得上（输出接输入；Score 的 `ground_truth`、Sampler 的 `source` 只接 Dataset；Score 的 `run` 只接 Run）；
     - 目标端口不是 `fixed`，来源端口不是 `unavailable`；
     - 不是自己，不成环（`readsFromStep`）；
     - 目标节点不在运行；按 Run 窗口的规则，没打开 History 的项目里，有结果的 Run 不能换输入；
     - 同一个来源在一个 Process 里只能接一次（§3.3 第 6 条）；
     - 已经接着同一个来源时返回 `{ ok: true, op: null }`（什么都不用做）。
     `reason` 是给用户看的英文短句，例如 “This would make a loop: Tidy already reads this Run.”。
   - `checkDisconnect(state, to, { running })`：同样返回 `op` 或 `reason`。Process 的 `df_<别名>` 在本步骤一律返回 “Coming in a later step”之类的拒绝，第 5 步再实现。
   - `applyPortOp(state, op)`：在 `state` 上执行操作，就地修改 `connections` 和节点字段，复用 `stepInputs.js` 的写函数。操作类型：
     - `run-prompt`：换 `prompt-to-run` 连线；`runInputToColumn` 只保留新 Prompt 也有的输入。把 `changeSet.js` 约 775–778 的这条规则抽成共用函数，Agent 也改用它。
     - `run-input`：`setRunInputSource`；新输入的列已知时，清掉映射里新表没有的列（与 `renderInputMappings` 相同）。
     - `process-df`：df 原来空着用 `setProcessPrimarySource`，否则用 `replaceProcessInputSource`；代码还是没改过的示例时，按新列重新生成示例代码（把 `buildDefaultCode` 移到不依赖 DOM 的模块）。
     - `process-alias`：已有别名端口换来源，用 `replaceProcessInputSource`，别名和代码都不变。
     - `score-ground-truth`：写 `scoreGroundTruthId`。
     - 断开：`run-prompt`、`run-input`、`process-df`、`score-ground-truth` 各自清空。
     - 改接（§3.3 第 3 条）由调用方先断开、再连接，两个操作合成一次画布变化。
2. Score 换标准答案时删规则（§2.6）：先确认 Score 窗口打开时会不会按当前标准答案清理规则。
   - 会：本步骤不处理，在完成记录中写明。
   - 不会：把 `filterRootByGtHeaders` 抽成纯函数，`applyPortOp` 换标准答案时调用。规则存在哪个字段里、怎么写回，照 `persistBundle` 的做法。
3. 运行状态：给画布加一个 `runningNodeIds()`，包括 `pendingProcesses` 和正在运行的 Run；本步骤只加函数，不接到界面。

**测试：** 新建 `app/tests/nodePorts.test.mjs`。

- 七种节点的端口列表；`showLabel` 的规则；Process 的已知、未知、动态分支。
- `edgeEndpoints`：§3.1 对应表里的每一种连线，包括推导出的两种。
- `checkConnect`：每一条拒绝理由各一个用例；替换；接同一个来源时 `op` 为 `null`；`fixed` 的三个端口。
- `applyPortOp`：每种操作执行后的连线和字段；换 Prompt 时映射只保留共有输入；换输入时去掉新表没有的列；示例代码随新 `df` 重新生成。
- Agent 改用共用的映射函数后，`agentRunPrompt.test.mjs` 不变且通过。

**手工验证：** 无（没有界面变化）。

**Agent：** 只把 Run 换 Prompt 的映射规则改为调用共用函数，行为不变。

**验收：**

- [x] 前后端测试全部通过。
- [x] 构建通过。

**完成记录：** 2026-10-09 完成，验收各项全部通过。

- 与计划不同的地方：
  - **没有加 `runningNodeIds()`。** 画布的 `liveInputState()` 已经在 Run 上带 `runPending`、在 Process 上带 `processPending`（来自 `pendingProcesses`），`nodePorts` 直接读这两个字段；另外接受可选的 `running` 集合。
  - **Score 换标准答案时删规则，本步骤就做了。** Score 窗口打开时会按当前标准答案清理规则，按计划本可以不做；但从 Score 的右键菜单发起 Review 不会打开窗口，会带着已经不存在的列上的规则。所以把窗口里的 `filterRootByGtHeaders` 移到 `scoreMappingBundle.js`（`filterScoreRulesByGtColumns`），另加 `scoreMappingForGroundTruth`，`applyPortOp` 换标准答案时调用，窗口也改用同一个函数。
  - **Process 的 `df` 有其他输入时不能断开。** 见 §3.3 第 2 条的例外，待用户确认。
  - 来历点：Score 的结果也能保存成 Dataset（`savedFrom.kind` 为 `score`），所以 Score 也会有右边的空心点。§3.1 的表已改。
  - `buildDefaultCode` 移到新模块 `processSampleCode.js`（`buildDefaultProcessCode`、`isUntouchedSampleCode`），Process 窗口改用它。
  - 输出端口的 `mismatch` 是一句提示文字，不是布尔值，可以直接用作悬停提示。
- 发现并修正的现有问题：保存的 Process 代码会被去掉首尾空白（`resolveDataframeProcessCode` 里的 `trim()`），而示例代码以换行结尾，所以项目保存、重新打开以后，没改过的示例代码就不再被认作示例，换 `df` 时不会跟着新列重新生成。`isUntouchedSampleCode` 改为比较去掉首尾空白后的文字，Process 窗口也因此恢复了这个行为。
- `applyPortOp` 的 `promptInputs` 选项：调用方给出 Prompt 的输入名（画布用 Prompt 的段落，Agent 用 `extractInputFields`）。不给时，换 Prompt 不改映射。
- 测试：前端 210 → 236（`nodePorts.test.mjs` 26 项）；后端 126 项不变。
- 没有手工验证（本步骤没有界面变化）。两个窗口的代码改动由构建和单元测试覆盖，第 2 步的手工验证中顺带在界面上检查（已加入第 2 步的清单）。

---

### 步骤 2：画出端口和来历点，线接到点上

**目标：** 实现设计第 6 节和本文 §3.2：每个节点按 §3.1 画出实心端口和空心来历点，所有线都从点出发、到点结束。不加任何交互。

**前置：** 步骤 1。

**发布：** 可以单独发布。

**先读：** 本文 §2.1、§2.2；`refreshProcessOutputStrip`；`renderEdge`、`getDerivedDataFlowEdges`、`updateEdges`；`workflowCanvas.css` 中 `.workflow-node`（约 235）、窄节点（约 303–375）、分支条（约 378–440）。

**改动：**

1. **端口的 DOM。** 用一个通用的 `refreshNodePorts(node, state)` 取代 `refreshProcessOutputStrip`，在原来所有调用它的地方调用，另外在每次 canvas-changed 后刷新所有节点（端口取决于连线，例如来历点）。
   - 每个端口是一个 `.workflow-node__port`，带 `data-port-id`、`data-port-side`、`data-port-type`；来历点另加 `--lineage`。
   - 端口名放在点旁边，按 `showLabel` 决定是否显示。
   - Process 原来的 `--dynamic`、`--mismatch` 样式要保留对应的显示。
   - 点击分支端口弹出只含这个分支的菜单，这个行为保留。
2. **布局。** 实心点和空心点都骑在节点边框上，一半在里一半在外。
   - `.workflow-node` 现在是 `overflow: hidden`，会把点裁掉。改为 `overflow: visible`，把裁剪移到标题、正文这些内容元素上，节点的圆角和最大高度不能变。
   - 某一边只有一个不显示名字的端口时，点放在标题栏的垂直中点，不加端口行。
   - 要显示名字的端口在标题栏下方逐行排列，左右两列各自从上往下排。
   - 空心点放在同一边最后一个端口的下一行；那一边没有端口行时，放在标题栏的下沿。
   - 这些位置先按这里做，第 2 步结束时给用户看截图再调（§0 第 13 条）。
3. **颜色。** 在 `workflowCanvas.css` 中为三种类型各定义一个颜色变量，浅色和深色主题各一套；空心点是背景色填充、类型色描边，来历点用 `var(--text-muted)` 描边。
4. **线的端点。** `renderEdge` 用 `edgeEndpoints` 找到两端的点，读点在节点里的位置（`offsetWithin`）算出坐标。
   - 找不到点时（例如缺分支），按现在的办法画，缺分支的线照旧变红。
   - 去掉 `isRunOrScore`、`RUN_NODE_FALLBACK_HEIGHT` 这些只为“线接在哪里”服务的特殊处理。
   - **不要在 `renderEdge` / `updateEdges` 里调用 `nodePorts` 或 `getCanvasState()`**：端口在 `refreshNodePorts` 时就画好了，`updateEdges` 只读 DOM。
5. **线的样式。**
   - `saved-from` 改为和其他线一样的实线（宽度、颜色、不透明度都相同），保留它的 `<title>`。
   - 去掉箭头（§3.3 第 5 条，等截图确认）。
   - 悬停一个节点或选中节点时，给和它相连的线加 `workflow-edge--active`，颜色加深。悬停只切换 class，不要整个重画。
6. **悬停提示。** 用原生 `title`：
   - 输出端口：名字、行数和列名（有结果时）；`unavailable` 时写原因。
   - 输入端口：当前来源，或 “Not connected”；`fixed` 时写原因。
   - 来历点：例如 “New version of Extract v1”“Saved from Run "Extract"”。

**测试：**

- `showLabel` 和布局里能抽成纯函数的部分（例如“某一边的端口怎么排”），放进 `nodePorts.test.mjs` 或新的测试文件。
- `edgeEndpoints` 已在第 1 步测过；如果本步骤改了它，补上用例。

**手工验证：**

- [x] 打开直接连线的 Kinase 示例副本：每条线的两端都落在点上，Process 的每个分支各有一个点、各自出线。
- [x] 打开旧版 Kinase 示例副本：保存出来的 Dataset 的来源线是实线，从 Run 或 Process 右边的空心点出发，到 Dataset 左边的空心点。
- [x] 新建 Prompt 版本、Dataset 版本、Sample，以及用假模型做一次 Review → Apply：各自的来历点和线都对；版本线中间的对比图标还在，点击能打开对比窗口。
- [x] Score 的标准答案线接到 `ground_truth` 端口。
- [x] 缩放 0.5 和 2：点和线对齐。
- [x] 拖动节点：线跟着点走，拖动不卡。
- [x] 悬停、选中节点：相连的线高亮。
- [x] 深色主题下点和线都看得清。
- [x] 撤销、重做、保存后重新打开，显示不变。
- [x] 第 1 步改动了两个窗口的代码，顺带检查：Process 窗口里换 `df` 时，没改过的示例代码按新列重新生成（包括保存后重新打开的项目）；Score 窗口里换标准答案时，新 Dataset 没有的列上的规则被删掉。
- [x] 截图给用户看，按用户意见调整，用户确认后在完成记录中写明（§0 第 13 条）。

**Agent：** 无改动。

**验收：**

- [x] 前后端测试全部通过。
- [x] 构建通过。
- [x] 手工验证全部通过，用户已确认外观。

**完成记录：** 2026-10-09 完成，验收各项全部通过。

- 与计划不同的地方：
  - **`updateEdges` 调用 `edgeEndpoints`。** 计划说 `updateEdges` 里不调用 `nodePorts`。实际做法：每次重画取一次 `liveInputState()`，对每条线调用轻量的 `edgeEndpoints` 找到两端的端口，再从 DOM 上读点的位置；`nodePorts` 只在 `refreshNodePorts` 里调用。
  - **悬停提示在鼠标移到点上时才计算**（`applyPortTitles`），不在刷新端口时算。输出端口的提示要算行数和列名，Run 流式返回结果时每次部分更新都会发画布变化，放在刷新里太重。
  - 新增 DOM 模块 `workflowNodePorts.js`（`renderNodePorts`、`applyPortTitles`、`findPortDot`、`centerWithin`），布局和提示文字是 `nodePorts.js` 的纯函数 `portLayout`、`portTitles`。
  - **什么时候刷新端口：** 画布变化、读档、History 同步、Process 分支识别、Score 换标准答案；`refreshNodePorts` 用 `WeakMap` 记下每个节点上次画的端口，没变就不重画。另外 `updateEdges` 发现有还没画过端口的节点时先补画。
  - `liveInputState()` 补上画端口要用的字段：Dataset 的 `savedFrom`、Score 的 `scoreGroundTruthId`、Sampler 的 `name` 和 `sourceNodeId`、Review 的名字。
  - **布局：** 节点改为 `overflow: visible`（标题和正文本来就各自裁剪文字）；有端口行的节点去掉 `max-height`，随端口变高。左右两列中，输入一列不被压缩（两边都有时最多占一半），输出一列占剩下的宽度，否则 Process 左边的 `df` 会被右边很长的分支名挤成 “d.”。
  - **颜色：** 三种类型的颜色变量放在 `index.css` 的主题里（`--port-table`、`--port-prompt`、`--port-score`），浅色、深色各一套。高亮的线同时加粗到 3，否则深色主题下和普通的线分不清。
  - 箭头去掉后，SVG 里的箭头定义和对应的 CSS 一并删除。
- 手工验证（桌面应用，程序驱动，没有调用模型）：
  - 用直接连线版示例的副本加上 Score、Review 和 Apply 生成的 Prompt、Prompt 版本、Sampler 和样本、Dataset 版本、保存出来的 Dataset，做成一个包含所有类型点的项目（scratchpad `ports2/make_showcase.mjs`）。
  - 用脚本量每条线的两个端点与最近的点中心的距离：缩放 50%、100%、200% 下 23 条线都在 0.92 像素以内，没有一条退回老位置；用真实鼠标事件拖动 Run 节点后、撤销和重做后、保存后重新打开，结果相同。旧版 Kinase 示例 25 条线（其中 11 条来源线）在 0.93 像素以内。
  - 在应用里新建 Prompt 版本、Dataset 版本、Sampler 和样本、Score：各自的空心点、实心点和线都对；33 条线都落在点上。真实鼠标点击 Process 分支行，弹出只含这个分支的两项菜单。
  - 第 1 步的窗口改动：新建 Process 后在窗口里把 `df` 换成另一个 Dataset，示例代码按新列重新生成；保存（文件里的代码末尾没有换行）、重新打开后换回去，示例代码仍然跟着换列。Score 窗口里把标准答案换成没有 MeSH 列的 Dataset，MeSH 上的规则被删掉，Title 上的规则保留，标准答案线跟着移到新的 Dataset。
  - 截图给用户看（总览、Score/Review/Sampler 特写、分支和保存出来的 Dataset 特写、深色主题），用户确认外观。
- 截图里有几条线要绕一圈才进 Run 的 `prompt` 端口：示例把 Prompt 放在 Run 的右上方，线只能往回绕，与端口无关。把 Prompt 摆到 Run 左边即可。
- 测试：前端 236 → 238（`portLayout`、`portTitles` 各 1 项）；后端 126 项不变。

---

### 步骤 3：拖线连接、替换、改接、断开

**目标：** 实现设计第 5 节的连接、替换、断开和自动平移，以及 §3.3 的第 3、4、7 条。窗口里的选择器暂时保留，两边改的是同一份数据。

**前置：** 步骤 2，且用户已确认外观。

**发布：** 不能单独发布（§0 第 12 条）。

**先读：** 本文 §2.3、§2.5、§3.3；`attachDrag`；画布的平移处理（约 1088、1162–1179）；`showNodeContextMenu` 的菜单机制（约 3888–3916）。

**改动：**

1. 新建 `app/src/workflowPortDrag.js`（DOM 模块），由 `workflowCanvas.js` 初始化，负责下面所有拖线交互。规则一律调用 `nodePorts.js`，不要另写判断。
2. **开始拖。** 在实心点上按下左键：
   - 输出端口：从这个点拉出一条临时线；
   - 空的输入端口：反向拉线（§3.3 第 4 条）；
   - 已接线的输入端口：把这条线拿起来（§3.3 第 3 条），`fixed` 的端口不能拿；
   - 空心点：不拖，按下时用提示说明 “Created by … ; it can't be connected by dragging.”。
   - 拖动不能触发节点拖动、节点点击和画布平移。用 pointer capture，并处理 pointercancel。
   - 按下后移动不到拖动阈值（`DRAG_THRESHOLD_PX`）就松开，算点击：Process 分支端口照旧弹出这个分支的菜单，其他端口不做事。
3. **拖的过程中。**
   - 临时线从起点跟着鼠标，形状与正式的线相同。
   - 对每个可能的目标端口调用 `checkConnect`：能接的高亮，不能接的变暗；鼠标停在不能接的端口上时，在旁边显示 `reason`。
   - 自动平移：鼠标离 `scrollWrapper` 边缘 40px 以内时，画布朝那个方向滚动，越靠边越快（用 `requestAnimationFrame`，松开或离开时停止）。速度的计算写成纯函数并测试。
   - 把视口坐标换算成画布坐标的函数提出来共用（§2.3 说现在各处直接写）。
4. **松开。**
   - 在能接的端口上：执行 `applyPortOp`，然后发一次 canvas-changed（撤销步骤和 History 同步都靠它）。拿起来的线改接到别处时，断开和连接合成一次。
   - 在不能接的端口上、或反向拉线时在空白处：取消。
   - 拿起来的线在空白处：断开（`checkDisconnect` 通过时）。
   - 从输出拉出的线在空白处：本步骤先取消，第 4 步改为弹出菜单。
   - Score 换了标准答案时，另外发 `workflow:score-ground-truth-changed`，与窗口相同。
5. **线上的右键菜单**（§3.3 第 7 条）：能断开的线右键出现 “Disconnect”。`updateEdges` 现在整个线层都是 `pointer-events="none"`，要给这些线加一条和对比线一样的透明粗线作为点击区域。
6. **窗口同步。** 窗口是模态的，拖线时不会有窗口开着。确认打开窗口时显示的是拖线后的来源和映射。

**测试：**

- 自动平移速度、坐标换算等新的纯函数。
- 第 1 步的 `checkConnect` / `checkDisconnect` / `applyPortOp` 用例按需要补充，例如改接。

**手工验证：** 新建项目，全部用拖线操作；Run 用拦截 `/api/run` 的模拟应答，Process 真实运行。

- [ ] Prompt → Run 的 `prompt`，Dataset → Run 的 `input`，运行；Run 的 `result` → 新 Process 的 `df`，运行。
- [ ] 把另一个 Dataset 拖到 Run 的 `input` 上：替换；Run 显示“没有结果”；拖回原来的 Dataset，原来的结果回来（History）。
- [ ] 拿起 Run 的 `input` 线改接到另一个 Run 的 `input`；拿起后在空白处松开：断开。
- [ ] 线上右键 “Disconnect”。
- [ ] 拒绝：成环、类型不对、目标在运行、Process 分支未知、同一来源接两次，每种都显示原因。
- [ ] Score 的 `ground_truth`：拖入、替换、断开；Score 的 `run`、Review 的 `score`、Sampler 的 `source` 拖不动，悬停显示原因。
- [ ] 空心点按下有提示，拖不出线。
- [ ] 把线拖到画布边缘：画布自动平移，能接到原来看不见的节点。
- [ ] 缩放 0.5 和 2 下拖线位置准确。
- [ ] 每次操作都能撤销、重做；保存后重新打开不变。
- [ ] 打开 Run、Process、Score 窗口，显示的来源与拖线结果一致。

**Agent：** 无改动（用户现在能断开输入，Agent 还不能，第 7 步补上）。

**验收：**

- [ ] 前后端测试全部通过。
- [ ] 构建通过。
- [ ] 手工验证全部通过。

**完成记录：** （待填）

---

### 步骤 4：在空白处松开，弹出创建菜单

**目标：** 实现设计第 5 节“在空白处松开”：从输出端口拉出的线在空白处松开时，弹出创建菜单，新节点放在松开的位置，并已接好这条线。

**前置：** 步骤 3。

**发布：** 不能单独发布。

**先读：** 本文 §2.4；`stepOutputMenu.js` 及其测试；`newRunNode`、`newProcessNode`、`workflow:add-score-node`、`workflow:add-sampler-node`。

**改动：**

1. 把 `stepOutputMenuItems` 推广为 `outputMenuItems(state, nodeId, { port })`，覆盖所有类型的输出端口：
   | 输出 | 菜单项 |
   |---|---|
   | Dataset 的 `result` | Run a prompt on it、Process with code、Sample |
   | Prompt 的 `prompt` | Run this prompt |
   | Run 的 `result` | Run a prompt on results、Process results with code、Score |
   | Process 的分支 | Run a prompt on '<分支>'、Process '<分支>' with code |
   | Score 的 `score` | Review |
   右键菜单里这些项也改用这个函数，原来的文字和顺序不变；Dataset、Prompt、Run、Score 右键菜单里与输出无关的项不动。
2. 新节点放在松开的位置：节点左边对准鼠标，标题栏的垂直中点对准鼠标。给 `newRunNode`、`newProcessNode` 和相关事件加一个可选的位置参数。
3. 各项是否打开窗口，与对应的右键菜单项相同。“Review” 会立即发起一次 Review（调用模型），与 Score 右键菜单相同；没有标准答案时给出同样的提示。
4. 在菜单外点击或按 Esc：取消，不新建。

**测试：** 扩充 `stepOutputMenu.test.mjs`（或改名为 `outputMenu.test.mjs`）：每种输出的菜单项；Process 指定分支；分支未知时没有菜单项。

**手工验证：**

- [ ] 表里每种输出各拉一次线到空白处，选每一项：新节点出现在松开处，线已接好。
- [ ] Review 用假模型。
- [ ] 取消不新建；新建可以一步撤销。
- [ ] 右键菜单的内容与之前相同。

**Agent：** 无改动。

**验收：**

- [ ] 前后端测试全部通过。
- [ ] 构建通过。
- [ ] 手工验证全部通过。

**完成记录：** （待填）

---

### 步骤 5：Process 的输入端口与代码参数双向同步

**目标：** 实现设计第 5 节的 Process “+” 端口：端口和 `process()` 的参数两边同步。

**前置：** 步骤 4。

**发布：** 不能单独发布。

**先读：** 本文 §2.6 中 Process 窗口一段、§2.7 的别名规则；`processSignature.js`；`processDatasetBindings.js`；`processInputPicker.js` 的 `toggle`；`syncProcessDependencies`。

**改动：**

1. **代码参数变成端口。** `nodePorts` 中 Process 的输入改为：`df`，加上代码签名里每个 `df_<x>` 参数（`parseProcessSignature`），再加上连线上有、签名里没有的别名，最后是 `+`。
   - 签名里有、却没有来源的参数，显示为空的端口，悬停写 “Not connected”。节点不能运行，提示缺哪个输入，与缺 `df` 时相同。
   - 现有规则不变：代码里出现某个候选的别名（由名字推出的那个）时，这个候选会被自动连上（`syncProcessDependencies`）。
2. **拖到 `+`。** 与在窗口里勾选一个输入相同：用 `codeDeclaringInputs` / `withProcessParameters` 在代码参数里加上它的别名，再 `setProcessInputs`。
3. **拖到空的参数端口 `df_x`。** 连上这个来源，别名就是 `df_x`（§2.7 说明连线上的别名可以与名字无关），代码不变。
4. **断开 `df_<别名>`。** 与在窗口里取消勾选相同：从参数中去掉它，再同步连线。代码在签名以外用到它时（`used`），拒绝，原因与窗口相同：“Remove that use to stop reading this input.”。
5. 代码和连线在同一次操作里改，只发一次 canvas-changed，撤销时一起回去。
6. `checkDisconnect` 中第 1 步留下的 “Coming in a later step” 去掉。

**测试：** 扩充 `nodePorts.test.mjs`：

- 签名里的参数成为端口，没有来源的为空；
- 拖到 `+` 后代码参数和连线；
- 接到空的 `df_x` 端口后别名是 `df_x`；
- 断开别名后参数被去掉；
- 代码在签名外用到时拒绝断开；
- 撤销用的状态（代码和连线）一致。

**手工验证：**

- [ ] 把一个 Dataset 拖到 Process 的 `+`：代码多出参数，节点多出端口；运行时 `df_<名字>` 是这个表。
- [ ] 在代码里手写 `df_notes`：关窗口后节点出现空的 `df_notes` 端口，节点提示缺输入；把一个 Run 的结果拖上去，运行时 `df_notes` 是它。
- [ ] 断开一个只在签名里出现的别名：参数消失；断开一个在函数体里用到的别名：被拒绝并说明原因。
- [ ] 撤销、重做；保存后重新打开。

**Agent（最低适配）：** Agent 读取或修改的 Process 可能带有空的参数端口：

- `inspect_node` 列出空的参数（例如 `unconnectedInputs`），诊断里写明缺哪个输入。
- `wireProcess` 不再因为“代码里有对不上来源的别名”报错，改为在确认卡片上提示这个参数还没有来源，与界面一致。更新 `agentStepInputs.test.mjs` 中对应的用例（这是本步骤明确要求的改动）。

**验收：**

- [ ] 前后端测试全部通过。
- [ ] 构建通过。
- [ ] 手工验证全部通过。

**完成记录：** （待填）

---

### 步骤 6：去掉窗口里的来源选择器

**目标：** 实现设计第 5 节“只用拖线连接”：Run、Process、Score 窗口不再选择来源，只显示当前来源，点击跳到那个节点。

**前置：** 步骤 5。

**发布：** 不能单独发布（Agent 的说明文字第 7 步才更新）。

**先读：** 本文 §2.6 全部；`runDetailModal.js`、`processDetailModal.js`、`processInputPicker.js`、`nodePicker.js`、`scoreDetailModal.js` 中与选择器有关的部分；`pipelineRunDialog.js`；`focusPipelineNodes`（canvas 约 1224）。

**改动：**

1. **Run 窗口：** “Input prompt” 和 “Input” 两个选择器换成只读的两行：
   - 有来源时显示来源名，点击关闭窗口、选中并滚动到那个节点；
   - 没有时显示 “Drag a Prompt onto this Run's prompt port.” / “Drag a Dataset or a step output onto this Run's input port.”。
   - 列映射照旧在窗口里改。
2. **Process 窗口：** 去掉 `processInputPicker`，换成只读的输入列表：每个输入一行，写别名和来源，点击跳到来源；空的参数写 “Not connected”。
   - 去掉 “Use as df”“Change source…”：在画布上把线拖到 `df` 或别名端口上即可。
   - 代码编辑器和代码参数的同步（第 5 步）不变。
   - 改正 `processDetailModal.js` 约 166 的提示，以及示例代码里提到 “Input datasets you check” 的注释。注意：改了示例代码的文字以后，已有项目里没动过的示例代码就不再被认作示例（见 DATA_FLOW_PLAN 第 8 步完成记录），所以要让识别示例的逻辑同时认新旧两种文字。
3. **Score 窗口：** “Ground truth dataset” 选择器换成只读的一行，同样能点击跳转；没有时写 “Drag a Dataset onto this Score's ground truth port.”。
4. **Run Pipeline 对话框：** 卡片原来点击打开节点窗口去改输入，改为选中并滚动到这个节点；文字改为说明在画布上把线拖到输入端口上。
5. **删除不再使用的代码：** `processInputPicker.js`；`nodePicker.js`（确认没有别处使用后）；`getPrompts`、`readRunInputCandidates`，以及只为选择器服务的回调。`candidateGroups` 只被窗口使用时一并删除，同时删除它的测试（本步骤明确允许）。
6. **文档：** `docs/PIPELINE_GUIDE.md` 约 10–11 改为拖线的说法；设计文档 [DATA_FLOW_DESIGN.md](DATA_FLOW_DESIGN.md) §5.2、§5.3 加一句“已被 NODE_PORTS_DESIGN 取代”。
7. 改正 §2.6 列出的代码注释中描述旧做法的地方。

**测试：** 删除选择器后不再使用的测试按第 5 条处理；新增的纯函数（例如只读列表的文字）补测试。

**手工验证：**

- [ ] 从顶栏新建 Run：窗口里提示拖 Prompt 和输入；在画布上拖好以后再打开，显示来源，可以做映射并运行（模拟应答）。
- [ ] Process 窗口的输入列表与节点的端口一致；点击来源能跳过去。
- [ ] Score 窗口的标准答案一行；点击能跳过去。
- [ ] Run Pipeline 对话框的卡片点击后跳到节点。
- [ ] 旧版和直接连线版 Kinase 示例都能打开，没有报错。
- [ ] 全面回归：直接连线的 Kinase 示例副本中，依次单独运行各步骤（Run 用模拟应答），结果正确；Current Pipeline 面板和 Run Pipeline 照常可用（Run Pipeline 用假模型后端）。

**Agent：** 无改动（第 7 步）。

**验收：**

- [ ] 前后端测试全部通过。
- [ ] 构建通过。
- [ ] 手工验证全部通过。

**完成记录：** （待填）

---

### 步骤 7：Agent 同步

**目标：** Agent 能做用户用拖线做的所有事，说明文字与新的界面一致。

**前置：** 步骤 6。

**发布：** 第 3–7 步完成后一起发布。

**先读：** 本文 §2.8；`changeSet.js` 全文；`agentTools.js`；`backend/agent/system_prompt.py`；`backend/agent/guides/` 下的 `pipeline-building.md`、`process-code.md`、`prompt-design.md`、`evaluation.md`。

**改动：**

1. **新的操作 `connect` 和 `disconnect`**，规则全部调用 `nodePorts.js` 的 `checkConnect` / `checkDisconnect` / `applyPortOp`，保证与拖线完全一致：
   - `connect`：`{ op: 'connect', node, input, source, branch? }`，`input` 是 §3.1 的端口 ID（`prompt`、`input`、`df`、`df_<别名>`、`+`、`ground_truth`）。
   - `disconnect`：`{ op: 'disconnect', node, input }`。
   - 确认卡片写明改了什么，例如 “Run "Extract" reads "Sample 20" instead of "Abstracts"”。
   - 原有的 `add_run` 的 `input`、`update` 的 `prompt`/`input`/`primary_input`/`ground_truth` 保留，内部也改为调用 `nodePorts`，避免两套规则。
2. **`inspect_node`：** 每个节点的端口（ID、接的来源、`fixed` 的原因），与悬停提示的内容相同。
3. **工具说明和后端文字：**
   - `agentTools.js` 的 `propose_changes` 加上 `connect` / `disconnect`。
   - 改正 §2.8 列出的会说错的文字：Prompt 和输入是在画布上拖线接到 Run 的端口上，`df` 和其他输入是 Process 左边的端口，与代码参数同步。
   - 告诉用户怎么操作时用拖线的说法。
   - 改正 `prompt-design.md` 约 42–43 关于 Run 自己的模型凭据的说法（§2.9）。
4. 改正 §2.8 列出的代码注释中 “Like the Run window”“as the Process window” 一类已不准确的说法。

**测试：** 新建 `app/tests/agentPorts.test.mjs`：

- `connect` / `disconnect` 对每种端口各一个用例；拒绝的理由与 `checkConnect` 相同；
- `+` 和空的 `df_x`；断开在函数体里用到的别名被拒绝；
- `inspect_node` 的端口信息；
- 原有 Agent 测试全部通过。

**手工验证：** 后端换成假模型，Agent 的每一轮回复由脚本代替（DATA_FLOW_PLAN 第 13 步的做法）：

- [ ] 让 Agent 断开一个 Run 的输入、再接到另一个步骤的输出；卡片内容正确，Apply 后画布与拖线的结果相同，可以撤销。
- [ ] 让 Agent 给 Process 接一个 `+` 输入：代码参数和端口都对。

**验收：**

- [ ] 前后端测试全部通过。
- [ ] 构建通过。
- [ ] 手工验证全部通过。
- [ ] 设计文档的状态改为第一部分已实现。

**完成记录：** （待填）

## 5. 进度

| 步骤 | 状态 | 日期 | 提交 | 前端测试数 | 后端测试数 | 备注 |
|---|---|---|---|---|---|---|
| 基线 | — | 2026-10-09 | `cf83fc4` | 210 | 126 | |
| 1 | 完成 | 2026-10-09 | `f8e7ccd` | 236 | 126 | §3.3 第 2 条有一处例外待确认 |
| 2 | 完成 | 2026-10-09 | `e62cc57` | 238 | 126 | 用户已确认外观 |
| 3 | 未开始 | | | | | |
| 4 | 未开始 | | | | | |
| 5 | 未开始 | | | | | |
| 6 | 未开始 | | | | | |
| 7 | 未开始 | | | | | |
