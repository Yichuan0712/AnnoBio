# 画布节点模型：评审与改进建议

状态：讨论中，除 §1 外均未实施。基于 2026-10-01 `feat/pipeline-execution`（`7401218`）的代码。§1 的修复见提交 `c9cf730`。

本文记录对七种画布节点（Dataset、Sampler、Process、Prompt、Run、Score、Review）设计的评审意见，按条讨论，确定后再实施。每条都区分两类问题：

- **缺陷**：已经造成具体后果，例如丢数据、出现矛盾状态。
- **取舍**：原设计有它的理由，但代价值得重新权衡。

实施某条时，更新它的状态并补充实现记录。

## 总览

| # | 问题 | 类型 | 状态 |
|---|---|---|---|
| 1 | 撤销会把运行结果一起回退 | 缺陷 | 已修复（`c9cf730`）；序列化开销待议 |
| 2 | 依赖关系有两套表示 | 缺陷（允许矛盾状态） | 待讨论 |
| 3 | Dataset 一身多职，副本不知道自己过期 | 取舍 | 待讨论 |
| 4 | Score 替 Review 存配置 | 取舍 | 待讨论 |
| 5 | Run 的"模型"其实是一条凭据 | 取舍 | 待讨论 |

## 1. 撤销与运行结果

### 现象

依次操作：给 Prompt 改名 → 跑完一个 Run → 撤销改名。改名被撤回，Run 的结果也没了，重做也回不来。撤销会触发自动保存，没有结果的状态因此被写进项目文件。用户手动清掉的结果，撤销时反而会"复活"。Process、Score、Review 的结果也有同样的问题。

### 原因

撤销快照是整个画布状态，包含运行结果。运行结果虽然被标为"易变字段"（`VOLATILE_FIELDS_BY_TYPE`），但这个标记只用于判断状态是否变化，恢复快照时并不排除这些字段。

### 修复（已完成，`c9cf730`）

改动在 `app/src/undoHistory.js`：

- 撤销快照只保存用户编辑的配置，不再包含运行结果。
- 另外按节点 ID 记录每个节点最新的运行结果。撤销或重做前先读一次当前画布，再把这些结果合并回恢复出来的节点。
- 节点被删除后仍保留它最后的结果，所以撤销删除、或撤销新建后再重做，节点都会带着结果回来。

撤销后的规则：撤销只改配置，结果始终是最后一次实际运行的输出。这与"跑完之后再改配置"是同一种情况。

`app/tests/undoHistory.test.mjs` 的 6 个测试中，有 5 个在旧代码上会失败。

### 剩余问题：每次画布变化都做全量序列化（待议）

- `renderer.js` 在每次 `workflow:canvas-changed` 时调用 `undoHistory.push(getCanvasState())`。Run 流式返回结果时，每次部分更新也会触发。
- `getCanvasState()` 每次都会克隆所有 Dataset 内容，并对每个 Run 解析 `runResults`、重新嵌入输入行（`embedInputRow`），然后再序列化一次，用来判断状态是否变化。
- 撤销栈最多保存 50 份快照，每份都带着全部 Dataset 内容。

可选方向：

1. 推送撤销快照前先去抖，或者只在用户编辑时推送；按撤销之前要先把待推送的快照写入。
2. `getCanvasState()` 不要每次调用都重新嵌入输入行。
3. 快照之间共享未变化的 Dataset 内容（结构共享，或按内容哈希去重）。

## 2. 依赖关系有两套表示

### 现状

| 关系 | 存法 |
|---|---|
| Prompt→Run、Run→Score、Score→Review、Prompt→Prompt（版本） | 连线 |
| Run 读哪个 Dataset | Run 上的字段 `runWorkingSetId`，再画成只读线 |
| Score 的 ground truth | Score 上的字段 `scoreGroundTruthId`，再画成只读线 |
| Dataset 来自哪个 Run | Dataset 上的字段 `sourceRunNodeId`，再画成只读线 |
| Dataset 来自哪个 Process 分支 | 连线 `process-to-dataset`，分支名却是 Dataset 上的字段 `processOutputName` |
| Process 的输入 | 连线 `dataset-to-process`，另有字段 `primaryDatasetId` 和 `datasetAliases` |

只读线由 `workflowCanvas.js` 的 `getDerivedDataFlowEdges()` 生成，Process 的输入连线由 `syncProcessDependencies()` 根据代码引用重新生成。

### 后果

