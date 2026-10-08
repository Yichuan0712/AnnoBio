# 步骤间数据流：实施计划

状态：未开始。基于 `261006-pipeline-runs` / `ed4672f`（2026-10-07）。

本文把 [DATA_FLOW_DESIGN.md](DATA_FLOW_DESIGN.md)（下称“设计”）拆成 14 个可以独立执行的步骤（第 0–13 步）。每一步都写明要先读的代码、要改的文件和函数、要加的测试和验收标准，供不同的执行者（人或 LLM）在不了解前面讨论的情况下一步一步完成。

## 0. 执行规则

每一步都适用：

1. **一次只做一个步骤。** 开始前完整阅读设计全文、本文 §0–§2 和该步骤全文。不要提前做后面步骤的内容，也不要顺手重构无关代码。
2. **先检查前置条件。** 上一步在 §4 进度表中已标为完成；`git status` 干净；§1 的基线命令全部通过。任何一条不满足，就停下来告诉用户。
3. **遇到没覆盖的情况就停下来问。** 本文和设计都没写到的情况，或者发现文中描述的事实与代码不符（只是行号漂移除外），先问用户，不要自行决定。设计 §12 的待定项不要擅自定。
4. **行号只用来定位。** 以函数名为准，行号会随修改漂移。
5. **风格。** 代码、注释、标识符用英文，跟随周围代码的写法和注释密度；文档用中文。
6. **测试。**
   - 每步都要新增或更新测试。
   - LLM 调用一律用 mock，不调用付费模型。
   - 不要为了让测试通过而删除或放宽测试；只有本步骤明确要求删除的测试才能删。
   - 本仓库没有 DOM 测试环境：`workflowCanvas.js` 和各窗口没有自动测试。所以要把逻辑放进纯函数模块再测，界面部分靠手工验证。
7. **Agent 与用户能力一致。** 用户能做的 Agent 能做，反之亦然。第 13 步之前只对 Agent 做各步写明的“最低适配”，保证它不会写出旧格式，也不会出错。
8. **内容锁定规则不变。** 产出过结果的 Prompt 和 Dataset 只读（`contentLocks.js`），Process 代码始终可改。
9. **提交。**
   - 每步至少一个提交，提交信息用英文，格式 `feat(data-flow): step N - <摘要>`（纯重构用 `refactor(data-flow): ...`）。
   - 不要添加 `Co-Authored-By` 之类的 AI 署名行。
   - 不要 push，除非用户要求。
10. **完成后要登记。**
    - 在 §4 进度表中填写日期、提交哈希和测试数量。
    - 在该步骤末尾的“完成记录”中写下与计划不同的地方和遗留问题。
    - 如果改动了设计，同时更新设计文档。
11. **发布边界。** 第 0–7 步每步完成后都可以发布。第 8–12 步的中间状态不能发布，必须全部完成后一起发布。第 13 步可以单独发布。

## 1. 基线与常用命令

以下命令都在仓库根目录、Git Bash 中执行。基线于 `ed4672f` 实测：前端 146 项、后端 93 项全部通过，构建通过。

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

# 单独启动后端
cd backend && .venv/Scripts/python.exe -X utf8 -m uvicorn main:app --port 8000
```

PowerShell 中跑后端全部测试：

```powershell
backend/.venv/Scripts/python.exe -m unittest (Get-ChildItem backend/test_*.py | ForEach-Object { "backend." + $_.BaseName })
```

**用程序驱动桌面应用做手工验证（第 0 步实测可用）：**

- 启动：`cd app && tail -f /dev/null | npx electron-forge start --inspect-electron -- --remote-debugging-port=9333`，放在后台运行。前面的 `tail -f /dev/null` 不能省：Forge 读到标准输入结束就会退出，并把应用一起关掉。
- 渲染进程的调试端口是 9333，主进程的 Node 调试端口是 9229。各自 `GET http://127.0.0.1:<端口>/json/list` 取得 WebSocket 地址，用 `Runtime.evaluate`（`awaitPromise: true`、`returnByValue: true`、`includeCommandLineAPI: true`）执行代码，用 `Page.captureScreenshot` 截图。Node 自带 `WebSocket`，写一个几十行的小脚本即可，不需要安装 Playwright。
- 打开或新建项目时绕过系统对话框：先在主进程执行 `require('electron').dialog.showOpenDialog = async () => ({ canceled: false, filePaths: ['<路径>'] })`（新建项目替换 `showSaveDialog`，返回 `{ canceled: false, filePath }`），再在渲染进程点击 `[data-action="open-project"]` 或 `[data-action="new-project"]`。路径用正斜杠。
- 应用窗口被其他窗口挡住时，页面处于隐藏状态，Chromium 会大幅限制定时器，脚本里的每次等待都会被拉长到几十秒甚至一分钟。驱动之前先在主进程执行 `require('electron').BrowserWindow.getAllWindows().forEach((w) => w.webContents.setBackgroundThrottling(false))`。
- 节点状态可以直接读 DOM，例如 `.workflow-node--run` 的 `dataset.runCompleted`、`.workflow-node--process` 的 `dataset.processDfResults`、`dataset.historyRecordId`。报错会出现在底部的 Errors 页签。
- 结束后关闭 Electron、Forge，以及它启动的后端进程（命令行含 `uvicorn main:app --port 8000`）。

说明：

- 前端测试用 Node 自带的测试工具（`node:test`），测试对象是纯函数和普通的 `{nodes, connections}` 画布状态。`app/tests/pipelineSelectionBridge.mjs` 和 `historyStorageBenchmark.mjs` 不是测试，不要改名成 `.test.mjs`。
- 后端测试用 `unittest`。`unittest discover` 在本仓库不能用；后端没有 pytest。
- 不要把构建输出到 `app/dist`，那里是发布用的构建。
- 手工验证用示例项目 `examples/Kinase–Substrate Evidence Curation.yc`（12 个 Dataset，其中 1 个是源数据）和 `examples/Kinase–Substrate Evidence Curation - repaired - Copy.yc`（34 个 Dataset，其中 22 个是 Pipeline 副本）。不要修改这两个文件，验证时用 Save As 另存一份。

## 2. 代码地图

执行前先读这一节，可以省去大部分代码探索。

### 2.1 画布与存档

- **画布状态存在 DOM 上。** 节点状态是 `node.dataset.*` 属性；连线是 `workflowCanvas.js` 模块级的 `connections` 数组；Dataset 内容在 `datasetContentByNodeId` 中。
- **序列化与恢复。** `getCanvasState()`（`workflowCanvas.js` 约 4604–4828）序列化画布，返回 `{version: 2, historyVersion, pipelineOwner, zoomLevel, nodes, connections}`；`loadCanvasState(state)`（约 4830–5084）恢复画布。
- **`loadCanvasState` 会丢掉连线上的额外字段。** 它把每条连线重建成只有 `{fromId, toId, type}` 的对象（约 5063）。第 6 步给连线加字段时必须改这里。
- **所有打开项目的路径都经过 `renderer.js` 的 `loadCanvasWithHistory(projectId, savedState)`（约 146–167）。** 包括新建、打开桌面文件、另存、合并、打开网页项目。读档转换放在构造 `state` 之后、调用 `historySession.open` 之前。
- **其他调用 `loadCanvasState` 的地方传入的已经是当前格式：** 撤销（`undoHistory.js` 约 128）、Agent 修改后的画布（`applyAgentCanvasState`，`workflowCanvas.js` 约 5468）。
- **合并项目时不会改写节点 ID。** 桌面 `projectAssets.js` 的 merge 和网页 `backend/project_store.py` 的 `merge_project` 都只是把两份 nodes/connections 拼起来，所以合并后的画布可能新旧格式混在一起。因此读档转换必须按“字段是否存在”执行，不能只看 `version`，而且要能重复执行。
- **撤销快照。** `undoHistory.js` 的 `VOLATILE_FIELDS_BY_TYPE`（约 23–28）列出不进撤销快照的结果字段。连线整条进快照，所以新加的连线字段可以撤销。
- **连线类型常量**在 `workflowCanvas.js` 约 124–150 行。很多模块直接写字符串（`pipelineDetection.js`、`pipelineExportDefinition.js`、`datasetHistorySource.js`、`runHistorySelection.js`、`changeSet.js`、`workflowNodeFactories.js`、`workflowDependencyColors.js`、`pipelineInputAvailability.js`、`runHistoryPresentation.js`），改类型时要全仓库搜索。
- **连线绘制。** `collectNodeBoxes`（约 2266）、`getEdgeGeometry`（约 2312）、`liveHistoryOutputIds`（约 2361）、`renderEdge`（约 2412）、`getDerivedDataFlowEdges`（约 2501）、`updateEdges`（约 2572）。每条线都从起点节点右边的垂直中点出发（`renderEdge` 约 2417–2430）。
- **删除节点。** `getWorkflowNodeDeleteBlockReason`（约 1911）规定：有出边的节点不能删，被 Run 或 Score 选中的 Dataset 也不能删。删除流程是 `handleWorkflowNodeDeleteClick`（约 1926）→ `deleteSelectedNodes`（约 1992）。

### 2.2 Run 和 Process 的输入（第 3–7 步会改）

- **Run 的输入**是字段 `runWorkingSetId`。画布上的 `dataset-to-run` 线是绘制时临时推出来的，从不存进 `connections`。
- **Process 的输入：**
  - 存储有三部分：`dataset-to-process` 连线、主输入字段 `primaryDatasetId`（DOM 上是 `processPrimaryDatasetId`）、别名字段 `datasetAliases`（DOM 上是 `processDatasetAliases`，存 `{节点 ID: 别名}` 的 JSON）。
  - 其他输入不是单独存的列表，而是由代码决定。`processDatasetBindings.js` 的 `processDatasetInputs` 列出所有 Dataset 和各自的别名。勾选输入时，`codeDeclaringInputs` 改写 `process()` 的参数；之后 `workflowNodeFactories.js` 的 `syncProcessDependencies`（约 708）根据代码引用的别名重建连线。它在窗口里改选项、点 Run（`processDetailModal.js` 约 372）和关窗口（约 420）时都会调用。
- **“主输入 = `primaryDatasetId`，没有就取第一条输入连线”这条规则重复写了 8 处：**
  - `workflowCanvas.js` 的 `getProcessDatasets`（约 1281）
  - `workflowNodeFactories.js` 的 `getProcessDatasets`（约 670）
  - `runHistoryCapture.js` 约 68
  - `runHistoryResolver.js` 约 158
  - `runHistoryMigration.js` 约 189
  - `changeSet.js` 的 update（约 695）
  - `workflowNodeInspector.js` 约 249
  - `backend/pipeline_compile.py` 约 236（更严格：只有一条输入时才推断主输入）

  其中两份 `getProcessDatasets` 还会把推断出的主输入写回 `processPrimaryDatasetId`。第 0 步删除 `runHistoryMigration.js` 后剩 7 处。
- **“必需输入 = 主输入 + 已连接 + 代码引用的别名”这条规则重复写了 4 处：** `workflowCanvas.js` 的 `runProcessNode`（约 5514–5523）、`runHistoryCapture.js`、`runHistoryResolver.js`、`runHistoryMigration.js`。第 0 步之后剩 3 处。
- **Run 的输入表**（也就是 `datasetContentByNodeId.get(runWorkingSetId)`）在约 15 处被读取：
  - `workflowCanvas.js`：`buildReviewComparisonRows`（约 405）、`buildReviewComparisonRowsFromCodeMatch`（约 797）、`runRawToFakeRunNode`（约 955）、`resolveLiveScoreComparisonContext`（约 986），以及右键菜单的 `score-add-review`（约 3432、3457）和 `score-save-to-workspace`（约 3627、3652）
  - `workflowCanvasRuntime.js`：`startRunNode`（约 523–544）、`saveRunResultsToWorkspace`（约 840）、`saveScoreResultsToWorkspace`（约 936、967）、`getScoreUpstreamHeaders`（约 1148）、`buildReviewVerificationPayload`（约 1819）
  - `workflowNodeFactories.js`：`createScoreNode`（约 825、858）、`createPromptReviewNode`（约 1051、1070）
  - `changeSet.js`：`scoreBundle`（约 291）、`save_run_results`（约 782）
  - `agent/execution/runJobs.js`：约 84、127
- **单节点运行：**
  - Run 由 `workflowCanvasRuntime.js` 的 `startRunNode`（约 486）执行，调用方是 Run 窗口（`runDetailModal.js` 约 897）和 Agent（`runJobs.js` 约 288）。
  - Process 由 `workflowCanvas.js` 的 `runProcessNode`（约 5501）执行，调用方是 Process 窗口（`processDetailModal.js` 约 377）和 Agent（`runJobs.js` 约 327）。
  - 两者都先对齐 History（`reconcileRunHistory` 约 5283 / `reconcileHistory`），再读输入。
- **窗口：**
  - Run 窗口 `runDetailModal.js` 的 `openRunDetailModal`（约 97）：Prompt 选择用 `nodePicker.js`；Dataset 选择是手写的下拉框，由 `populateDropdown`（约 713）、`selectWorkingSet`（约 698）、`updateRunNodeBorder`（约 674，在这里写 `runWorkingSetId`）组成；候选项来自 `workflowNodeFactories.js` `createRunNode` 中的 `getWorkingSets`（约 538）。
  - Process 窗口：`processDetailModal.js` 的 `openProcessDetailModal`（约 114），输入选择器在 `processInputPicker.js` 的 `bindProcessInputPicker`（约 43）。
