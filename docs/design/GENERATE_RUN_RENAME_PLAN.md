# Generate 节点与 Run 操作：改名影响调查

日期：2026-10-16  
调查基线：分支 `261014-log-dark-ui`，提交 `d882312`；调查开始时没有已跟踪文件的未提交修改。  
状态：已实施（2026-10-16，未提交）。下文保留调查清单，实际实现与验证见第 10 节。

## 1. 已确定的方向与本次边界

用户确定：节点尽量使用动词，执行操作使用 **Run**。

- 现有 **Run 节点**的产品名称改为 **Generate**。
- **Execute to here / Execute this step** 改为 **Run to here / Run this step**。
- Generate 的开始与再次运行按钮使用 **Run / Run again**。
- Prompt、Process、Sample、Evaluate、Optimize 的节点职责保持不变。
- 本次只改变命名及必要的显示兼容逻辑，不改变执行、复用、锁定、停止、恢复和重跑语义。
- 所有结果已经是当前结果时，再次运行仍按现有规则重跑目标步骤，不能借改名改回“无需执行”。

这不是全局字符串替换。代码中的 run 可能指节点，也可能指一次执行、API、状态字段或普通英文动词，必须逐类处理。

## 2. 命名表

下表中前四项是用户已确认的改名；其余是为了让设置、提示和结果说明同步的建议落地文字。

| 用途 | 当前文字 | 目标文字 |
| --- | --- | --- |
| 节点类型 | Run | Generate |
| 带上游运行 | Execute to here | Run to here |
| 仅运行此步 | Execute this step | Run this step |
| Generate 开始/再次运行 | Generate / Generate again | Run / Run again |
| 右键菜单的执行组 | Execute | Run |
| 计划及记录标题 | Execute to "X" / Execute "X" | Run to "X" / Run "X" |
| 新建步骤 | Create Run / Create new run | Create Generate |
| 从数据或结果新建 | Create Run with this data / from results / from 'branch' | Create Generate with this data / from results / from 'branch' |
| 步骤类型徽标 | Run prompt | Generate |
| 节点详情标题 | Run: X | Generate: X |
| 节点名称编辑 | Edit Run name / Run name | Edit Generate name / Generate name |
| 模型设置页签 | Run | Generate |
| 模型设置路径提示 | Settings → Run | Settings → Generate |
| 默认模型说明 | Default model for Run / default Run model | Default model for Generate / default Generate model |
| 节点设置小标题 | Run settings | Generate settings |
| 评估中的预测行 | Run row / Run result row | Model output row / Output row，按原表的含义选择 |
| 结果回退标题 | Run result | Generate result |

创建步骤与执行步骤要保持区别。Create Generate 只创建节点，不能因此开始调用模型。

### 2.1 相关执行按钮的统一范围

建议把 Process 的 Run code / Run code again 也统一为 Run / Run again，窗口已经说明它是 Process。

Evaluate 自定义匹配区的 Run matching code 是局部代码操作，并非整个 Evaluate 的另一种执行引擎；可统一为 Run / Run again，但必须保留区块标题与代码说明，避免只剩一个无上下文的按钮。

Stop、Resume、Retry 继续表达不同状态，不能全部替换为 Run。建议 Generate 使用短标签 Stop / Resume / Retry，与 Run / Run again 配套；Running、Generating 等状态说明仍可以自然表达执行进度。

Optimize prompt 是创建 Optimize 节点并启动其分析的现有入口，Sample 的 Create sample 是创建数据的入口，本次不顺带重新设计它们。

Executions 是“执行记录”的名称，不是节点类型，也不是执行按钮，保留。普通英文中的 run、running、ran、Run the pipeline 同样可以保留。

## 3. 必须覆盖的界面与默认名称

以下路径均相对仓库根目录。位置以函数或标识为准，后续代码变化时不要只依赖行号。