- **允许矛盾状态**。例如一个 Dataset 可以同时有 Run 来源和 Process 来源，编译器为此专门检查 `MULTIPLE_PRODUCERS`；多输出 Process 的分支名不在连线上，所以还要检查 `MISSING_BRANCH_NAME`（`backend/pipeline_compile.py` 的 `link_producers`）。
- **每个读画布的模块都要把两套表示对照一遍**，包括画布、Pipeline 检测、编译器、Agent 的 changeSet 和 inspector。

### 建议：每种依赖只存一处

- **单值关系存成字段**：Run 的输入、Score 的 ground truth、Dataset 的来源。Dataset 的来源合并进 §3 的 `origin` 字段。
- **多值关系存成连线，属性放在连线上**：Process 的每个输入是一条连线，带 `alias` 和"是否主输入"；Process 的每个输出也是一条连线，带分支名。之后删除 `primaryDatasetId`、`datasetAliases`、`processOutputName` 这三个重复字段。
- **画布上看到的线全部由这唯一来源生成**。
- 读取旧项目时把旧字段换算成新表示，保存时只写新表示。

### 待讨论

- 是否允许用户手动连线、改线？目前所有连线都由系统维护。
- 这一条和 §3 的 `origin` 是否合并成一次改动？

## 3. Dataset 一身多职

### 现状

同一种节点承担四种角色：原始输入、Run 结果的快照、Process 某个输出分支的"位置"、Sampler 的子集。保存的 Dataset 是建立时拷贝的静态副本（`workflowCanvas.js` 的 `workflow:add-dataset-node` 处理逻辑）。上游重新运行后，没有任何代码会更新它，也不会把它标成过期。

后果：

- 用户很难一眼看出一个 Dataset 是原始数据，还是某次结果的副本，以及它是否已经过期。
- 下游 Run 读的是上次保存的快照，不是上游的最新结果。整条 Pipeline 的 Runner 为此明确忽略中间 Dataset 的内容。

### 第一步（改动小，建议先做）：写清来源，让"过期"看得见

- 用一个 `origin` 字段替代分散的 `sourceRunNodeId`、`processOutputName`、`samplerNodeId`。内容包括：来源类型（导入 / Run / Process / Sampler）、来源节点 ID、分支名、保存时上游结果的版本号。读取时兼容旧字段。
- Run、Process、Sampler 每产生一次新结果，版本号就加 1。
- Dataset 记录的版本号与上游当前版本不一致时，节点上显示"已过期"，并提供"用最新结果更新"。Agent 通过同一个操作完成更新。
- 派生出来的 Dataset 用不同的图标或标题样式，写明"来自 Run X"。

运行语义不变，下游仍读快照，只是过期变得可见。

### 第二步（大改，建议与面板的 Pipeline 运行入口一起做）：把位置和快照分开

- Run 和 Process 直接提供输出端口，下游节点连到端口，不再需要中间 Dataset。
- "保存为 Dataset"变成明确的冻结操作，得到独立快照，不再充当 Pipeline 中的位置。
- 这与 Runner 的现有模型一致：它把中间 Dataset 当作逻辑位置。
- 代价：Pipeline 检测、编译器、Run 的输入选择、Agent 的 `save_run_results` 都要改。

### 待讨论

- 版本号用递增计数还是结果内容的哈希？哈希能识别"重跑后结果相同"的情况。
- "用最新结果更新"是覆盖原 Dataset，还是另存一份？
- 下游 Run 准备使用一个已过期的 Dataset 时，是否提醒？

## 4. Score 替 Review 存配置

### 现状

- Review 的方法、模型、目标 section 和参数（`reviewMethod`、`reviewCredentialId`、`gepaTargetSectionIndex`、`reviewSettings`）都存在 Score 节点上，发起 Review 时从 Score 读取（`workflowCanvasRuntime.js`）。Review 节点只存结果。
- Score 上的字段 `reviewResult` 实际存的是比较行（`comparison_rows`），名字和内容对不上。
- 想并排比较两种 Review 方法，只能在两次运行之间去改 Score 的设置。

### 建议