- **新建节点时预填输入：**
  - `newProcessNode({datasetNode, open})`（`workflowCanvas.js` 约 4358）
  - `newRunNode({promptNode, open})`（约 4377，目前不能预填 Dataset）
  - 事件 `workflow:add-process-node` / `workflow:add-run-node`（约 4394–4401）

### 2.3 Dataset 的产出关系（第 11–12 步会删）

- **字段：** `sourceRunNodeId`、`processOutputName`、`savedCopy`、`snapshotSourceRecordId`、`pipelineRunId`、`pipelineLogicalId`、`resultMissing`。
- **连线：** `process-to-dataset`、`process-to-dataset-snapshot`、`run-to-dataset-snapshot` 存在 `connections` 中；`run-to-dataset` 只在绘制时推出来。
- **生成 Dataset 的入口：**
  - Run 的 Save results：
    - 右键菜单 `save-results-to-workspace`（`workflowCanvas.js` 约 3355）：只传位置，生成的表没有输入列，也不记录来源。
    - Run 窗口（`runDetailModal.js` 约 626–651）：传 `runNodeId`，记录来源。
    - `workflowCanvasRuntime.js` 的 `saveRunResultsToWorkspace`（约 793）：没有调用方。
  - Process 的 Create dataset：右键菜单 `process-save-to-workspace`（约 3749）和窗口里的 `createBranchDatasets`（`processDetailModal.js` 约 306）。
  - Score 的 Save results：右键菜单（约 3611）、`scoreDetailModal.js`（约 3458，经事件 `workflow:score-export-to-workspace`，约 4235）、`saveScoreResultsToWorkspace`（约 891，没有调用方）。三处都不记录来源。
  - Sampler 的 Create sample：`samplerNodeId` 加 `sampler-to-dataset` 连线。本计划不改。
  - 以上入口最后都经过事件 `workflow:add-dataset-node` 的处理函数（`workflowCanvas.js` 约 4246–4341）→ `addDatasetNode`（`workflowCanvasRuntime.js` 约 2006）→ `createDatasetNode`（`workflowNodeFactories.js` 约 367）。
- **Run Pipeline 结束后：**
  - 前端 `pipelineOverviewModal.js` 的 `publishCompletedRun`（约 365）调用 `workflowCanvas.js` 的 `publishPipelineRun`（约 5711–5866）。
  - 后者为每个产物建 Dataset 副本，把下游改连到副本，再调用 `pipelineHistoryImport.js` 的 `importPipelineRunHistory` 导入节点 History。
- **已有字段 `nodeOrigin`** 标记 Agent 创建的节点，与本计划无关。新字段因此叫 `savedFrom`，不叫 `origin`。

### 2.4 History

`runHistoryResolver.js`、`runHistoryCapture.js`、`runHistorySelection.js`、`runHistoryPresentation.js`、`runHistorySignature.js`、`runHistoryDeletion.js`、`runHistorySession.js`、`runAnalysisHistory.js`、`datasetHistorySource.js`、`contentLocks.js`，以及第 0 步删除的 `runHistoryMigration.js`。设计 §2.2、§4 讲了其中哪些逻辑是为中间 Dataset 存在的。

**签名兼容是硬约束：** `runInputSignature` 和 `processInputSignature` 的输入在只涉及 Dataset 时必须与现在完全相同，否则旧项目的结果会全部变成“没有结果”。

### 2.5 Pipeline

- **前端流程：** `pipelineDetection.js` 的 `detectPipelines` → `pipelineRouteSelection.js` 的 `buildSelectedRoute` / `exportRoutePayload` → `pipelineOverviewModal.js`（Run Pipeline 在约 619–705）→ `pipelineRunDialog.js` / `pipelineRunInputs.js` / `pipelineInputAvailability.js` → `pipelineRunDefinition.js` / `pipelineExportDefinition.js` → `pipelineRunClient.js`。
- **后端：**
  - `backend/pipeline_compile.py` 的 `_Compiler`：`add_dataset`（约 216）、`add_process`（约 232）、`add_llm`（约 285）、`link_producers`（约 362–422）、`order_jobs`（约 424）。job ID 是 `llm:<Run 节点>` 和 `process:<Process 节点>`；没有输出 Dataset 的 job 得到 `output:<job>:result` 产物（约 412–422）。
  - `pipeline_runner.py` 的 `_input_tables`（约 286）假定每个入口都是 `dataset:<节点>`。
  - 导出代码：`pipeline_export_spec.py` 和 `pipeline_export_dag.py` 按产物名称生成输出表名。
- **界面：** 每个 Pipeline 卡片有一个只读的 Run History 窗口。没有 “Pipeline Runs 页签”，也没有删除运行的入口；PIPELINE_EXECUTION_PLAN 中的相关描述已过时。

### 2.6 Agent

- `app/src/agent/operations/changeSet.js`：`add_run`、`add_process`（`wireProcess`）、`update`、`save_run_results`、`save_process_output`、`remove`
- `app/src/agent/canvas/workflowNodeInspector.js`、`app/src/agent/context/workspaceSummary.js`
- `app/src/agent/execution/runJobs.js`
- `app/src/agent/tools/agentTools.js`（含 `tryProcess`）
- `app/src/agent/pipeline/pipelineActions.js`
- 后端文字说明：`backend/agent/system_prompt.py`、`backend/agent/guides/pipeline-building.md`、`process-code.md`

### 2.7 已知的现有问题（相关步骤顺带处理）

- 右键菜单和 Run 窗口的 Save results 结果不同（第 11 步统一）。
- Score 保存的 Dataset 不记录来源（第 11 步）。
- UI 删除 Run 后，Dataset 上的 `sourceRunNodeId` 指向不存在的节点（第 11 步字段删除后自然消失）。
- Agent 的 `remove` 会留下过期的 `datasetAliases` 条目（第 6 步别名移到连线上后自然消失）。
- `workflowCanvasRuntime.js` 的 `addRunNode`、`addProcessNode`、`saveRunResultsToWorkspace`、`saveScoreResultsToWorkspace`、`addSampledDatasetNode` 没有调用方。相关步骤中，要么改造成唯一实现，要么删除。
- `workflowDependencyColors.js` 约 14 行会查一条存储的 `dataset-to-run` 连线，但这种连线从不存储（第 3 步改用访问层）。

## 3. 步骤

### 步骤 0：删除旧格式的 History 迁移代码

**目标：** 落实设计“已定的前提”第 2 条和 §9 最后一条，删掉 `runHistoryMigration.js` 和 ``grep -rn "runHistoryMigration|planLegacyHistoryMigration|withCompatibleLegacyCanvas|hasLegacyOutput" app/src app/tests``。放在最前面做，后面的步骤就不用再改这个文件。

**前置：** 无，这是第一步。

**先读：** 设计 §9；`runHistorySession.js` 全文，重点是 `open`（约 56–114）；`runHistoryMigration.js`（了解它做了什么）；`pipelineHistoryImport.js` 的 ``grep -rn "runHistoryMigration|planLegacyHistoryMigration|withCompatibleLegacyCanvas|hasLegacyOutput" app/src app/tests``，以及它在 `workflowCanvas.js` 中的调用（`publishPipelineRun` 约 5715）；`app/tests/runHistoryMigration.test.mjs`、`app/tests/pipelineHistoryImport.test.mjs`。

**注意：** ``grep -rn "runHistoryMigration|planLegacyHistoryMigration|withCompatibleLegacyCanvas|hasLegacyOutput" app/src app/tests`` 现在只被 `RunHistorySession.open` 调用，但承担三种用途，删除后各有去向：

| 用途 | 现在 | 删除后 |
|---|---|---|
| 新建的空项目，以及从未启用 History 的项目（`historyVersion !== 1`） | 写入 `historyVersion: 1`，并把节点上的结果转成记录 | 直接把画布标记为 `historyVersion: 1` 并保存，不创建记录 |
| 已启用 History 的项目中，有结果但没有记录的节点（`hasLegacyOutput`，例如合并进来的老项目节点） | 补建记录 | 不处理。resolver 找不到记录时会清空这些节点的结果，显示“没有结果” |
| 首次迁移时归档旧的 Score/Review 缓存（`saveAnalysis` 循环） | 归档 | 删除 |

**改动：**

1. `runHistorySession.js` 的 `open`：
   - 删除对 ``grep -rn "runHistoryMigration|planLegacyHistoryMigration|withCompatibleLegacyCanvas|hasLegacyOutput" app/src app/tests`` 的 import 和调用、`hasLegacyOutput`、Score/Review 归档循环。
   - `state.historyVersion !== 1` 时，令 `canvas = { ...state, historyVersion: 1 }` 并调用 `this.storage.saveCanvas(projectId, canvas)`。
   - 返回 `await this.resolve(canvas)`。返回值中的 `migration` 字段删除；`renderer.js` 只用到 `opened.state`（约 155），改完后用 grep 确认没有别处读 `migration`。
2. 删除 `app/src/runHistoryMigration.js`。
3. `pipelineHistoryImport.js`：删除 ``grep -rn "runHistoryMigration|planLegacyHistoryMigration|withCompatibleLegacyCanvas|hasLegacyOutput" app/src app/tests``。`publishPipelineRun` 中改为直接使用 `definition`。没有 `canvas_state` 的旧运行，会在 `importPipelineRunHistory` 中抛出现有的错误 `This Pipeline run has no frozen node definition for History import.`，由 `publishPipelineRun` 现有的 catch 变成 `historyError`。
4. 测试：`app/tests/runHistoryMigration.test.mjs` 的 22 个测试中，约一半测的是 resolver、selection、capture，只是借迁移函数准备数据。这些要改写后保留，不能随文件一起删。下表按测试名初步分类，执行时以测试内容为准：

   | 处理 | 测试名 |
   |---|---|
   | 删除（只测迁移本身） | `legacy Run and Process results migrate through matching derived Datasets`、`legacy Process object cells match their saved text export`、`mismatched legacy exports keep their content and visual pipeline links without live provenance`、`missing upstream result detaches old export without inventing history`、`legacy partial Run migrates as stopped with its saved rows`、`unmigratable upstream Run leaves its export as an ordinary Dataset`、`legacy migration resumes safely after records were saved but canvas save failed`、`first open archives legacy Score and Review caches under their input signatures` |
   | 移到 `app/tests/runHistoryResolver.test.mjs` | `stopped Run and Process records restore an explicit Resume state`、`a completed zero-row Run and its empty Process output remain live history results`、`current input signatures restore matching results and clear downstream after input changes`、`a completed Run with zero rows produces a valid empty Dataset`、`matching index entry with a missing record fails instead of adopting stale canvas results` |
   | 移到 `app/tests/runHistorySelection.test.mjs` | `selecting a downstream record restores its ancestor inputs together`、`selecting Pipeline history switches its upstream, outputs, and downstream to one lineage`、`selecting a multi-input Process history switches every upstream input lineage`、`history selection rejects conflicting shared Dataset requirements atomically`、`history selection blocks a running affected descendant`、`completed inputs create a new attempt and History can select either identical-input result` |
   | 移到 `app/tests/runHistoryCapture.test.mjs` | `new execution captures current upstream record IDs and a frozen input snapshot`、`capture blocks a Process whose derived input has no current result` |
   | 改写成新行为 | `opening a merged old canvas migrates only its unrecorded result nodes` → 有结果但没有记录的节点，打开后显示“没有结果” |

   - 移走的测试原来用 ``grep -rn "runHistoryMigration|planLegacyHistoryMigration|withCompatibleLegacyCanvas|hasLegacyOutput" app/src app/tests`` 准备记录，改为在测试中直接构造记录对象（或用 `captureHistoryInput`）。断言保持不变。
   - 为 `open` 补测试，内存存储的写法参照 `runHistoryStorage.test.mjs`：
     - 没有 `historyVersion` 的项目：保存的画布带上 `historyVersion: 1`，不创建记录，带缓存结果的节点显示“没有结果”。
     - 新建的空项目：同样标记，不报错。
   - `pipelineHistoryImport.test.mjs`：删除 ``grep -rn "runHistoryMigration|planLegacyHistoryMigration|withCompatibleLegacyCanvas|hasLegacyOutput" app/src app/tests`` 的用例；新增一个用例，没有 `canvas_state` 的定义会抛出上述错误。

**手工验证：**

- [ ] 新建项目，加一个 Dataset 和一个 Run，跑完后 History 中有记录，保存后重新打开结果仍在。
- [ ] 模拟老项目：把一个示例项目另存一份，用文本编辑器删掉画布的 `historyVersion` 和文件中的 `history` 字段。打开后不报错，节点显示“没有结果”，可以重新运行。
- [ ] 正常的示例项目打开后，结果仍在。

**发布说明要点：** 从未启用 History 的老项目打开后，原有结果不再显示，需要重新运行。

**验收：**

- [ ] 前后端测试全部通过。前端测试数会变：删掉 8 个，新增若干，记入 §4。
- [ ] 构建通过。
- [ ] `grep -rnE "runHistoryMigration|planLegacyHistoryMigration|withCompatibleLegacyCanvas|hasLegacyOutput" app/src app/tests` 没有结果。

**完成记录：** 2026-10-07 完成，验收各项全部通过。