| 文件 | 已确认的位置和修改内容 |
| --- | --- |
| `app/src/topBar.js` | 桌面 Edit 菜单和网页版图标栏分别写了 Create new run；包含按钮 title 与 aria-label，两个入口都要改。图标函数与 data-action 不必改名 |
| `app/src/promptDetailModal.js` | Prompt 窗口底部 Create Run 按钮；模型选择器仍创建同一类节点 |
| `app/src/workflowNodeFactories.js` | 从 Prompt 创建节点时的 title、createRunNode 默认标题、aria-label；Evaluate 的 getRunState 名称回退还有对默认字符串 Run 的特殊判断 |
| `app/src/workflowCanvasNames.js` | findUniqueRunName 和重名判断中的默认名与空名回退；要与旧默认名的显示兼容一致 |
| `app/src/workflowCanvas.js` | 新建节点、加载项目、序列化回退、节点改名窗口、来源描述、执行菜单、禁用提示、错误标题、运行中异常；Export Evaluate 的 notes 也含 Run vs ground truth |
| `app/src/runDetailModal.js` | Generate 详情标题、设置标题、初始按钮、完成后的按钮、Stop 文案、输入连接提示、缺模型错误、结果表头 tooltip、日志中的节点描述 |
| `app/src/executionResumeState.js` | generation 的全部状态标签；若统一 Process/匹配操作，processing、matching 的标签也在此维护 |
| `app/src/processDetailModal.js` | Run code 不是只从共享函数取值；HTML、空结果说明、完成态和 History 切换后都有硬编码，必须一起核对 |
| `app/src/addPromptModal.js` | Prompt 编辑提示中写了 each input a Run fills；应改为 Generate 节点的说明 |
| `app/src/settingsModal.js` | Run 页签、说明段落、创建 Run 的说明、模型选择及参数控件 aria-label。data-tab、DOM ID 与保存字段保持原值 |
| `app/src/outputMenu.js` | Prompt、Dataset、Generate、Process 分支的创建菜单；空输入口 Create Run；Evaluate 所需结果的禁用理由 Run the upstream Run first |
| `app/src/nodePorts.js` | Evaluate 的固定输入说明、Connect Run 占位、输入锁定错误、来源默认名和端口 tooltip。Evaluate 内部输入 ID run 保留 |
| `app/src/stepInputs.js` | runLabel 的默认名、来源展示、校验错误；保留优先按 Prompt 命名来源的现有规则 |
| `app/src/pipelineDetection.js` | 生成路线选项时 runName 的缺省值 |
| `app/src/pipelineRouteSelection.js` | 没有具体名称时构造 Run 选项的回退值；不要改路线字段 runNodeId / run_node_id |
| `app/src/pipelineOverviewModal.js` | Current Pipeline 的 Run prompt 徽标、选项分组，以及相应说明；导出行为不变 |
| `app/src/runPlan.js` | Execute works on Run and Process steps、Use Execute to here、Settings → Run 等问题提示 |
| `app/src/runPlanDialog.js` | Run prompt 徽标、动态 Execute / Execute to 标题。Start 是确认计划的动作，不必强行替换 |
| `app/src/executionsPanel.js` | 同样独立维护徽标和动态标题；空状态、Resume tooltip 中也有旧节点/操作名 |
| `app/src/scoreDetailModal.js` | 空预测数据错误、连接 Generate 的说明、匹配代码示例注释及说明、行号 tooltip、CSV/XLSX 导出列 Run row、无数据状态、输入列 aria-label |
| `app/src/savedDatasets.js` | 保存结果时默认名称、notes、缺结果/History 错误，以及描述 savedFrom 来源的句子 |
| `app/src/runHistoryPresentation.js` | 历史记录缺少 Prompt 名时的 Run result 回退；历史状态 Completed/Running 等保留 |
| `app/src/runHistoryCapture.js` | 捕获输入失败、没有 Prompt 等用户可见异常中的 Run 节点名称 |
| `app/src/runHistorySession.js` | Select a Run or Process history record to delete 等错误中的节点名称 |
| `app/src/runHistorySelection.js` | Run history inputs are incomplete 等可能显示给用户的异常 |
| `app/src/runHistoryStore.js` | Open a project before using Run history 是共享历史存储提示，改为 node history / saved history 更准确 |
| `app/src/workflowCanvasRuntime.js` | 找不到节点、未接 Prompt、恢复 History 失败等异常；区分节点名称与一次任务的运行状态 |
| `app/src/reviewDetailModal.js` | 验证建议时缺少上游 Run 模型的错误；Run information 占位需要按内容判断是节点资料还是一次执行资料 |
| `app/src/reviewSuggestionActions.js` | No run credential configured on the upstream Run node；API 名称类错误不要机械替换 |
| `app/src/reviewSuggestionOptimizer.js` | No Run model configured、Settings → Run |