- **配置搬到 Review 节点**。Score 只管打分：ground truth、匹配规则或代码、排除的行、比较结果。
- **新建 Review**：从 Score 新建时，按 Settings → Review defaults 预填，或者复制该 Score 上一个 Review 的配置。之后每个 Review 用自己的配置运行。并排比较就是在同一个 Score 下建两个 Review。
- **卡片显示**：Review 节点卡片上显示所用的方法和模型。
- **字段改名**：Score 的 `reviewResult` 改为 `scoreComparison`，读取时兼容旧名。撤销模块中 Score 的易变字段名同步更新。
- **旧项目迁移**：把 Score 上的配置复制到它下面还没有配置的 Review 节点。方法优先取结果中已记录的 `review_method_id`，因为那才是实际用过的方法。
- **Agent 同步**：`review` job 可以指定方法、模型和参数，`update` 也能修改 Review 的配置。目前 Agent 只能改 `review_method`，改完后与用户界面一致。

代价中等，涉及 Score 和 Review 的对话框、发起 Review 请求的代码、存档迁移，以及 Agent 的 changeSet、tools 和 inspector。

### 待讨论

- 新 Review 的默认配置从 Settings 取，还是复制上一个 Review？
- 重新运行一个已有结果的 Review，是覆盖结果，还是新建一个 Review？

## 5. Run 的"模型"其实是一条凭据

### 现状

- 一条凭据同时包含模型、API key 和 base URL（`backend/main.py` 的 `CredentialCreate`）。用同一个 key 比较 3 个模型，就要建 3 条凭据，key 也存了 3 份；换 key 或吊销 key 时要逐条更新。
- OpenRouter 的"Add model"流程会先把明文 key 读到浏览器，再复制一份去建新凭据（`settingsModal.js` 中读取 `/api/credentials/{id}` 后 POST 新凭据的那段逻辑）。

### 建议：拆成"连接"和"模型"

- **连接**：服务商 + API key + base URL，一个 key 只存一份。
- **模型**：在用到的地方单独选。Run 存"连接 ID + 模型"，Review 和 Agent 也一样。Settings 中的默认值按用途分别设"默认连接 + 默认模型"。
- **选模型**：OpenRouter 用已有的模型目录；其他服务商能获取模型列表就列出来，否则手填并验证。
- **检查结果**：key 是否有效记在连接上；"能否驱动 Agent 的工具调用"跟模型有关，记在"连接 + 模型"上。
- **迁移**：provider、key、base URL 都相同的旧凭据合并成一个连接。旧凭据 ID 保留为"连接 + 模型"的别名，旧项目中的 `runCredentialId` 等字段仍能解析。
- **好处**：
  - 比较模型只需换下拉框，或再加一个 Run；
  - 换 key 只改一处；
  - 前端不再需要读明文 key。

代价最大，涉及后端凭据存储、所有 Run / Review / Agent 调用、设置界面、存档格式、Agent 工具和 Python 导出。

### 待讨论

- 非 OpenRouter 服务商的模型列表从哪里来？
- `GET /api/credentials/{id}` 是否还需要返回明文 key？

## 建议顺序

| 顺序 | 项目 | 代价 | 收益 |
|---|---|---|---|
| 1 | §3 第一步：来源 + 过期提示 | 小 | 直接解决"看不出是不是旧数据" |
| 2 | §4 Review 配置搬到 Review 节点 | 中 | 能并排比较 Review 方法 |
| 3 | §5 凭据拆成连接 + 模型 | 大 | 消除核心场景"比较模型"的摩擦 |
| 4 | §2 依赖只存一处，§3 第二步 | 大 | 去掉矛盾状态，画布与 Runner 对齐；与面板运行入口一起做 |

每项单独提交。每项都会改存档格式，所以都要带上旧项目迁移和测试。

## 附：本次评审中发现的其他待议事项

以下不属于节点设计本身，但都与"Agent 能做的事和用户一致"有关，一并记录：

- **Agent 独有**：`search_source` 可以按关键词检索 PubMed、ClinicalTrials.gov、ChEMBL；用户界面只能粘贴 ID 导入。建议给导入界面加搜索（后端接口已有），或者从 Agent 中移除这个工具。
- **Agent 独有（差别小）**：`try_process` 能在前 N 行上试跑代码且不改动画布；用户只有 Run，跑完会把输出存到节点上。
- **用户独有**：Export Python Project。Agent 不能导出。
- **用户独有**：Review settings（Max tokens、Max failed inputs、各方法参数、目标 section）。若实施 §4，在 Review 节点上一并补齐。
- **运行历史清理**：与面板的 Pipeline 运行入口一起设计，已记入 [PIPELINE_EXECUTION_PLAN.md](PIPELINE_EXECUTION_PLAN.md) 的 P1.4。