- 与计划不同的地方：
  - `app/tests/datasetHistorySource.test.mjs` 也用迁移函数准备数据，计划里没有列出。已改用共享的辅助函数，并删除其中只测迁移的一个用例（`migrating a merged canvas leaves a saved copy and its link alone`）。
  - 被搬走的测试共用一个新的辅助模块 `app/tests/historyGraphFixture.mjs`，里面有测试图和 `recordGraph`：它用 `captureHistoryInput` 按节点上已有的结果生成已完成的记录，签名与真实运行一致。
  - `open` 的测试和改写后的“合并老项目”用例放在新文件 `app/tests/runHistorySession.test.mjs`。
- 测试：前端 146 → 140（删除 10 个只测旧迁移的用例，新增 4 个 `open` 用例和 1 个 Pipeline 导入用例）；后端 93 项不变。
- 手工验证：按 §1 的方法驱动桌面应用完成。
  - Kinase 示例副本：4 个 Run、5 个 Process 的结果都在，9 个节点对上 History 记录。
  - 模拟的老项目：打开没有报错，节点都显示“没有结果”，保存后带上 `historyVersion: 1`，没有生成记录。
  - 新项目：正常，保存后带上 `historyVersion: 1`。
  - 重新运行一个 Process：新增一条 History 记录（9 → 10）。
- 发现的已有问题（与本计划无关，未处理）：Process 窗口中点 “Run again” 后，如果上一条记录没有结果行，结果区不会刷新，仍显示 “No rows returned”，关掉窗口再打开才显示新结果。

---

### 步骤 1：后端识别 Process 输出分支

**目标：** 实现设计 §3.4 的识别逻辑和接口。本步骤没有界面变化。

**前置：** 步骤 0。

**先读：** 设计 §3.4；`backend/process_df_exec.py`（运行时如何处理字典返回值和分支名）；`backend/test_process_df_exec.py`（测试写法）；`backend/main.py` 约 2940–3090（Process df 接口的写法）。

**改动：**

1. 新建 `backend/process_outputs.py`，提供 `detect_process_outputs(code: str) -> dict`：
   - 返回值三种：
     - `{"ok": True, "ports": [...], "dynamic": False}`
     - `{"ok": True, "ports": [], "dynamic": True}`
     - `{"ok": False, "error": "<说明>"}`
   - 用 `ast.parse` 解析。语法错误返回 `error`，内容含错误信息和行号。
   - 找顶层的 `def process` 或 `async def process`；有多个时取最后一个，与 Python 运行时一致。没有则返回 `error`：`No top-level process() function`。
   - 收集这个函数体里的 `Return` 语句。遍历时不进入嵌套的 `FunctionDef`、`AsyncFunctionDef`、`Lambda`、`ClassDef`。
   - 对每个 return 的值分类：
     - `ast.Dict`，并且每个键都是字符串常量：类型为“字典”，带键列表。键为 `None` 表示 `**` 展开，归为“动态”。
     - `ast.DictComp`：动态。
     - `ast.IfExp`：分别对两边分类再合并。
     - 其他（包括 `return` 不带值、变量名、函数调用）：单一输出。
   - 合并所有 return：
     - 全部是单一输出：`ports = ["result"]`。
     - 全部是字典：取键的并集，按首次出现的顺序，去掉首尾空白、去重。若有空键，返回 `error`：`Process branch names must be non-empty strings`，与 `process_df_exec.py` 的运行时报错一致。
     - 单一输出和字典混用，或者出现任何“动态”：`dynamic = True`。
     - 没有任何 return：`ports = ["result"]`（运行时会报错，这里不处理）。
   - 只做静态解析，不执行代码，不 import 用户的模块。
2. `backend/main.py`：在 `start_process_df_run` 附近新增：
   - 请求模型 `ProcessOutputsRequest(BaseModel)`，字段 `code: str`。
   - 接口 `@app.post("/api/process/outputs")`，函数名 `detect_process_outputs_endpoint(req)`，同步返回 `detect_process_outputs(req.code)`。在函数内 import，跟随 main.py 中其他辅助模块的写法。
3. `app/src/processRunClient.js`：新增 `export async function detectProcessOutputs(code)`，POST `${BACKEND_API_BASE}/api/process/outputs`，返回解析后的 JSON。HTTP 错误时抛出异常，异常信息里带状态码。

**测试：**

- 新建 `backend/test_process_outputs.py`（`unittest`，用 `from backend.process_outputs import detect_process_outputs`），至少覆盖：
  - 返回单个 DataFrame
  - 返回两个键的字典
  - 多个 return 时键的并集与顺序
  - 嵌套辅助函数里的 return 被忽略
  - 字典与 DataFrame 混用 → 动态
  - 字典推导式 → 动态
  - `**` 展开 → 动态
  - 键不是常量 → 动态
  - `IfExp` 两边都是字典 → 取并集
  - 键的首尾空白被去掉
  - 空键 → error
  - 语法错误 → error，且含行号
  - 没有 `process` → error
  - 两个顶层 `process` 时取后一个
  - `async def process`
- 两个用例模仿示例项目中的真实写法，期望值见设计 §3.4 的表格：
  - Check UniProt availability 的结尾是 `return {"ready_for_uniprot_matching": ..., "needs_name_rewrite": ...}`，前面有一个返回列表的辅助函数。
  - Resolve chosen accessions 的结尾返回两个分支，前面有两个返回字符串的辅助函数。
- 接口测试：参照 `backend/test_pipeline_runner_api.py` 直接调用 main 中函数的方式，调用 `main.detect_process_outputs_endpoint(main.ProcessOutputsRequest(code=...))`，确认返回值。

**不做：** 前端不调用这个接口（第 2 步）；不改编译器（第 9 步）。

**验收：**

- [ ] 后端全部测试通过（基线 + 新增）。
- [ ] 前端测试数量不变，全部通过。
- [ ] 构建通过。

**完成记录：** 2026-10-07 完成，验收各项全部通过。

- 与计划不同的地方：
  - 接口测试单独放在 `backend/test_process_outputs_api.py`。它要 import `main`（依赖 FastAPI），只能用 `backend/.venv` 跑；`test_process_outputs.py` 只用标准库，全局 Python 也能跑。
  - 补充了两条计划没写的规则：键是非字符串常量（如 `1`）时报与空键相同的错误，与运行时一致；`code` 缺省时按空字符串处理。
- 测试：后端 93 → 116（新增 20 个识别用例、3 个接口用例）；前端 140 项不变。
- 额外核对：示例项目中 7 个真实 Process 的识别结果与设计 §3.4 的表格一致；单独启动后端用 HTTP 请求 `/api/process/outputs` 也返回正确结果。

---

### 步骤 2：Process 节点记录并显示输出分支

**目标：** 实现设计 §3.4 中“结果记在节点上”和 §5.1 第一条（只读的分支标签）。连线起点暂不改。

**前置：** 步骤 1。

**先读：** 设计 §3.4、§5.1；`workflowNodeFactories.js` 的 `createProcessNode`（约 612–739）；`workflowCanvas.css` 中 Process 节点的样式（约 365–410）；`workflowCanvas.js` 的 `runProcessNode`（约 5501）、`getCanvasState` 的 Process 部分（约 4654–4677）和 `loadCanvasState` 的 Process 部分（约 4884–4904）。

**数据：**

- 画布状态中 Process 节点新增字段 `processOutputPorts`：`{ "ports": [...], "dynamic": false, "error": "", "codeHash": "sha256:..." }`。DOM 上存为 `node.dataset.processOutputPorts`，值是 JSON 字符串。
- 这个字段不加入 `undoHistory.js` 的 `VOLATILE_FIELDS_BY_TYPE`。它由代码决定，应随代码一起撤销。

**改动：**

1. 新建纯模块 `app/src/processOutputPorts.js`：
   - `parseProcessOutputPorts(value)`：容错解析，接受对象或 JSON 字符串，无效时返回 `null`。
   - `async codeHashOf(code)`：用 `runHistorySignature.js` 的 `sha256Signature({ code: String(code || '') })`。
   - `effectiveProcessOutputs({ detected, dfResults })` → `{ ports, dynamic, mismatch, source }`：
     - 有当前结果时，即 `dfResults.outputs` 非空，或是旧格式的单表 `{headers, rows}`：`ports` 取实际分支（单表为 `['result']`），`source` 为 `'run'`。若 `detected` 有效、不是动态、且分支集合与实际不同，`mismatch` 为 `true`。
     - 没有结果但有有效的识别结果：用识别结果，`source` 为 `'code'`。
     - 识别结果是 error、或没有识别结果：`ports` 为 `[]`，`dynamic` 为 `false`，`source` 为 `'none'`。
2. `workflowCanvas.js`：
   - `getCanvasState` 序列化 `processOutputPorts`；`loadCanvasState` 把它传给 `createProcessNode`，再写到 DOM。
   - 新增 `syncProcessOutputPorts()`：
     - 遍历所有 Process 节点，计算代码哈希。哈希与 `processOutputPorts.codeHash` 不同时，调用 `detectProcessOutputs`，把结果连同新哈希写回 DOM，最后只 emit 一次 `workflow:canvas-changed`。
     - 同一节点同一时间只发一个请求。请求返回时如果代码又变了，丢弃这次结果。
     - 后端不可用时保留旧值，只 `console.warn`，不弹窗。
     - 哈希相同就不发请求，这样不会和 canvas-changed 形成循环。
   - 触发时机：监听 `workflow:canvas-changed`（去抖 500ms），项目加载完成后也调用一次。这样窗口保存代码、Agent 改代码、撤销、Duplicate、打开旧项目都能覆盖到。
3. 节点显示：
   - 在 `createProcessNode` 的节点 HTML 中，header 和 `.workflow-node__process-progress` 之间加 `<div class="workflow-node__process-outputs">`。按 `effectiveProcessOutputs` 的结果，每个分支一个标签：`<span class="workflow-node__process-port" data-port="<名字>">`。
     - 只有一个 `result` 时不显示。
     - 动态输出且没有运行结果时，显示一个 “dynamic outputs” 标签。
     - `mismatch` 时，标签加警告样式，`title` 写明 “Branches returned by the last run differ from the code”。
   - 有标签时去掉 `workflow-node--no-body` 类，没有时加回来。
   - 新增 `refreshProcessOutputStrip(node)`，在三种情况下调用：`processOutputPorts` 更新时；`processDfResults` 变化时，即读档（约 4896）、`runProcessNode` 写结果（约 5576）、History 对齐写结果（约 5413）；节点创建时。
   - 在 `workflowCanvas.css` 中加标签样式：小号字、换行排列，节点宽度不变。
4. 右键菜单的 `duplicate-process`（约 3719）会复制节点。确认副本带上 `processOutputPorts`，因为代码相同。

**测试：**

- 新建 `app/tests/processOutputPorts.test.mjs`，覆盖 `effectiveProcessOutputs` 的各种情况：只有识别结果；有运行结果时以结果为准；`mismatch`；旧格式单表；动态输出；识别结果是 error。另外覆盖 `parseProcessOutputPorts` 的容错。

**手工验证：**

- [ ] 打开 Kinase 示例的另存副本：Check UniProt availability 和 Resolve chosen accessions 各显示两个分支标签，其他 Process 不显示。
- [ ] 改代码给 return 加一个分支，保存后标签随之更新。
- [ ] 停掉后端再改代码：不弹错误，标签保持原样；后端恢复后，下一次画布变化时更新。
- [ ] 保存项目后，文件中的 Process 节点有 `processOutputPorts`。

**Agent：** 无需改动。`inspect_node` 显示分支放到第 13 步。

**验收：**

- [ ] 前后端测试全部通过。
- [ ] 构建通过。
- [ ] 手工验证全部通过。

**完成记录：** 2026-10-07 完成，验收各项全部通过。

- 与计划不同的地方：
  - **`processOutputPorts` 加入了撤销的易变字段**，计划写的是不加。识别结果是在代码改动后异步写回的；如果进撤销快照，每次识别都会多出一个撤销步骤。撤销代码后，代码哈希对不上会自动重新识别，结果仍然正确。
  - **保存识别结果时不发 `workflow:canvas-changed`**，计划写的是发一次，只重绘连线。手工验证中发现：发这个事件会把 History 同步在后台静默写入的内容（派生 Dataset 标为“没有结果”）打包成一个额外的撤销步骤，撤销改代码要按两次，还会清掉重做。不发事件后，识别结果在下一次画布变化时随自动保存写入文件；打开项目时缺少或过期的识别会重新请求。
  - **“有运行结果时以结果为准”的规则细化了**，已同步改到设计 §3.4。实际分支都在识别结果里时，仍提供识别出的全部分支，因为一次运行只返回代码中某一个字典。只有运行返回了识别不到的分支时，才以结果为准并提示不一致。
  - **只返回一个命名分支（如 `{"kept": df}`）时也显示标签**，因为下游要按这个名字连接。只有单一输出 `result` 时才不显示。
  - 显示标签的 `refreshProcessOutputStrip` 放在 `workflowNodeFactories.js` 中导出，画布和节点工厂共用。