### 3.1 不能只搜大写 Run

本次还发现以下小写或动态拼接来源，均需人工检查：

- Create new run、New run、by run、saved results of run。
- 无模型、缺历史、删除依赖、连接错误等失败分支。
- aria-label、title、空状态、下拉选项、导出备注和导出表头。
- `${node.type}` / `${linked.type}` / `${savedFrom.kind}` 直接拼接的自然语言。
- `${condition ? 'Execute' : 'Execute to'}` 这类分段标题，不能只搜完整 Execute to here。
- 数据加载、History 切换和结果恢复后重新写入按钮文字的路径。

### 3.2 已检查、主要是内部标识或注释的区域

`renderer.js`、`main.js`、`preload.js`、`icons.js`、`modelPicker.js`、`perModelSettings.js`、`nodeSettings.js`、`modalDrag.js`、`promptText.js`、`promptOptimization.js`、`displayTextNormalize.js`、`stepOutputs.js`、`runResultsExport.js`、`runResumeUtils.js`、`stepExecution.js`、`runTo.js`、`runTaskLocks.js`、`runHistoryPicker.js`、`runHistoryResolver.js`、`runHistorySignature.js`、`runHistoryAssets.js`、`projectAssets.js`、`canvasFormat.js`、`undoHistory.js`、`pipelineInputAvailability.js`、`pipelineExportDefinition.js`、`pipelineRunClient.js`、`processRunClient.js`、`scoreCodeRunClient.js`、`scoreMatchPrimitives.js`、`scoreRunGtPairing.js`。

这些文件中的类型、字段、算法和调用名原则上不动；如果注释讲的是产品节点，按需更新注释。`reviewSuggestionOptimization.js` 的 Run API error 指具体传输接口，不作为节点名称直接替换。

`workflowNodePorts.js`、`workflowPortDrag.js`、`workflowContextMenu.js`、`nodeSourceLink.js`、`workflowNodeColors.js`、`nodeExecutionControl.js`、`promptVersionTree.js` 主要消费已有类型、名称或回调；重点做回归，避免改显示名时破坏图标、连线、版本定位或点击行为。

`workflowCanvas.css`、`modals.css` 和 `executionsPanel.css` 的 run 主要是选择器和注释；此次未发现需要改名的 CSS content 文案。保留选择器，必要时同步解释性注释；长按钮及菜单文字需要实际检查布局。

## 4. Agent 必须同步，协议不改

| 文件 | 修改或核对内容 |
| --- | --- |
| `app/src/agent/canvas/workflowNodeInspector.js` | nodeTitle 的 Run 默认名、模型缺省说明、Evaluate diagnostics、trace_row 错误、自然语言类型说明；返回对象的 type 仍是 run |
| `app/src/agent/context/workspaceSummary.js` | Runs 分组应称 Generate nodes；Run prompt 徽标、by run、来源描述及把 linked.type / savedFrom.kind 直接拼进自然语言的地方 |
| `app/src/agent/operations/changeSet.js` | add_run 默认名和 New run 提案标题；连接、断开、更新、删除提案把 node.type 直接拼进标题；模型设置路径、保存结果说明、类型错误及节点丢输入提示 |
| `app/src/agent/operations/proposals.js` | Select saved Run or Process history 等提案标题 |
| `app/src/agent/execution/runJobs.js` | run_to 预览卡的 Execute / Execute to 标题、普通 Run 任务的标题含义、模型提示、Evaluate/Stop/type mismatch 错误；保持 Run 作为“运行某节点”的动作 |
| `app/src/agent/tools/agentTools.js` | 工具描述中用 Generate 称呼节点，用 Run to here / Run this step 指界面操作；明确内部 add_run、kind: run 和 run_to 仍原样调用 |
| `app/src/agentChatSession.js` | 卡片由预览函数提供文字，Apply 按钮 Run 本来正确；避免把历史卡片内容或对话存档当成当前静态 UI 全局替换 |
| `app/src/agent/pipeline/pipelineActions.js` | 主要同步注释和自然语言说明；pipeline_action 仍只支持导出，不能因为改名重新加入旧运行入口 |
| `backend/agent/system_prompt.py` | 明确写 Generate（internal type run），与现有 Evaluate/internal score 的约定一致；同步节点能力、菜单、设置路径和 Pipeline 说明 |
| `backend/agent/guides/pipeline-building.md` | 节点、路线徽标、Run to here / Run this step、历史和导出说明 |
| `backend/agent/guides/prompt-design.md` | Create Generate、Generate 所需输入/模型及段落标题；API/工具词保留 |
| `backend/agent/guides/process-code.md` | 上游 Generate 数据、表结构和输入别名说明 |
| `backend/agent/guides/evaluation.md` | Generate 与标准答案的关系、预测行说明；示例 rowKey run:0 不变 |
| `backend/agent/guides/prompt-optimization.md` | Generate→Evaluate→Optimize 的说明；Run the prompt 作为动作可保留 |
| `backend/agent/guides/dataset-editing.md` | 保存结果/内容锁的节点名称 |
| `backend/agent/guides/export-and-share.md` | Generate/Process 路线、编译前检查与导出范围 |

自然语言展示应统一走节点类型标签映射，例如 run → Generate、score → Evaluate、promptReview → Optimize。不能将该映射用于工具参数、运行类型判断或序列化。

旧对话中模型可能仍遇到 Run node、Execute 及既有工具调用。新系统提示应明确这些是旧称，理解它们即可，不改写历史用户消息、模型回复或工具参数。

## 5. 后端与导出：文字也会返回前端

| 文件 | 影响 |
| --- | --- |
| `backend/pipeline_compile.py` | A Run reads exactly one input、Prompt/Run mismatch、输出端口错误、默认设置问题、物化列冲突及默认显示名；编译诊断会显示给导出用户，必须同步 |
| `backend/pipeline_export_spec.py` | Prompt Run、resolved Run settings 等导出错误 |
| `backend/pipeline_export.py` | 导出文件中的 selected Prompt and Run 注释及相关解释；README 的 Run 章节和 CLI Run the pipeline 是动作，保留 |
| `backend/pipeline_runner.py` | Run node 无凭据错误，虽然旧 UI 不调用 Runner，API 仍存在，不能遗留另一个节点名称 |
| `backend/main.py` | RunRequest 中 run_node_id、settings_overrides 的 schema description 是节点描述；路径、请求类、字段及任务错误协议不改 |

区分以下情况：

- `[Run]` 后端日志前缀和 Run API error 可作为技术命名保留，避免无必要地改变诊断约定；解释中的节点仍称 Generate。
- Run not found、Run interrupted 可能指一次执行任务，不一定是节点名，不能直接改成 Generate not found。
- `backend/pipeline_export_dag.py` 的 CLI 描述 Run the Python pipeline 正确，保留。
- `backend/model_settings.py` 中解释 Settings 页签的注释需要同步，设置键不变。
- `backend/project_store.py` 中“Run/Process 节点历史”的说明可改为 Generate/Process；run-records 端点和 runRecords 字段不变。
- `backend/llm.py` 的生成行为、`run_output_schema.py` 的空输出判定、review 算法的模型调用、`process_df_exec.py` 中 Run pip install 的安装提示不属于改名逻辑。
- 导出目录 `prompt/`、Python 函数名、文件名、CLI 参数、产物结构和 `Input:` / `Output:` 表头不因节点改名而变化。

## 6. 保存格式与旧项目：最容易被误改的地方

### 6.1 保留的内部协议