- 测试：前端 140 → 149（新增 `processOutputPorts.test.mjs` 9 项）；后端 116 项不变。
- 手工验证（按 §1 的方法驱动桌面应用）：
  - Kinase 示例：两个多分支 Process 显示各自的分支，其他三个不显示。
  - 改 Tidy 的代码返回两个分支：3 秒内标签更新；撤销一次即恢复代码，标签消失；重做后恢复。
  - 停掉后端再改代码：没有弹窗，标签不变，只在控制台警告；后端恢复后，下一次画布变化时更新。
  - 保存的文件中 5 个 Process 都带有正确的 `processOutputPorts`。
  - 对照实验：改动前的代码，撤销同样只需一次；上面第二条偏差就是这次对照发现的。

---

### 步骤 3：Run 输入访问层（纯重构）

**目标：** 所有读写 Run 输入的代码都改为经过一个模块，为第 6 步切换存储做准备。完成后行为与之前完全相同。

**前置：** 步骤 2（与步骤 1、2 没有代码依赖，但要按顺序执行）。

**先读：** §2.2；设计 §3.3。

**改动：**

1. 新建纯模块 `app/src/stepInputs.js`（只处理普通画布状态 `{nodes, connections}`，不碰 DOM）。本步骤先放 Run 相关的部分：
   - 来源对象统一写成 `{ nodeId: string, port: string }`。本步骤中 `port` 恒为 `'result'`。
   - `sourceKey(source)`：Dataset 来源返回 `nodeId`。本步骤只有 Dataset 来源，Run/Process 来源的 `节点 ID:端口` 形式到第 7 步才用到。
   - `runInputSource(state, runId)` → 来源或 `null`。本步骤读 `runWorkingSetId`。
   - `setRunInputSource(state, runId, source | null)`：原地修改 `state`。
   - `runInputTable(state, runId)` → 输入 Dataset 的内容（`datasetContent`，Sampler 子集用 `subsetContent`），或 `null`。与现在的读法完全一致。
   - `runInputEdges(state)` → `[{ fromId, fromPort, toId }]`，供绘图、Pipeline 检测和颜色使用。
2. `workflowCanvas.js` 中新增 DOM 适配函数，放在 `getProcessDatasets` 附近：
   - `readRunInputSource(runNode)`、`writeRunInputSource(runNode, source)`、`readRunInputTable(runNode)`。
   - 实现方式：从 DOM 构造只含所需字段的最小状态，再调用 `stepInputs.js`；写入时把结果写回 DOM 属性。不要在这些函数里调用完整的 `getCanvasState()`，它会克隆所有数据。
   - 通过现有的 deps 对象把这些函数传给 `workflowNodeFactories.js` 和 `workflowCanvasRuntime.js`。
3. 把 §2.2 “Run 的输入表”列出的约 15 处，以及下面这些读写 `runWorkingSetId` 的地方，改成调用访问层：
   - `runDetailModal.js`：`selectedNodeId` 的初值和 `updateRunNodeBorder` 的写入。
   - `workflowNodeFactories.js`：`createRunNode` 中的 `getWorkingSets` / `getSubsetContent`。
   - `workflowCanvas.js`：`isDatasetPickedByRunOrScore`（约 1898）、`getWorkflowNodeDeleteBlockReasonForBatch`（约 1980）、`liveHistoryOutputIds.usedAsInput`（约 2384）、`getDerivedDataFlowEdges`（约 2514）、`stepReadsDataset`（约 2540）、`runHistoryInputKey`（约 5273）、`reconcileRunHistory`（约 5295），以及 `publishPipelineRun` 中改连 Run 的部分（约 5805）。
   - `workflowCanvasRuntime.js`：`addRunNode`（约 400–441）。
   - `workflowDependencyColors.js`（约 14）：改用 `runInputSource`，删掉查存储 `dataset-to-run` 连线的那段（这种连线从不存在）。
   - `pipelineDetection.js`（约 165、248）、`pipelineRunInputs.js`（约 21）。
   - `runHistoryCapture.js`（约 45）、`runHistoryResolver.js`（约 148）、`runHistorySelection.js`（约 112 的 patch、约 285、约 329）。`runHistorySelection.js` 中 patch 写 `runWorkingSetId` 的地方，改成在最后应用 patch 时调用 `setRunInputSource`。
   - Agent：`changeSet.js` 的 `scoreBundle`、`add_run`、`update`（run）、`save_run_results`、`remove`；`workflowNodeInspector.js` 的 `inspectRun`；`runJobs.js`。
4. 本步骤不改：`getCanvasState` / `loadCanvasState` 的序列化（仍写 `runWorkingSetId`）、`pipelineExportDefinition.js` 的字段白名单（第 6 步改）、`runHistorySignature.js` 中作为签名键名的 `datasetNodeId`。

**检查：** 执行 `grep -rn "runWorkingSetId" app/src`。剩下的匹配只应出现在以下位置，把清单和理由写进完成记录：
- `stepInputs.js`
- `workflowCanvas.js` 的 DOM 适配函数和序列化
- `pipelineExportDefinition.js`

**测试：**

- 新建 `app/tests/stepInputs.test.mjs`，覆盖本步骤的函数：有输入、无输入、输入指向不存在的节点、Sampler 子集作为输入。
- 现有测试一个都不改，全部通过。这是“行为不变”的证明。如果某个测试必须改，说明行为变了，停下来检查。

**手工验证：**

- [ ] Run 窗口打开时选中的 Dataset 与之前相同；切换 Dataset 后画布上的线和颜色随之更新。
- [ ] Score 和 Review 的窗口正常打开，比较表的输入列正常。
- [ ] 删除被 Run 选中的 Dataset 时仍被阻止。

**Agent：** 本步骤中的 `changeSet.js` 改动就是最低适配。

**验收：**

- [ ] 前后端测试全部通过，现有测试未修改。
- [ ] 构建通过。
- [ ] grep 检查结果已记录。

**完成记录：** 2026-10-08 完成，验收各项全部通过。

- 与计划不同的地方：
  - **构建 Review 比较行的两个模块级函数**（`buildReviewComparisonRows`、`buildReviewComparisonRowsFromCodeMatch`）改为接收调用方传入的 Run 输入表（新增最后一个参数 `runInput`）。它们原来直接读节点上的 `runWorkingSetId`，而且同时被真实节点和“画布状态伪造的节点”调用，拿不到 `connections`；不改的话，第 6 步把输入移到连线上之后它们就读不到了。7 个调用处都改为传 `readRunInputTable(runNode)`，或传 `resolveLiveScoreComparisonContext` 返回的 `runInput`。
  - Run 窗口不再直接读写节点属性，改由节点工厂传入 `getInputSource` / `setInputSource`。`openRunDetailModal` 只有节点工厂这一个调用方。
  - `runHistorySelection.js` 把 Run 输入从 patch 中分出来，单独记在 `runInputs` 里，在应用 patch 的同一个循环里调用 `setRunInputSource`。“哪些节点变了”的判断和顺序不变。
  - `workflowDependencyColors.js` 删除了查找存储的 `dataset-to-run` 连线的那段：这种连线从不存储。
- grep 检查后剩下的 `runWorkingSetId`：
  - `stepInputs.js`；
  - `workflowCanvas.js` 的 DOM 适配函数（`runInputState`、`writeRunInputSource`）、`getCanvasState` / `loadCanvasState` 的序列化；
  - `workflowDependencyColors.js` 中同样性质的 DOM 适配（把节点属性交给 `runInputSource`）；
  - `pipelineExportDefinition.js` 的字段白名单（第 6 步处理）。
- 测试：前端 149 → 154（新增 `stepInputs.test.mjs` 5 项），现有测试一个都没改；后端 116 项不变。
- 手工验证（按 §1 的方法驱动桌面应用）：
  - 对照实验：`sentiment-node-smoke-test.yc` 用新旧代码各打开一次，3 个 Run 窗口、1 个 Score 窗口、1 个 Review 窗口显示的内容、16 个节点的颜色、各类连线数量全部相同。
  - 在 Run 窗口里切换输入 Dataset：节点的输入、连线和底部颜色随之更新；随后删除这个 Dataset，被“已被 Run 或 Score 选中”的提示阻止。

---

### 步骤 4：Process 输入访问层（纯重构）

**目标：** 所有读写 Process 输入的代码都改为经过 `stepInputs.js`，并把 §2.2 中的主输入规则（第 0 步后前端剩 6 处）和必需输入规则（剩 3 处）各合并成一份。完成后行为与之前完全相同。

**前置：** 步骤 3。

**先读：** §2.2；`processDatasetBindings.js` 全文；`processSignature.js`；`workflowNodeFactories.js` 的 `getProcessDatasets` / `getProcessInputs` / `syncProcessDependencies` / `setPrimaryDataset`（约 670–731）；`processInputPicker.js`；`processDetailModal.js` 约 107–234。

**改动：**

1. 在 `stepInputs.js` 中加入 Process 相关的部分：
   - `processPrimarySource(state, processId)` → 来源或 `null`。规则与现在前端一致：`primaryDatasetId` 指向存在的 Dataset 时用它，否则取第一条 `dataset-to-process` 输入。这个函数不写回状态。
   - `processCandidateSources(state, processId)` → 可作为输入的来源列表，按画布顺序。本步骤是所有 Dataset：`{ nodeId, port: 'result', name, kind: 'dataset' }`。
   - `processInputBindings(state, processId, { code })` → `[{ nodeId, port, name, alias, primary, input, used, parameter }]`，结果与现在的 `processDatasetInputs` 完全相同（已保存的别名优先）。内部复用 `processDatasetBindings.js`。
   - `processRequiredInputs(state, processId, { code })` → 执行和 History 需要的绑定：主输入、已连接的输入、代码引用的别名。合并现在 3 处的写法。
   - `setProcessInputs(state, processId, { primary, inputs: [{ nodeId, port, alias }] })`：原地修改。本步骤仍写旧存储，即 `primaryDatasetId`、`datasetAliases` 和 `dataset-to-process` 连线。
   - `processInputEdges(state)` → `[{ fromId, fromPort, toId, alias }]`。
   - `stepInputEdges(state)` → `runInputEdges` 与 `processInputEdges` 的合并。
2. `workflowCanvas.js` 的 DOM 适配：新增 `readProcessInputs(processNode, code)`、`writeProcessInputs(processNode, { primary, inputs })`。两份 `getProcessDatasets` 改为调用访问层。主输入“写回”的副作用保留，第 6 步主输入写在连线上之后自然消失。
3. 改为调用访问层的地方：
   - 主输入规则的 6 处前端位置（§2.2，不含编译器和已删除的 `runHistoryMigration.js`）。
   - 必需输入规则的 3 处。
   - `workflowNodeFactories.js` 的 `getProcessInputs`、`syncProcessDependencies`、`setPrimaryDataset`，以及 `createProcessNode` 对 DOM 属性的读写。
   - `workflowCanvas.js`：`newProcessNode`（约 4358）、`runProcessNode`（约 5514–5523）、`stepReadsDataset`、`liveHistoryOutputIds.usedAsInput`、`publishPipelineRun` 中改连 Process 的部分（约 5808–5820）、Agent 运行时的 `getDatasetBindings`（约 3108）。
   - `workflowCanvasRuntime.js`：`addProcessNode`（约 2217–2224）。
   - `workflowDependencyColors.js`（约 24）、`pipelineDetection.js`（约 194、251）、`pipelineRunInputs.js`（约 26）。
   - `runHistoryCapture.js`、`runHistoryResolver.js`、`runHistorySelection.js`：patch 中的 `primaryDatasetId` / `datasetAliases`，以及约 224 处重写连线的部分，改为在应用 patch 时调用 `setProcessInputs`。
   - Agent：`changeSet.js` 的 `wireProcess`、`add_process`、`update`（process）、`remove`；`workflowNodeInspector.js` 的 `processAliasesOf` / `inspectProcess`。
4. 本步骤不改：序列化、`pipelineExportDefinition.js`、`processInputSignature` 的参数名、History 记录中的 `inputs.primaryDatasetId`。

**检查：** 执行 `grep -rnE "dataset-to-process|EDGE_TYPE_DATASET_TO_PROCESS|primaryDatasetId|processPrimaryDatasetId|datasetAliases|processDatasetAliases" app/src`。剩下的匹配只应出现在以下位置，清单写进完成记录：
- `stepInputs.js`
- DOM 适配和序列化
- `pipelineExportDefinition.js`
- `runHistorySignature.js` 的参数名
- History 记录格式中的 `inputs.primaryDatasetId`
- `pipelineHistoryImport.js` 写记录的地方

**测试：**

- 在 `app/tests/stepInputs.test.mjs` 中补充：
  - 主输入回退规则（有 `primaryDatasetId`、它指向已删除的节点、没有它）
  - 已保存的别名优先
  - 两个同名 Dataset 时别名加后缀
  - 必需输入包括只在代码中引用、没有连线的别名
  - `setProcessInputs` 的写入结果
- 现有测试不改，全部通过。

**手工验证：**

- [ ] Process 窗口的输入选择器列出的内容和别名与之前相同；勾选或取消输入、“Use as df” 后，代码参数和画布连线与之前一致。
- [ ] 打开示例项目，History 中各节点的结果仍在（签名没有变化）。

**Agent：** 本步骤中的 `changeSet.js` 改动就是最低适配。

**验收：**

- [ ] 前后端测试全部通过，现有测试未修改。
- [ ] 构建通过。
- [ ] grep 检查结果已记录。

**完成记录：** 2026-10-08 完成，验收各项全部通过。