| 类别 | 保留示例 |
| --- | --- |
| 节点与历史种类 | type: run、kind: run、source.kind: run |
| 连接与端口 | prompt-to-run、run-to-score、Evaluate 输入口 run、result |
| 节点字段 | runName、runResults、runInputContent、runCompleted、runPending、runResumable、runCredentialId、runSettings |
| 保存与恢复 | historyRecordId、historyStaleRecordId、historySelectionSignature、sourceRecordIds、savedFrom、runRecords |
| 路线及编译字段 | runNodeId、run_node_id、llm:<node_id>、model_binding、diagnostic code |
| Agent 工具 | add_run、save_run_results、run_nodes、run_to、only_this、trace_row.run_node_id |
| 评分协议 | run:0 / run:1 行键、runOnly、runRows、run_input_column 等 |
| 传输和存储 | /api/run/*、/api/pipeline/runs*、run-records、history:* IPC、已有任务/历史文件路径 |
| DOM 与内部函数 | workflow-node--run、run-detail-*、data-action=new-run、createRunNode、startRunNode 等 |

不升级 schemaVersion，不把已有 type: run 存档批量转换为 type: generate，不重算历史签名或重建结果 ID。此处的完整性来自展示与协议分离，不来自把所有 run 字母消灭。

### 6.2 旧默认名和用户自定义名

代码存在多个名称来源，必须同时处理：新建默认值、空名回退、加载项目、保存回退、Agent 默认值、来源描述、路线选项、Evaluate 默认名判断。

已读取本地示例 `examples/Kinase–Substrate Evidence Curation - direct connections.yc`：其 `project.nodes` 中有 4 个 run 节点，runName 都是 Run。只改新建默认值，旧示例仍会显示旧名称。

建议兼容规则：

1. 新节点默认名和缺失名称均为 Generate。
2. 旧的精确默认名 Run 在当前展示中可按旧默认别名显示为 Generate；使用同一显示函数，不能只改卡片标题。
3. 旧默认名 Run 与新默认名 Generate 在 Evaluate 的“优先显示 Prompt 名”判断中都视为默认名，避免新默认名被误当作用户自定义名。
4. 其他已保存名字不批量替换。例如 Run A、Run 2、Dry run、Runx1 extraction 可能是用户命名；没有来源证据就不猜测。
5. 既有存储无法区分“用户特意命名为 Run”和“系统默认 Run”。第 2 条是对精确旧默认名的显示约定，实施时要明确记录这一个例外，不能声称识别出了用户意图。
6. 保留旧存档与 History 的原始名称，不批量修改历史快照、notes 或聊天。显示兼容不应改变输入签名或实际数据。
7. 手动编辑名称、去重与来源显示使用一致的比较规则，验证旧 Run 和新 Generate 同时存在时的行为。

建议新增一个小的前端命名模块，集中处理节点类型标签、新默认名、旧默认名识别和旧默认名显示。它只能接管命名，不接管执行、存储或数据迁移。Python 诊断使用对应产品文字，无需引入跨语言新架构。

### 6.3 新旧结果和复制导出

- 已有节点 History、当前选择、停止进度、保存数据集的来源和 Executions 记录继续可读。
- 新 Executions 记录在展示时使用 Run/Generate；旧记录的结构无需迁移。
- targetName、step.name、message 等已经冻结的历史文本不能用全局 replace 改写；当前类型徽标和动态标题可以改为新称。
- 新保存的数据集名称及说明采用新称；以前保存的数据集属于用户资产，不自动改名。
- `.yc` 打开、保存、另存、合并、网页导入导出均验证数据与记录引用不变。
- 本地 examples 未被 Git 跟踪，不把它们作为源码直接覆盖；用副本验证旧项目兼容。

## 7. 文档、网页指南和图片

### 7.1 当前文档

必须同步：

- `docs/PIPELINE_GUIDE.md`：节点称谓、Execute 标题和两种操作说明。
- `docs/AGENT_CAPABILITIES.md`：界面菜单与 Agent run_to 对齐。
- `docs/design/ANNOBIO_V2_FUNCTIONAL_DESIGN.md`：增加新的命名决定，避免继续把 Execute 当现行操作名称。
- `docs/design/RUN_TO_HERE_PLAN.md`：保留第 7 步历史，新增本次命名更新记录，不把过去的完成记录改写成另一件事。
- `docs/design/NODE_MODEL_REVIEW.md` 中按模型设置及 Create Run 的当前说明。
- `docs/design/DATA_FLOW_DESIGN.md`、`NODE_PORTS_DESIGN.md`、`PIPELINE_SPEC_V1.md`、`AGENT_DESIGN.md`、`PIPELINE_EXPORT_DESIGN.md`、`PIPELINE_EXECUTION_PLAN.md` 等仍会被接手者阅读的文档，应加命名约定或更新现行说明；引用的内部字段保持原样。
- `DATA_FLOW_PLAN.md`、`NODE_PORTS_PLAN.md`、`RUN_HISTORY_PLAN.md`、`RUN_LOOP_DESIGN.md` 等历史设计/实施记录保留历史事实，通过当前命名说明解释旧称。
- `IMAGE_DATASET_DESIGN.md` 若提到 Run 节点，加入同一命名说明即可；不要把例子里的运行命令当成节点名称。

不要求重命名文档路径或 run*.js 文件来完成产品改名。

### 7.2 网页指南正文不在模板里

指南正文、目录章节与截图 caption 实际由 **`hub/main.py` 的 GUIDE_CHAPTERS** 生成，`hub/templates/guide.html` 主要是框架。只搜模板会漏掉完整教程。

必须修改节点介绍、连接示例、模型默认设置、结果与 Process 对比中的 Run 节点称谓。`/guide#run-node` 等旧锚点建议保留兼容；若引入新锚点需保留旧链接入口。

调查还发现连接教程仍描述“数据集在 Run 窗口内选择”，与当前拖线交互不同。更新对应段落时要按当前行为重写，不能只把其中的 Run 换成 Generate 后继续发布错误步骤。

### 7.3 图片人工核对结果

已查看 README 主图与 GUIDE_IMAGES 引用的全部 11 张截图。图片中的文字不会被 rg 找到。

| 图片 | 本次发现与处理 |
| --- | --- |
| `images/screenshot.png` | 明确包含 Run 节点、旧结果名称和 RUN PROMPT 徽标，需要在完成改名后重新截图 |
| `hub/templates/guide_images/canvas-connected.png` | 明确包含 Run 节点，需要重新截图 |
| `hub/templates/guide_images/run-progress.png` | 明确包含 Run: Run、Run settings，需要重新截图 |
| `hub/templates/guide_images/run-results.png` | 明确包含旧窗口名称和设置标题，需要重新截图 |
| `hub/templates/guide_images/llm-settings.png` | 明确包含 Run defaults，且设置布局早已变化，需要重新截图 |
| `hub/templates/guide_images/review-method-picker.png` | 结果区含 Run result，且 Score/Review 旧称也已过时，需要按当前界面重新截图 |
| `hub/templates/guide_images/agent-assistant.png` | 背景露出旧 Run 节点的一部分；发布前用新画布重新截图 |
| `hub/templates/guide_images/add-prompt-modal.png` | 未发现本次目标节点文字；检查当前工具栏 tooltip，不必仅因改名重拍 |
| `hub/templates/guide_images/add-dataset-modal.png` | 未发现本次目标节点文字，保留本次改名以外的更新边界 |
| `hub/templates/guide_images/empty-canvas.png` | run 是普通运行指令，不是旧节点名；不机械修改 |
| `hub/templates/guide_images/process-node.png` | 按钮 Run 已符合目标；截图的旧 Process 交互属于另一个更新范围 |
| `hub/templates/guide_images/process-context-menu.png` | 未显示旧 Run 名，但发布新指南时核对是否需要展示新的 Create Generate 入口 |

截图应由真实更新后的界面重新采集，不用改图伪造当前功能。run-progress.png / run-results.png 的文件名及 URL 可以保留。

`hub/templates/landing.html`、`app/index.html`、`Caddyfile`、`docker-compose.yml` 和 `.github/workflows/build-desktop.yml` 已纳入检索；未发现需要修改的节点名称入口。CI 的 run:、npm run 和 /var/run 路径均不能改。

## 8. 测试影响与验收

### 8.1 现有测试先分类，不能批量替换 fixture

直接含操作标题、标签、默认名或节点说明的重点测试：

- `app/tests/executionResumeState.test.mjs`
- `app/tests/outputMenu.test.mjs`
- `app/tests/nodePorts.test.mjs`
- `app/tests/stepInputs.test.mjs`
- `app/tests/runPlan.test.mjs`
- `app/tests/runPlanDialog.test.mjs`
- `app/tests/runTo.test.mjs`
- `app/tests/executionRecords.test.mjs`
- `app/tests/agentNodeSettings.test.mjs`
- `app/tests/agentRunPrompt.test.mjs`
- `app/tests/agentStepInputs.test.mjs`
- `app/tests/agentPorts.test.mjs`
- `app/tests/agentScoreCode.test.mjs`
- `app/tests/agentAlignment.test.mjs`
- `app/tests/agentCapabilityParity.test.mjs`
- `app/tests/agentPipelineActions.test.mjs`
- `app/tests/savedDatasets.test.mjs`
- `app/tests/runHistoryPresentation.test.mjs`

涉及存档、来源、旧名称与协议的回归范围还包括 `historyGraphFixture.mjs`、`canvasFormat.test.mjs`、`contentLocks.test.mjs`、`runHistoryStorage.test.mjs`、`runHistoryResolver.test.mjs`、`runHistoryCapture.test.mjs`、`runHistorySelection.test.mjs`、`runHistoryDeletion.test.mjs`、`runHistorySession.test.mjs`、`stepSourceHistory.test.mjs`、`stepOutputs.test.mjs`、`pipelineRouteSelection.test.mjs`、`pipelineRunClient.test.mjs`、`runAnalysisHistory.test.mjs`、`undoHistory.test.mjs`、`workflowDependencyColors.test.mjs`。

这些文件不是都需要改。type: run 和用户自定义名 Run A / Run B 常常是有意的兼容 fixture，不能为了让检索结果消失而全部改掉。

后端重点覆盖 compile、export、runner、model settings、settings overrides、project history 和 run records 的已有测试。文案断言按新产品名称更新，接口、字段、序列化结构断言保留。不要为每一句文案添加一份重复测试，优先验证命名回退与兼容行为。

### 8.2 必须实际验证的场景

| 编号 | 场景 | 验收 |
| --- | --- | --- |
| N01 | 桌面菜单和网页工具栏新建 | 都创建 Generate，仍不直接调用模型 |
| N02 | Prompt 底部创建、数据/结果右键创建、拖线到空白处创建、空输入口创建 | 名称统一，Prompt/数据连接与选定模型正确 |
| N03 | 打开旧默认名 Run 的项目 | 当前类型和默认展示采用新称；History、结果和任务 ID 保持可读 |
| N04 | 用户自定义名称包含 Run | 不进行子串替换；用户名称保持不变 |
| N05 | Generate 无结果、运行中、停止、失败、完成、切换 History | Run、Run again、Stop、Resume、Retry 状态准确，不被旧硬编码覆盖 |
| N06 | Process 的相同状态 | 如果统一按钮，HTML、状态刷新和 History 恢复后的文字一致 |
| N07 | Run to here 和 Run this step | 范围不变、缺上游禁用原因一致、全部当前时仍只重跑目标 |
| N08 | 需要补跑上游及无法开始的计划 | 标题、Generate 徽标、问题、模型路径和确认卡一致 |
| N09 | Executions 新旧记录 | 当前标题为 Run to / Run，旧记录结构可读；Stop/Resume 行为不变 |
| N10 | Generate 连接 Evaluate、Process 或新 Generate | 来源名、默认名、Connect Generate、tooltip 和错误一致 |
| N11 | Evaluate 读取默认名和自定义名 | Run/Generate 默认别名均按原规则回退到 Prompt 名，自定义名优先 |
| N12 | 设置保存、删除模型、重新打开 | Generate 页签正确，旧默认模型及 per-model 参数仍加载，存储键不变 |
| N13 | 保存输出为 Dataset、查看来源、导出评估表 | 新说明和表头无旧节点称谓；旧 Dataset 不被自动改名 |
| N14 | Agent 创建、连接、改名、删除、运行、停止、查询历史 | 对用户称 Generate，工具调用仍用 run，卡片与界面操作同名 |
| N15 | 正常导出、缺配置导出及纯 Process 导出 | 产品诊断使用新称；原 CLI、文件结构、参数和数据列不变 |
| N16 | .yc 保存、重开、另存、合并、网页导入导出 | 不丢历史、资产、来源或 Executions，不因为改名触发重跑 |
| N17 | 教程正文、目录、caption、截图与旧锚点 | 文字图片一致，旧链接仍可打开 |
| N18 | 键盘/屏幕阅读器、菜单 tooltip、窄窗口和两种主题 | aria-label 已更新，按钮和菜单不截断，交互焦点不变 |

### 8.3 收尾检索

实施后至少进行两轮大小写不敏感检索：

```powershell
rg -n -i 'Execute|Create new run|Create Run|Run node|Run name|Run prompt|upstream Run|Generate again|Run code again' app/src backend/agent docs/PIPELINE_GUIDE.md docs/AGENT_CAPABILITIES.md hub/main.py
rg -n -i 'Run result|Run row|Run input|Run output|Settings.*Run|default Run|\brunName\b|\blinked\.type\b|\bsavedFrom\.kind\b' app/src backend/agent hub/main.py
rg -n 'Run|Execute' backend/pipeline_compile.py backend/pipeline_export.py backend/pipeline_export_spec.py backend/pipeline_runner.py backend/main.py
```

每个剩余命中要归类为：内部协议、正常运行语义、用户数据/历史文字、解释旧称的兼容说明、待修界面文字。不能以“全文零个 Run”作为验收标准。

再跑前端完整已有测试、相关后端测试、前端构建以及 N01–N18 的界面与兼容检查。构建输出到临时目录，不覆盖用于部署的 app/dist。此调查阶段未实施代码改名，也未把文档里的旧测试通过记录当作本次验证结果。

## 9. 建议实施顺序

1. 确定并集中命名映射与旧默认名规则，先保持所有内部协议不变。
2. 修改全部创建入口、节点标题、详情按钮、设置和连接提示。
3. 修改规划、执行记录、History、Evaluate/Optimize 引用和保存数据说明。
4. 同步 Agent 展示、提示词、全部指南和后端用户可见诊断。
5. 更新现行文档，并以附注说明历史设计记录中的旧称。
6. 运行测试、构建、旧项目往返和实际界面检查，之后采集新截图。
7. 按命中分类清单做最终检索。截图、Agent 和旧项目兼容均完成，才将此次命名变更标为完成。

调查阶段只新增本文；用户随后授权实施。实施没有修改原始用户项目或重写历史，没有提交或推送。

## 10. 实施记录（2026-10-16）

### 10.1 已完成

- 新增 `app/src/nodeLabels.js`，集中处理 Generate 类型标签、精确旧默认名 Run 的显示兼容及默认名识别；内部类型仍为 run。
- 新建入口、画布、详情、设置、连接提示、计划、执行记录、评估、历史和结果保存使用新称。Generate/Process/代码匹配的开始及再次运行按钮统一为 Run / Run again，停止与恢复状态保留独立含义。
- Agent 预览、摘要、自然语言类型、工具描述、系统提示与全部指南同步；工具名和参数不变。旧对话中的 Run/Execute 作为旧称理解。
- 编译、导出及 Runner 的节点诊断同步；API 路径、存档类型、字段、评分行键、结果 ID 和执行语义保持原样。
- 当前指南使用新名称，并修正对应教程中已经过时的“窗口内选择输入”与旧 Process 操作说明。历史设计文档加命名更新说明，不改写当时的实施事实。
- 重新采集 README 主图，以及 canvas-connected、run-progress、run-results、llm-settings、review-method-picker、agent-assistant、process-node、process-context-menu 共 8 张指南截图，合计 9 张。截图由真实前端组件渲染，模型结果使用模拟数据，不发生付费调用。

### 10.2 验证与实际边界

- 前端现有回归及兼容用例：393 项通过。补充覆盖旧默认名与新建名称去重、历史签名/结果引用不变、Run 2 / Runx1 extraction 等自定义名保持原样。
- 后端完整现有测试：148 项通过；前端 Vite 构建通过，输出在 `.cache`，未覆盖 `app/dist`。
- 无头 Chrome 检查：桌面菜单和网页入口、新旧默认名、原始 runName/type 保留、两种 Run 菜单、Generate/Process 按钮、Settings、Evaluate、Prompt 创建、运行中 Stop、窄窗口与自定义名称；没有浏览器错误。
- 只读打开真实旧示例项目，4 个旧默认 Run 节点均显示 Generate；序列化读取时节点 ID、type: run 和原始 runName 仍与源项目一致。原 `.yc` 文件未修改。
- 界面检查通过本地预览和模拟 API 完成；没有安装新的原生桌面包，也没有做真实模型调用或远端部署验证。
- 测试和构建日志在 `.cache/generate-rename-*`。最终保留的 Run 命中属于运行动作、内部协议、技术日志、用户数据或解释旧称的兼容说明。

打包安装、发布和推送不属于此次命名修改，尚未执行。