- 与计划不同的地方：
  - **别名有两套算法，分别保留。** 窗口和选择器用 `processDatasetInputs`（会校验已保存的别名，按名字推导的别名会避让已保存的别名）；执行、History 捕获和对齐用另一套（直接用已保存的别名，否则用按名字推导的别名）。两者只在少见的旧状态下不同，但 History 签名包含别名，所以没有合并：`processInputBindings` 对应前者，`processRequiredInputs` 对应后者。第 6 步别名存到连线上后，两者自然一致。
  - **主输入规则统一为“记录的主输入是存在的 Dataset 时用它，否则取第一条输入”。** 原来 capture、resolver 在记录的主输入指向已删除节点时直接用这个无效 ID（之后报错或显示没有结果），现在会退回第一条输入。属于边缘情况。
  - 新增 `setProcessPrimarySource`（只改主输入，供“写回推断的主输入”和窗口里的 “Use as df” 使用）、`replaceProcessInputSource`（换来源但保留别名和主输入身份，供发布 Pipeline 时改连使用，第 8 步的 “Change source…” 也会用到）、`processInputAliases`（Process 窗口要用已保存的别名表）。
  - `runHistorySelection.js` 把 Process 的主输入、别名和连线合并成一个 `{ primary, inputs }` 记录，在应用 patch 的循环里一次比较（新写的 `processInputsOf` / `selectedProcessInputs` 只经过访问层）、一次写入。
  - `workflowDependencyColors.js` 的适配把记录的主输入直接当作 Dataset 交给访问层：原来的颜色计算就是直接信任它，不存在的 Dataset 由调用方随后过滤；现有测试的节点表里也没有 Dataset 节点。
  - Agent `inspect_node` 输出里每个输入的 `connection: 'dataset-to-process'` 字样保留，以免改变 Agent 看到的内容。
- grep 检查后剩下的匹配：
  - 局部变量和参数名 `primaryDatasetId`，以及 History 记录字段 `inputs.primaryDatasetId`；
  - `stepInputs.js`；
  - `workflowCanvas.js` 的 DOM 适配（`processInputState`、`storeProcessInputState`）和序列化；
  - `workflowNodeFactories.js` 中 `createProcessNode` 读档时写入属性；
  - `workflowDependencyColors.js` 的 DOM 适配；
  - `pipelineExportDefinition.js` 的字段和连线白名单（第 6 步）；
  - inspector 输出的 `'dataset-to-process'` 字样；
  - `workflowCanvas.js` 中已不再使用的常量 `EDGE_TYPE_DATASET_TO_PROCESS`（第 12 步删除）。
- 测试：前端 154 → 162（`stepInputs.test.mjs` 新增 8 项），改动前就有的测试一个都没改；后端 116 项不变。
- 手工验证（新旧代码对照，Kinase 示例）：
  - 5 个 Process 窗口的选择器内容和别名相同；
  - 在 Tidy extracted pairs 里勾选 kinase_abstracts、再把它设为 `df` 后，代码参数、主输入、别名表和保存的 18 条连线都相同；
  - 每个节点对上的 History 记录相同，说明签名不变。
  - 期间发现窗口被遮挡时页面定时器会被节流，已在 §1 补充处理办法。

---

### 步骤 5：编译器输入访问层（后端，纯重构）

**目标：** `backend/pipeline_compile.py` 读取 Run 和 Process 输入的代码集中到两个方法中，为第 6 步做准备。行为不变。

**前置：** 步骤 4。

**先读：** `backend/pipeline_compile.py` 的 `_Compiler`，重点是 `add_process`（约 232–283）和 `add_llm`（约 285–360）；`backend/test_pipeline_compile.py` 的 fixture 工厂（约 15–63）。

**改动：**

1. 在 `_Compiler` 中新增两个方法：
   - `run_input(self, rid) -> str | None`：返回输入 Dataset 的节点 ID。本步骤读 `runWorkingSetId`。
   - `process_inputs(self, pid) -> list[tuple[str, str]]`：返回 `(alias, dataset_node_id)` 列表，主输入的别名是 `df`。本步骤读 `dataset-to-process`、`primaryDatasetId`、`datasetAliases`，原有的诊断（`INVALID_PRIMARY_INPUT`、`INVALID_ALIAS`、`DUPLICATE_ALIAS`）保持不变。
2. `add_llm` 和 `add_process` 改为调用这两个方法。
3. `pipeline_runner.py`、导出代码不改。

**测试：** 现有后端测试全部通过、不修改。新增一个测试，直接调用这两个方法（构造 `_Compiler` 的方式参照现有测试），覆盖主输入回退和别名。

**验收：**

- [ ] 后端测试全部通过。
- [ ] 前端测试不受影响。

**完成记录：**

---

### 步骤 6：存储切换为 `data` 连线，画布格式 version 3

**目标：** 实现设计 §3.3 的存储方式和 §9 中关于输入的读档转换。本步骤只支持 Dataset 来源，步骤来源在第 7 步加入。对用户来说行为不变，只是文件格式升级。

**前置：** 步骤 5。

**先读：** 设计 §3.3、§3.8 的签名部分、§9；§2.1；`stepInputs.js`；`renderer.js` 的 `loadCanvasWithHistory`；`workflowCanvas.js` 的 `getCanvasState` / `loadCanvasState`。

**开始改代码前先做：** 用当前代码给一组 fixture 计算签名，写成测试常量，作为切换后签名不变的证据。fixture 要包括：只读一个 Dataset 的 Run；有主输入和一个额外别名输入的 Process；有保存别名的 Process。计算方法是 `runHistoryResolver.js` 的 `resolveHistoryCanvasState` 中计算签名的那条路径，或者直接调用 `runInputSignature` / `processInputSignature`。

**改动：**

1. 新建纯模块 `app/src/canvasFormat.js`，提供 `upgradeCanvasState(state)`：
   - 返回新对象，不修改传入的对象。按字段是否存在执行，可以重复执行；`version` 只用来标记。
   - 先把第 4 步完成时 `stepInputs.js` 中读旧存储的逻辑复制进来，作为私有函数 `legacyRunInput` / `legacyProcessInputs`。不要 import `stepInputs.js`，因为它马上要切换到新存储。
   - Run：有 `runWorkingSetId` 时删掉这个字段；如果它非空且指向存在的节点，加一条 `{ type: 'data', fromId, fromPort: 'result', toId: runId }`（已有相同连线就不重复加）。
   - Process：用 `legacyProcessInputs` 算出主输入和已连接的输入及其别名，主输入的别名是 `'df'`；删掉 `dataset-to-process` 连线、`primaryDatasetId`、`datasetAliases`，每个输入加一条 `{ type: 'data', fromId, fromPort: 'result', toId: processId, alias }`。别名必须与旧逻辑算出的完全一致，否则 History 签名会变。
   - 设置 `version: 3`。
   - 不碰 Dataset 的产出字段（第 11 步处理）。
2. 调用 `upgradeCanvasState` 的地方：
   - `renderer.js` 的 `loadCanvasWithHistory`：构造 `state` 之后，调用 `historySession.open` 之前。
   - `pipelineHistoryImport.js`：读取 Runner 冻结的旧画布（`definition.canvas_state`）之前。
3. `stepInputs.js` 改用新存储：
   - Run 的输入是指向它的那条 `data` 连线；`setRunInputSource` 替换这条连线。
   - Process 的主输入是 `alias === 'df'` 的连线；`setProcessInputs` 用带别名的 `data` 连线整体替换输入。
   - 新增 `validateStepInputs(state)`，返回违规列表：Run 最多一条输入；Process 有输入时恰好一条是 `df`；别名不重复。在测试里调用；开发模式下读档后若有违规，`console.warn`。
4. `workflowCanvas.js`：
   - 新增常量 `EDGE_TYPE_DATA = 'data'`。
   - `loadCanvasState` 重建连线时保留 `data` 连线的 `fromPort` 和 `alias`（约 5063）。
   - `getCanvasState` 改为输出 `version: 3`，不再输出 `runWorkingSetId`、`primaryDatasetId`、`datasetAliases`。
   - DOM 不再使用 `runWorkingSetId`、`processPrimaryDatasetId`、`processDatasetAliases` 属性。DOM 适配函数改为读写 `connections`；`createProcessNode` 去掉这两个参数。
   - 绘图：`data` 连线的样子与原来的 Dataset→Run 线、Dataset→Process 线相同；`getDerivedDataFlowEdges` 不再推导 Run 的输入线。
   - 删除保护等读取输入的地方，第 3、4 步已经改走访问层，这里确认它们仍然正确。
5. 写连线的地方全部改为通过访问层写 `data` 连线：`changeSet.js` 的 `connect(..., 'dataset-to-process')`、`syncProcessDependencies`、`runHistorySelection.js`、`newProcessNode`、`workflowCanvasRuntime.js` 的 `addProcessNode`。改完后用 `grep -rn "dataset-to-process" app/src` 确认，只剩 `canvasFormat.js`。
6. `pipelineExportDefinition.js`：
   - 节点白名单去掉 `runWorkingSetId`、`primaryDatasetId`、`datasetAliases`。
   - 连线白名单加入 `data`：两端都在所选路线中的保留，起点是入口 Dataset 的也保留；去掉 `dataset-to-process`。
   - 返回的 `version` 改为传 `canvasState.version`。
7. 后端：
   - `pipeline_compile.py`：`run_input` / `process_inputs` 改读 `data` 连线，主输入是 `alias == "df"`，没有时报 `INVALID_PRIMARY_INPUT`。如果来源不是 Dataset，新增报错 `UNSUPPORTED_STEP_SOURCE`（第 9 步删除）。
   - 编译器只接受新格式。前端发送的总是升级后的画布；Runner 恢复和修订运行时用的是冻结的 spec，不重新编译旧画布。
   - `backend/project_store.py` 中 `merge_project` 的注释提到 `runWorkingSetId`，顺带更新。
8. 测试 fixture：
   - 前端：凡是测试“当前行为”的 fixture，改成新格式；只有专门测试旧格式的用例，才在 fixture 外包一层 `upgradeCanvasState`。涉及的测试文件见 §2.2，例如 `pipelineRouteSelection`、`pipelineRunInputs`、`pipelineRunDefinition`、`pipelineExportDefinition`、`pipelineHistoryImport`、`runHistoryResolver`、`runHistorySelection`、`runHistoryCapture`（后三个是第 0 步拆出来的）、`contentLocks`、`workflowDependencyColors`、`agentNodeSettings`、`agentRunPrompt`、`agentPipelineActions`、`pipelineRunClient`、`datasetHistorySource`。
   - 后端：`test_pipeline_compile.py` 的工厂函数 `run(input_id)`、`process(primary)`、`edge` 改成生成 `data` 连线；`test_pipeline_runner.py`、`test_pipeline_export*.py` 的 fixture 同步修改。
   - `pipelineSelectionBridge.mjs` 与后端测试 `test_real_frontend_selection_compiles` 要一起通过。

**测试：**

- 新建 `app/tests/canvasFormat.test.mjs`：
  - Run 和 Process 的转换。
  - 重复执行结果不变。
  - 新旧格式混在一起的画布（模拟合并项目）。
  - 别名与旧逻辑一致：保存过的别名、按名字推出的别名、同名加后缀。
  - 转换后，用新代码对 fixture 计算的签名与开始前记下的常量相同。
  - 读取 `examples/Kinase–Substrate Evidence Curation.yc` 转换后：每个 Run 恰好一条输入，每个有输入的 Process 恰好一个 `df`，没有 `runWorkingSetId` / `dataset-to-process` 残留，`validateStepInputs` 无违规。
- `stepInputs.test.mjs` 改为新格式，并补充 `validateStepInputs` 的用例。

**手工验证：**

- [ ] 打开 Kinase 示例的另存副本：Run 和 Process 窗口中的输入与之前相同；各节点的结果仍在，没有节点变成“没有结果”。
- [ ] Current Pipeline 显示的路线与之前相同；Export Python Project 成功。
- [ ] 保存后文件中 `version` 为 3，有 `data` 连线，没有旧字段；重新打开正常。
- [ ] 修改 Run 的输入后撤销、重做，结果正确。
- [ ] 让 Agent 新建一个 Run 和一个 Process，保存后检查是 `data` 连线。

**Agent：** `changeSet.js` 已经走访问层，自动写新格式。确认 `remove` 删除节点时，相关的 `data` 连线也被删除。

**发布说明要点：** 文件格式升到 version 3，旧版本应用打不开新保存的文件。

**验收：**

- [ ] 前后端测试全部通过。
- [ ] 构建通过。
- [ ] 手工验证全部通过。

**完成记录：**

---

### 步骤 7：步骤来源——输入解析、History、单节点运行

**目标：** 实现设计 §3.7、§3.8：`data` 连线的起点可以是 Run 或 Process 的端口；单节点运行能读取上游步骤的输出；History 按新格式签名和记录。本步骤没有界面入口，只用测试驱动。

**前置：** 步骤 6。

**先读：** 设计 §3.7、§3.8、§4；`runHistoryResolver.js`、`runHistoryCapture.js`、`runHistorySelection.js`、`runHistoryPresentation.js`、`runHistorySignature.js`、`runHistoryDeletion.js`、`contentLocks.js` 全文；`runResultsExport.js` 的 `buildRunResultsTable`。

**改动：**

1. `stepInputs.js`：
   - 来源可以是 Run（`port: 'result'`）或 Process（`port` 为分支名）。`sourceKey` 对步骤来源返回 `` `${nodeId}:${port}` ``。
   - `runCandidateSources(state, runId)` 和 `processCandidateSources(state, processId)` 加入步骤输出：
     - 每个 Run 一项。
     - 每个 Process 的每个端口一项，端口取第 2 步的 `effectiveProcessOutputs`。
     - 排除节点自己，以及沿 `data` 连线可达的所有下游节点，防止成环。
   - 每个候选项带 `kind`（`'dataset' | 'run' | 'process'`）、`name` 和 `label`。Run 的 `name` 和 `label` 都用它的 Prompt 名；Process 的单一输出用 Process 名；分支的 `name` 是分支名，`label` 是 “Process 名 · 分支名”。
   - 步骤候选的别名按设计 §3.5 生成，与 Dataset 候选一起去重。已经连上的输入，以连线上存的别名为准。
2. 新建纯模块 `app/src/stepOutputs.js`，提供 `stepOutputTable(state, source)`，返回 `{ table }` 或 `{ waiting }`：
   - Dataset：返回 `datasetContent`（Sampler 子集用 `subsetContent`）。
   - Run：当前记录必须是“已完成”，即 `runCompleted` 为 `'1'` 且不在运行中。表格用 `buildRunResultsTable({ results, runContent: runInputContent, schemaFields })` 生成，与 Run 的 Save results 相同；`schemaFields` 取 Run 所连 Prompt 的输出字段。
   - Process：不在运行中、不是已停止，并且 `dfResults.outputs[port]` 存在。端口不存在时返回 `waiting: 'missing-port'`。
   - `waiting` 的取值：`'no-result' | 'running' | 'stopped' | 'failed' | 'missing-port'`。行 ID 缺失时，按 `runHistoryResolver.js` 现有的写法补成 `` `${recordId}:${port}:${index}` ``。
   - 上游 Run 有出错行时，按设计 §3.7 处理：记录仍是已完成，照常返回表格，出错的行也在表中，输出列里是错误信息，与 `buildRunResultsTable` 现在的输出相同。同时返回 `errorRowCount`，即带 `error` 的结果条数（统计时与 `buildRunResultsTable` 一致，先经过 `markEmptyOutputAsError`）。
   - `stepInputs.js` 的 `runInputTable` 改为调用它。
3. 签名（`runHistorySignature.js`）：
   - 新增 `stepOutputSignature({ nodeId, recordId, port })`，即 `sha256Signature({ kind: 'step-output', nodeId, recordId, port })`。
   - `processInputSignature` 的绑定按键排序：Dataset 的键就是节点 ID，所以只有 Dataset 输入的 Process，签名与之前完全相同；`primaryDatasetId` 参数传 `df` 那个绑定的键。
   - `runInputSignature` 的 `datasetNodeId` 参数传来源的键。
4. `runHistoryResolver.js`：
   - `resolveNode` 遍历输入时：Dataset 来源走原来的逻辑；步骤来源先 `resolveNode(上游)`，上游记录必须是已完成，才用 `stepOutputSignature`。
   - 任何一个输入不可用时，这个节点没有当前记录，并设置 `waitingForUpstream: true`；可用时删掉这个字段。
   - 原有的派生 Dataset 逻辑先保留（第 12 步删除）。
5. `runHistoryCapture.js`：
   - 按设计 §3.8 写输入快照：Dataset 来源写 `{ kind: 'dataset', nodeId, name, content, signature }`；步骤来源写 `{ kind: 'step', nodeId, port, recordId, signature }`，不复制表格。
   - Run 记录的字段名仍是 `inputs.dataset`，Process 仍是 `inputs.bindings`（另带 `alias`），`inputs.primaryDatasetId` 存 `df` 的键。
   - 记录顶层的 `sourceRecordIds` 要包含所有步骤来源的 `recordId`。
6. `runHistorySelection.js` 的 `visitRecord`：
   - 输入是 `kind: 'step'` 时，先 `visitRecord(input.recordId)`，再用 `setRunInputSource` / `setProcessInputs` 把节点输入设为这个步骤来源。冲突检测不变。
   - `readsRecord` 改为读 `input.recordId`。
   - 没有 `kind` 的旧记录按 Dataset 来源处理。
7. `runHistoryPresentation.js`：步骤输入显示为 “Prompt 名” 或 “Process 名 · 分支”，名字从画布节点读取，找不到时显示节点 ID。
8. `contentLocks.js` 的 `recordInputRefs`：步骤输入不锁定任何东西。
9. `runHistoryDeletion.js`：确认通过 `sourceRecordIds` 能级联删除下游记录，补测试即可。
10. 单节点运行：
    - `workflowCanvasRuntime.js` 的 `startRunNode`：输入表改用 `readRunInputTable`，内部调用 `stepOutputTable`。返回 `waiting` 时拒绝运行，提示 `Waiting for upstream results: run "<上游名>" first.`。窗口和 Agent 共用这个函数，所以会得到同样的提示。
    - `workflowCanvas.js` 的 `runProcessNode`：每个必需输入都用 `stepOutputTable` 取表，有 `waiting` 就同样拒绝。
    - `workflowCanvas.js` 中对齐 History 的部分（`runHistoryInputKey`、`reconcileRunHistory`、`reconcileHistoryOnce`）：判断是否过期的键要包含步骤来源上游的 `historyRecordId`；把 `waitingForUpstream` 写到 DOM 的 `data-waiting-for-upstream` 属性。
    - Run 窗口和 Process 窗口最低限度地适配：`waitingForUpstream` 时 Run 按钮不可用，文字为 “Waiting for upstream”。完整的界面在第 8 步。
    - 上游有出错行时不阻止运行。`stepOutputTable` 返回的 `errorRowCount` 大于 0 时，下游窗口显示 `Upstream "<名字>" has N rows with errors; they are passed on with the error text in their output columns.`。Run Pipeline 的 fail-fast 不变，不要改 Runner。
11. `workflowDependencyColors.js`：步骤来源沿 `data` 连线往上找到源 Dataset，用它们的颜色。
12. Agent 的 `try_process`（`agentTools.js` 的 `tryProcess` 和 `workflowCanvas.js` 的 `getDatasetBindings`）本步骤仍只用 Dataset，第 13 步再改。

**测试：**

- 新建 `app/tests/stepOutputs.test.mjs`：
  - Dataset 来源。
  - Run 来源：已完成、运行中、未完成；有出错行时返回完整表格和正确的 `errorRowCount`，空输出被当作出错行。
  - Process 来源：端口存在、端口不存在、已停止。
- `stepInputs.test.mjs` 补充：候选排除自己和下游；步骤候选的别名和去重；`sourceKey`。
- 新建 `app/tests/stepSourceHistory.test.mjs`，场景如下：
  1. Dataset → Run A → Run B：捕获 B 的记录时，输入是 `kind: 'step'` 并引用 A 的记录；resolver 只在 A 的当前记录与之匹配时，才找到 B 的记录；A 切到另一条记录后 B 显示“没有结果”。
  2. Process 的两个分支同时作为另一个 Process 的 `df` 和 `df_x`：签名稳定，绑定键的顺序正确。
  3. 选择 B 的一条记录时，A 一起切换。
  4. 删除 A 的记录时，B 的记录被级联删除。
  5. 只有 Dataset 输入的 fixture，签名等于第 6 步记下的常量。
- `contentLocks.test.mjs` 补充：步骤输入不锁定内容。

**手工验证：** 本步骤没有界面入口，只需确认现有功能没有回退：

- [ ] 示例项目的结果仍在。
- [ ] 单节点运行 Run 和 Process 正常。
- [ ] History 切换正常。

**Agent：** `run_nodes` 与窗口共用运行函数，自动遵守“等待上游”的规则。其余放到第 13 步。

**验收：**

- [ ] 前后端测试全部通过。
- [ ] 构建通过。

**完成记录：**

---

### 步骤 8：界面——选择步骤输出、右键菜单、端口连线

**目标：** 实现设计 §5，让用户可以直接把执行节点连起来。

**前置：** 步骤 7。

**发布：** 不能单独发布。完成后用户可以连出步骤到步骤的线，但 Pipeline 面板要到第 9 步才认识这种连线。

**先读：** 设计 §5；§2.2 中关于窗口的部分；`runDetailModal.js`；`processInputPicker.js`；`processDetailModal.js`；`workflowCanvas.js` 的 `showNodeContextMenu`（约 3213）及其 actions（约 3354）、`newRunNode`、`newProcessNode`、`renderEdge`。

**改动：**

1. Run 窗口：
   - 输入下拉框（`populateDropdown` / `selectWorkingSet`）改为分两组：“Datasets” 和 “Step outputs”。选项来自 `runCandidateSources`；`workflowNodeFactories.js` 中原来的 `getWorkingSets` 改为提供这些候选。选项的值用 `sourceKey`；选中后调用 `writeRunInputSource`。
   - 列映射需要输入的列名。如果所选上游还没有结果（`stepOutputTable` 返回 `waiting`），映射区显示 “Run the upstream step first to map its columns”，Run 按钮不可用。
   - 有结果后锁定映射的规则（`isDatasetMappingLocked`）不变。
2. Process 窗口：
   - 选择器（`processInputPicker.js`）分组列出 `processInputBindings` 返回的候选，现在包括步骤输出，每项显示别名。勾选、取消、“Use as df” 的机制不变：先改写代码参数，再同步连线。
   - 每个已勾选的输入加一个 “Change source…” 操作：列出其他候选，选中后用 `setProcessInputs` 替换来源，别名保留，代码不改（设计 §3.5）。
3. 右键菜单（设计 §5.2）：
   - 把菜单项的生成放进纯函数 `app/src/stepOutputMenu.js` 的 `stepOutputMenuItems(state, nodeId, { port })`，返回 `[{ action, label, source }]`，便于测试。
   - Run：加 “Run a prompt on results”（action `run-prompt-on-output`）和 “Process results with code”（action `process-output`）。上游还没结果时也可以点，这样可以先把 Pipeline 搭好。
   - Process：同样两项。有多个端口时每个端口各一项，例如 “Process 'needs_name_rewrite' with code”。
   - 点击端口标签（第 2 步的 `.workflow-node__process-port`）弹出只含这个端口的菜单。
   - `newRunNode` 增加参数 `inputSource`，预填输入；Prompt 由用户在 Run 窗口中选择，与顶栏的“新建 Run”一致。`newProcessNode` 的 `datasetNode` 参数改为通用的 `inputSource`。事件 `workflow:add-run-node` / `workflow:add-process-node` 的 detail 同步增加 `inputSource`。
   - 新建 Process 的示例代码按输入的列生成，与现在从 Dataset 新建一致；上游还没结果时用空列表。
4. 连线从端口出发（`renderEdge`）：
   - 起点是 Process、`fromPort` 不是 `'result'`、并且节点上有对应的端口标签时，起点的 y 坐标取标签的垂直中点。
   - 端口不存在时，这条线画成红色，`title` 写 `Branch "<x>" is not returned by this Process`（设计 §3.4）。
5. 等待上游的显示：
   - 节点有 `data-waiting-for-upstream` 时淡化显示，`title` 写明在等哪个上游。
   - Run 窗口和 Process 窗口顶部显示 “Waiting for upstream results from <上游名>”。
6. 删除保护：现在有出边的节点不能删。确认从 Run/Process 出发的 `data` 连线同样被算作出边。

**测试：**

- 新建 `app/tests/stepOutputMenu.test.mjs`：单一输出的 Run；有多个端口的 Process；指定端口时只返回该端口的菜单项。
- 窗口中的列表分组和别名逻辑，若有新增的纯函数（例如候选分组），一并测试。

**手工验证（按顺序做一遍）：**

- [ ] 新建：Dataset → Run（Prompt A）→ 用右键菜单 “Process results with code” 新建 Process P（代码返回两个分支）→ 在 P 的分支 1 上 “Run a prompt on results”（Prompt B）→ 新建 Process Q，`df` 是 P 的分支 2，`df_<x>` 是 Prompt B 的 Run 的结果。
- [ ] 跑之前：P、Run B、Q 都显示等待上游，Run 按钮不可用。
- [ ] 依次单独运行 Run A、P、Run B、Q：每一步都能运行，结果正确。
- [ ] P 的两条输出线分别从两个端口标签出发。
- [ ] 改 P 的代码删掉分支 1：连到分支 1 的线变红，Run B 不能运行。
- [ ] 撤销、重做，保存后重新打开，以上状态都正确。
- [ ] History：在 Run B 的 History 中选一条旧记录，P 和 Run A 一起切换。

**Agent：** 无改动。Agent 暂时还不能创建步骤来源，第 13 步处理。

**验收：**

- [ ] 前后端测试全部通过。
- [ ] 构建通过。
- [ ] 手工验证全部通过。

**完成记录：**

---

### 步骤 9：Pipeline 沿 `data` 连线——检测、路线、编译、导出

**目标：** 实现设计 §6.1、§6.2、§6.5。Dataset 只作为入口；带产出关系的 Dataset 不再把 Pipeline 串起来。

**前置：** 步骤 8。

**发布：** 不能单独发布，第 10 步之前 Run Pipeline 结束后的导入会失败。

**先读：** 设计 §6；§2.5；`pipelineDetection.js`、`pipelineRouteSelection.js` 全文；`pipelineOverviewModal.js` 约 30–260、540–750；`backend/pipeline_compile.py` 全文；`backend/test_pipeline_compile.py`、`app/tests/pipelineRouteSelection.test.mjs`。

**目标行为（必须保持的路线语义）：**

- 入口：被第一批步骤读取的 Dataset。同一位置有多个 Dataset 可选时，仍作为可选项。
- 步骤之间不再有 Dataset 选项。下游连的是某个具体节点的某个端口。
- Prompt 有多个版本或多个 Run 时，选择哪个 Run 的规则不变。所选的 Run 没有下游时，路线到它为止，与现在 Run 没有保存 Dataset 的情况相同。
- Process 的多个端口显示为分支 lane；多个输入汇合到一个 Process，lane 在那里合并。这与现在一致。
- 同一个输出端口同时被 Run 和 Process 读取时，按现在的 `splitByConsumerKind` 拆成两条 Pipeline。
- 生产者冲突的概念删除。

**改动（前端）：**

1. `pipelineDetection.js`：
   - Prompt 和 Process 步骤的输入改用 `stepInputs.js`，包括步骤来源。
   - 原来按 Dataset 节点生成的“槽位”步骤，改为按输出端口生成：对每个有下游的（生产步骤，端口）生成一个槽位。槽位 ID 保持现有格式 `dataset:after:<生产步骤>`，Process 的命名端口用 `dataset:after:<生产步骤>:branch:<端口>`，这样 `pipelineRouteSelection.js` 的 `isProcessFork` 不用改。
   - 槽位的 `datasets` 改为 `outputs: [{ producerNodeId, port, consumerStepIds, consumerRunNodeIds }]`。Prompt 步骤有多个 Run 时，每个有下游的 Run 一项。
   - 入口槽位 `before:<消费者>` 仍列出 Dataset 选项。
   - 去掉对 `datasetProducerConflicts` 的使用，以及读 `sourceRunNodeId`、`process-to-dataset`、两种快照连线的代码。
2. `pipelineRouteSelection.js`：
   - `datasetOptions` 只处理入口槽位；中间槽位按上游所选的 Run 选定对应的输出，不再显示可选项。
   - `exportRoutePayload` 只为入口 Dataset 输出 `{ type: 'dataset' }` 项，包括入口槽位的 Dataset 和 Process 的 Dataset 输入；`prompt` 和 `process` 项不变。
3. `pipelineOverviewModal.js`：`getCanvasNodeIds` 等函数随之调整；删除生产者冲突的提示（约 547–550）。
4. `pipelineInputAvailability.js`：
   - `pipelineInputDatasetIds` 改为所选步骤 `data` 连线起点上的 Dataset，因为所有 Dataset 都是入口。
   - `assertPipelineInputsAvailable` 去掉冲突检查；`resultMissing` 检查保留到第 12 步。
5. `pipelineRunInputs.js`：入口改用 `stepInputs.js`。
6. `pipelineExportDefinition.js`：
   - 连线只保留 `data` 连线（两端都在路线中，或起点是入口 Dataset），以及 `prompt-to-run`、`prompt-to-prompt`。去掉 `process-to-dataset` 和两种快照连线。
   - 节点白名单去掉 `sourceRunNodeId`、`processOutputName`、`savedCopy`。Process 加上 `processOutputPorts`，编译器要用它。
7. 删除 `app/src/pipelineProducerConflicts.js` 和测试 `app/tests/datasetSourceContracts.test.mjs`。

**改动（后端 `pipeline_compile.py`）：**

1. 输入：
   - Dataset 来源 → 产物 `dataset:<id>`，仍要求它是所选的入口。
   - 步骤来源 → 产物 `output:<生产 job>:<端口>`，生产 job 是 `llm:<Run>` 或 `process:<Process>`。
   - 生产 job 不在所选路线中时，新增报错 `UNSELECTED_UPSTREAM`，信息里写明上游节点名。
2. 输出：
   - Process job 的端口为 `processOutputPorts` 识别出的端口与被下游使用的端口的并集。
   - 动态输出只用被下游使用的端口，并给出 `RUNTIME_PROCESS_CONTRACT` 警告。
   - 下游用到的端口不在静态识别结果中，并且不是动态输出时，报错 `UNKNOWN_OUTPUT_PORT`。
   - 没有任何下游、也没有识别结果的 job，沿用现在的隐式 `output:<job>:result`。
3. 产物名称（设计 §6.5）：LLM 用 Prompt 名；Process 的单一输出用 Process 名；分支用分支名。导出代码已经会处理重名。
4. 删除 `link_producers`，以及 `MULTIPLE_PRODUCERS`、`INPUT_PRODUCER_CONFLICT`、`UNSELECTED_PRODUCER`、`MISSING_BRANCH_NAME`、快照连线的处理和第 6 步加的 `UNSUPPORTED_STEP_SOURCE`。`order_jobs` 依据产物的 `producer`，在 `add_*` 中直接设置。
5. `pipeline_runner.py` 的 `_input_tables` 只处理 `dataset:` 入口，不用改。确认 `output:` 产物在 Runner 中按 job 输出正常写入和读取。
6. 导出代码：确认 `output:` ID 只在内部作为数据表的键使用；命令行的 `--input` 只接受 Dataset 入口。
7. 更新 `docs/design/PIPELINE_SPEC_V1.md`：产物 ID 的说明，以及删除和新增的诊断代码。

**测试：**

- 后端：
  - `test_pipeline_compile.py` 的 `simple()`、`branched()` 改为步骤到步骤的 `data` 连线。场景保持：raw → split（left, right）→ merge → LLM。
  - 断言产物为 `output:process:split:left` 这类 ID。
  - 删除被删诊断的测试；新增 `UNSELECTED_UPSTREAM`、`UNKNOWN_OUTPUT_PORT`、终端多分支 Process 按分支命名产物的测试。
  - `test_pipeline_runner.py` 的 `serial_state` 和 split/merge 测试同步修改。
  - `test_pipeline_export*.py` 中期望的输出表名改为新名字。
- 前端：
  - `pipelineRouteSelection.test.mjs` 改写 fixture，场景保持：线性、多版本、分支 lane、汇合、按消费者类型拆分。
  - `pipelineRunInputs`、`pipelineRunDefinition`、`pipelineExportDefinition`、`agentPipelineActions` 同步修改。
- `test_real_frontend_selection_compiles` 跨语言测试通过。

**手工验证：**

- [ ] 用直连方式重搭 Kinase 的流程。Current Pipeline 显示的结构与旧示例一致，分支 lane 正确。
- [ ] Run Pipeline 对话框只列出 `kinase_abstracts` 作为输入。
- [ ] Export Python Project 生成的项目可以运行（导出测试已经用 mock 覆盖）。
- [ ] 打开旧示例的另存副本：Pipeline 在每个中间 Dataset 处断成几段，每段都能识别和导出。

**Agent：** `pipelineActions.js` 使用 `exportRoutePayload` 和 `pipelineInputSteps`，自动跟上。`workspaceSummary.js` 的 `pipelineLines` 中关于 Dataset 选项的描述同步调整。

**验收：**

- [ ] 前后端测试全部通过。
- [ ] 构建通过。
- [ ] 手工验证全部通过。

**完成记录：**

---

### 步骤 10：Run Pipeline 结束后只导入记录并切换

**目标：** 实现设计 §6.3。

**前置：** 步骤 9。

**发布：** 不能单独发布，与第 8–12 步一起发布。

**先读：** 设计 §6.3、§3.8；`workflowCanvas.js` 的 `publishPipelineRun`（约 5711–5866）；`pipelineHistoryImport.js` 全文；`pipelineOverviewModal.js` 的 `wasPublished`（约 298）、`publishCompletedRun`（约 365）、`syncProjectContext`（约 430）；`app/tests/pipelineHistoryImport.test.mjs`。

**改动：**

1. `publishPipelineRun` 只保留以下内容：
   - 检查打开的项目没有变；
   - 取冻结定义；
   - 调用 `importPipelineRunHistory`；
   - 把各步骤的 `historyRecordId` 设为导入的记录；
   - emit `workflow:canvas-changed`；
   - 调用 `reconcileHistory`。

   删除的内容：建 Dataset 副本、`pipelineResultPosition`、改连下游、改写别名、冻结原 Dataset、`pipelineCopyInputs`。返回值改为 `{ history, historyError }`，`pipelineOverviewModal.js` 中使用返回值的提示文字同步调整。
2. `importPipelineRunHistory`：
   - 按 job 顺序导入，spec 中已经是拓扑顺序。
   - 入口 Dataset 产物（`dataset:<id>`）记为 `{ kind: 'dataset', nodeId, name, content, signature }`，`content` 从产物读取，`signature` 用 `datasetSignature({ nodeId, content })`。
   - 步骤产物（`output:<job>:<port>`）记为 `{ kind: 'step', nodeId: 生产节点, port, recordId: 生产 job 刚导入的记录 ID, signature: stepOutputSignature(...) }`。
   - 记录 ID 的生成方式不变，重复导入不会产生重复记录。
   - 删除 `inputCopies` 参数和 `pipelineCopyInputs`。
   - 旧运行的冻结定义中有带生产者的 `dataset:` 产物时，不导入，返回 `historyError`：`This run was made before steps connected directly; its results are not added to node History.`（设计 §9）。
   - 冻结画布要先经过 `upgradeCanvasState`。
3. `pipelineOverviewModal.js` 的 `wasPublished`：现在靠画布上带 `pipelineRunId` 的 Dataset 判断，改为以 History 索引中是否已有这次运行的记录为准（记录带 `pipelineRunId`）。要求：
   - 项目重新打开后不重复导入；
   - 应用关闭期间结束的运行，下次打开时会导入（现有的 `syncProjectContext` 流程）。

**测试：** 改写 `app/tests/pipelineHistoryImport.test.mjs`：

- Dataset → LLM → Process → LLM 链：各记录的输入类型正确，步骤输入引用的是上一步导入的记录。
- 重复导入是幂等的。
- 入口 Dataset 的内容来自产物，不来自画布。
- 旧格式的运行被拒绝，并带上述提示。
- 失败或取消的运行只导入成功的 job。

**手工验证：**

- [ ] 在直连的流程上 Run Pipeline：结束后画布上不增加任何 Dataset；各节点显示这次运行的结果；各节点的 History 中有这次运行的记录。
- [ ] 在最后一个节点的 History 中选一条更早的记录：上游一起切换。
- [ ] 重新打开项目：记录不重复。
- [ ] Stop 后 Resume，结束时导入正常。

**验收：**

- [ ] 前后端测试全部通过。
- [ ] 构建通过。
- [ ] 手工验证全部通过。

**完成记录：**

---

### 步骤 11：保存出来的 Dataset 改用 `savedFrom`

**目标：** 实现设计 §3.6、§5.1 中的来源线、§5.2 中删除 Dataset 菜单项，以及 §9 中产出字段的读档转换。

**前置：** 步骤 10。

**发布：** 不能单独发布，与第 8–12 步一起发布。

**先读：** 设计 §3.6、§5.1、§5.2、§9；§2.3；`workflowCanvas.js` 中事件 `workflow:add-dataset-node` 的处理函数（约 4246–4341）；`workflowCanvasRuntime.js` 的 `addDatasetNode`；`workflowNodeFactories.js` 的 `createDatasetNode`。

**数据：** Dataset 新增 `savedFrom: { kind: 'run' | 'process' | 'score' | 'pipeline', nodeId, port, recordId, pipelineRunId? }`。DOM 上存为 `node.dataset.savedFrom`，值是 JSON 字符串。

**改动：**

1. `canvasFormat.js` 的 `upgradeCanvasState` 补充产出字段的转换，仍按字段是否存在执行、可以重复执行：
   - `sourceRunNodeId` → `{ kind: 'run', nodeId, port: 'result', recordId: snapshotSourceRecordId || '' }`。
   - `process-to-dataset` 或 `process-to-dataset-snapshot` 连线 → `{ kind: 'process', nodeId: fromId, port: processOutputName || 'result', recordId }`。
   - `run-to-dataset-snapshot` 连线 → `kind: 'run'`。
   - 有 `pipelineRunId` 的 → `kind: 'pipeline'`，带 `pipelineRunId`；`nodeId` 和 `port` 按上面几条能算出来就带上。
   - 删除 `sourceRunNodeId`、`processOutputName`、`savedCopy`、`snapshotSourceRecordId`、`pipelineRunId`、`pipelineLogicalId`、`resultMissing` 字段，以及这三种连线。
   - `samplerNodeId` 和 `sampler-to-dataset` 不变。
2. 统一生成 Dataset 的入口，每种保存只有一个实现：
   - **Run：** 新建 `saveRunOutputAsDataset(runNodeId, { name, left, top })`，表格用 `stepOutputTable`，与 Run 的输出表相同；要求 Run 有当前记录。以下入口都改为调用它：
     - 右键菜单 `save-results-to-workspace`（修复它现在没有输入列、也不记来源的问题）；
     - Run 窗口（约 626–651）；
     - `workflowCanvasRuntime.js` 的 `saveRunResultsToWorkspace`：删除，或改成调用它；
     - Agent 的 `save_run_results`。
   - **Process：** 右键菜单 `process-save-to-workspace` 和窗口的 `createBranchDatasets` 改为传 `savedFrom: { kind: 'process', nodeId, port, recordId }`，不再加连线。
   - **Score：** 右键菜单、`scoreDetailModal.js`（经 `workflow:score-export-to-workspace`）、`saveScoreResultsToWorkspace` 统一，带 `savedFrom: { kind: 'score', nodeId, port: 'result', recordId }`；没有 Score 记录时 `recordId` 为空。
   - 事件 `workflow:add-dataset-node` 的 detail 用 `savedFrom` 代替 `runNodeId`、`processNodeId`、`processOutputName`、`snapshotSourceRecordId`。`samplerNodeId` 的路径不变。
   - `addDatasetNode` 和 `createDatasetNode` 的参数同样改为 `savedFrom`。
   - `getCanvasState` / `loadCanvasState` 序列化和恢复 `savedFrom`，不再处理旧字段。
3. 来源线：
   - 删除推导 `run-to-dataset` 线的代码，以及三种存储的产出连线的绘制。
   - 新增推导连线类型 `saved-from`：从 `savedFrom.nodeId`（节点存在时）指向 Dataset。样式按设计 §5.1：细虚线、颜色较淡、不带箭头、悬停提示 “Saved from …”。
   - 删除 `liveHistoryOutputIds`、`isHistorySnapshotEdge` 和相关的虚线逻辑。
   - 删除保护不把 `saved-from` 线算作出边。
4. 删除的功能：
   - Dataset 右键菜单的 “Save current source as new Dataset”，包括菜单项（约 3287–3294）和 action（约 3783–3817）。
   - Dataset 窗口中“第一次编辑时转成拷贝”（`workflowNodeFactories.js` 约 440–444）。
   - `workflowNodeFactories.js` 的 `datasetHistorySourceId`（约 89–92）。
5. Dataset 说明的默认文字保持现在的写法，例如 “Exported from <Prompt> Run. Run completed.”。
6. Agent 最低适配：
   - `changeSet.js` 的 `save_run_results`、`save_process_output` 写 `savedFrom`，不再加连线；`update`（dataset）不再转成拷贝。
   - `workspaceSummary.js` 的 `datasetLine`、`workflowNodeInspector.js` 的 `datasetProducer`，以及 `inspectRun` / `inspectProcess` 的 `savedAsDatasets`，改为读 `savedFrom`。
   - `agentTools.js` 中这两个工具的说明文字核对一遍。

**测试：**

- `canvasFormat.test.mjs` 补充每种产出字段的转换和重复执行。用 `examples/Kinase–Substrate Evidence Curation.yc` 做一个用例：转换后 12 个 Dataset 都没有旧字段，没有三种产出连线，其中 11 个有 `savedFrom`。
- 新建 `app/tests/savedDatasets.test.mjs`，把 `saveRunOutputAsDataset` 的表格构造和 `savedFrom` 构造放进纯函数测试：Run、Process 分支、Score。
- 更新 `agentRunPrompt.test.mjs`、`agentNodeSettings.test.mjs` 等断言 `savedCopy` 或 `sourceRunNodeId` 的测试。

**手工验证：**

- [ ] 打开旧示例的另存副本：中间 Dataset 带来源线和来源说明，作为入口可以单独运行。
- [ ] Run 的 Save results 从右键菜单和窗口各点一次，生成的表格完全相同（含输入列）。
- [ ] Process 的 Create branch datasets 正常，每个 Dataset 带来源线。
- [ ] Score 的 Save results 带来源线。
- [ ] Dataset 右键菜单中没有 “Save current source as new Dataset”。
- [ ] 删除来源 Run 后，来源线消失，Dataset 保留，说明文字保留。

**验收：**

- [ ] 前后端测试全部通过。
- [ ] 构建通过。
- [ ] 手工验证全部通过。

**完成记录：**

---

### 步骤 12：删除派生 Dataset 逻辑，更新文档

**目标：** 实现设计 §4、§8 中的删减，完成第 8–12 步的发布前检查。

**前置：** 步骤 11。

**先读：** 设计 §4、§8；§2.4。

**改动：**

1. 删除文件：`app/src/datasetHistorySource.js` 及其测试 `app/tests/datasetHistorySource.test.mjs`。若 `pipelineProducerConflicts.js` 还在，一并删除。
2. `runHistoryResolver.js`：删除 `resolveDataset` 中的派生分支、`missingDatasetIds`、写 `resultMissing` 的代码，以及末尾遍历 Dataset 的循环。
3. `runHistoryCapture.js`：删除派生输入的分支。
4. `runHistorySelection.js`：删除以下内容：
   - `datasetSources`、`demandSource`；
   - `visitDataset` 中的 `publishedPipelineCopy` 映射；
   - `datasetProducer`、`setDatasetOutput`；
   - 设置当前输出的循环（约 286–316）；
   - 邻接表中的 `sourceRunNodeId`。
5. `runHistoryPresentation.js`：删除 `inputLabel` 中的副本映射和 `datasetProducer`；`exportedDatasetNames` 改为 `savedDatasetNames(record, state)`，返回 `savedFrom.recordId === record.id` 的 Dataset，Process 还要求端口匹配。
6. `runHistorySignature.js`：`datasetSignature` 去掉 `sourceRecordId` / `branch` 参数和派生分支；调用方同步修改。
7. `runAnalysisHistory.js`：去掉派生 Ground truth 和 `groundTruthSourceRecordId` 的写入。`runHistorySession.js` 中 Score 记录的 `sourceRecordIds` 去掉这一项。`runHistoryDeletion.js` 继续读取旧记录里的这个字段，以便旧记录仍能级联删除。
8. `workflowCanvas.js`：
   - 对齐 History 的代码中去掉派生 Dataset 相关部分（`runHistoryInputKey` 约 5279、`reconcileRunHistory` 约 5298–5303、`reconcileHistoryOnce` 约 5390–5397）。
   - 删除以下读取 `resultMissing` 的地方：`getProcessDatasets`、`scoreNodeIsReadyForScoring`、Dataset 窗口的 `missingResult`、`duplicate-working-dataset`、`score-add-review`、`score-save-to-workspace`、`openDatasetEdgeDetailModal`。
   - `workflowCanvasRuntime.js` 的 `startRunNode` 中 `resultMissing` 的检查也一起删除。
9. Pipeline：删除前端 `assertPipelineInputsAvailable` 和 `pipelineExportDefinition.js` 中的 `resultMissing`，以及编译器的 `MISSING_RESULT` 检查。
10. 删除常量 `EDGE_TYPE_RUN_TO_DATASET`、`EDGE_TYPE_RUN_TO_DATASET_SNAPSHOT`、`EDGE_TYPE_PROCESS_TO_DATASET`、`EDGE_TYPE_PROCESS_TO_DATASET_SNAPSHOT`、`EDGE_TYPE_DATASET_TO_RUN`、`EDGE_TYPE_DATASET_TO_PROCESS`。`canvasFormat.js` 中用字符串字面量做转换。
11. 删除没有调用方的 `workflowCanvasRuntime.js` 函数：`addRunNode`、`addProcessNode`、`addSampledDatasetNode`，以及第 11 步没有改造成唯一实现的保存函数。删除前再确认一遍确实没有调用方，包括经过 canvas API 的调用。
12. 文档：
    - `docs/PIPELINE_GUIDE.md`：按新模型重写，内容包括直接连线、Save results 只用于冻结或修改数据、入口只有 Dataset。
    - `NODE_MODEL_REVIEW.md`：§2、§3 的状态改为“由 DATA_FLOW_DESIGN 实施”。
    - `RUN_HISTORY_PLAN.md`：在设计开头列出的几段旁标注“已由 DATA_FLOW_DESIGN 取代”。
    - `PIPELINE_EXECUTION_PLAN.md`：P1.4 的发布方式和 Run History 窗口按现状更正。
    - `PIPELINE_RUNNER_V1.md`：如有涉及就同步。
    - `DATA_FLOW_DESIGN.md`：状态改为“已实施（Agent 完整同步见第 13 步）”。

**检查：** 执行下面的命令，剩下的匹配逐条写进完成记录。

```bash
grep -rnE "sourceRunNodeId|processOutputName|savedCopy|snapshotSourceRecordId|pipelineLogicalId|resultMissing|run-to-dataset|process-to-dataset|dataset-to-process|dataset-to-run|runWorkingSetId|primaryDatasetId|processPrimaryDatasetId|datasetAliases|datasetHistorySource|publishedPipelineCopy|liveHistoryOutputIds|pipelineCopyInputs|datasetProducerConflicts|link_producers" app/src backend/*.py
```

允许的剩余：
- `canvasFormat.js` 中的转换代码；
- History 记录格式中的 `inputs.primaryDatasetId`；
- `runHistoryDeletion.js` 读取旧记录字段的地方；
- History 记录上的 `pipelineRunId`（这是记录字段，不是 Dataset 字段，本来就保留）。

**全面回归（手工）：**

- [ ] 从空项目开始，用直连方式搭一条含分支和汇合的流程，逐个单独运行，再 Run Pipeline。
- [ ] 打开两个 Kinase 示例的另存副本，检查读档转换结果。
- [ ] Prompt 优化流程不受影响：Dataset → Sampler → 子集 → Run → Score → Review → Apply。
- [ ] History：切换、撤销、重做、删除记录及级联删除。
- [ ] Export Python Project。
- [ ] 若有网页版环境，打开、保存、合并项目各做一次。

**发布说明要点（第 8–12 步一起发布）：**

- 执行节点可以直接相连，Run Pipeline 不再生成中间 Dataset。
- 旧项目的中间 Dataset 变成入口，旧 Pipeline 在这些 Dataset 处断开，可以手动改连成直连。
- 文件格式 version 3。
- Agent 暂时不能建立步骤之间的连接（第 13 步）。

**验收：**

- [ ] 前后端测试全部通过。
- [ ] 构建通过。
- [ ] grep 检查结果已记录。
- [ ] 全面回归通过。

**完成记录：**

---

### 步骤 13：Agent 完整同步

**目标：** 实现设计 §10，Agent 能做的事与用户一致。

**前置：** 步骤 12。

**先读：** 设计 §10；`app/src/agent/` 下的 `changeSet.js`、`workflowNodeInspector.js`、`workspaceSummary.js`、`runJobs.js`、`agentTools.js`；`backend/agent/system_prompt.py`、`backend/agent/guides/pipeline-building.md`、`process-code.md`；现有的 Agent 测试 `agentNodeSettings`、`agentRunPrompt`、`agentPipelineActions`、`agentHistoryProposal`。

**改动：**

1. `add_run` / `update`（run）：用 `input`（Dataset、Run 或 Process 的引用）加可选的 `input_branch`（Process 有多个端口时必填）代替 `input_dataset`。传 `input_dataset` 时明确报错，提示改用 `input`，不要悄悄兼容。有结果后锁定的规则与窗口一致。
2. `add_process` / `update`（process）：用 `primary_input` 加 `primary_branch` 指定 `df`。其他输入仍通过代码中的 `df_` 别名指定；`inspect_node` 列出所有候选来源和各自的别名。
3. 校验：来源存在；不成环，与窗口的候选规则相同；端口存在。
4. `inspect_node`：
   - Process：输出端口（端口列表、是否动态、是否与运行结果不一致）、各输入的来源和别名。
   - Run：输入来源。
   - Dataset：`savedFrom`。
   - 所有节点：是否在等待上游。
5. 工作区摘要（`workspaceSummary.js`）：描述步骤之间的连线和 `savedFrom`。
6. `run_nodes`：确认等待上游时的报错与窗口一致，补测试。
7. `try_process`：可用的输入来源与 Process 窗口的候选一致，包括步骤输出的当前表。
8. `select_history`：用步骤来源的场景补测试。
9. 后端文字说明：
   - `system_prompt.py` 中 Dataset 来源的说法改为：Dataset 是入口或保存的副本，执行节点直接相连。
   - `guides/pipeline-building.md` 改为直接连线的搭建方式，Save results 只用于冻结或修改数据。
   - `process-code.md` 中别名的说明加上步骤输出。

**测试：** 对每个改动的工具加测试，包括正常情况和报错情况。

**手工验证：**

- [ ] 让 Agent 搭一条 Dataset → Run → Process（两个分支）→ Run 的流程并运行，结果与手动搭的相同。
- [ ] 让 Agent 描述当前流程，描述中没有中间 Dataset。

**验收：**

- [ ] 前后端测试全部通过。
- [ ] 构建通过。
- [ ] 手工验证全部通过。

**完成记录：**

## 4. 进度

| 步骤 | 状态 | 日期 | 提交 | 前端测试数 | 后端测试数 | 备注 |
|---|---|---|---|---|---|---|
| 基线 | — | 2026-10-07 | `ed4672f` | 146 | 93 | |
| 0 | 完成 | 2026-10-07 | `e944005` | 140 | 93 | |
| 1 | 完成 | 2026-10-07 | `0198dbe` | 140 | 116 | |
| 2 | 完成 | 2026-10-07 | `a90e543` | 149 | 116 | |
| 3 | 完成 | 2026-10-08 | `c4ce4a4` | 154 | 116 | |
| 4 | 完成 | 2026-10-08 | `9b92a0a` | 162 | 116 | |
| 5 | 未开始 | | | | | |
| 6 | 未开始 | | | | | |
| 7 | 未开始 | | | | | |
| 8 | 未开始 | | | | | |
| 9 | 未开始 | | | | | |
| 10 | 未开始 | | | | | |
| 11 | 未开始 | | | | | |
| 12 | 未开始 | | | | | |
| 13 | 未开始 | | | | | |
