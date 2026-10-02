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
| 4 | Score 替 Review 存配置 | 取舍 | 不实施：改为去掉节点级设置，一律用 Settings 默认值（`507eba1`） |
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

同一种节点承担四种角色：原始输入、Run 结果的快照、Process 某个输出分支的"位置"、Sampler 的子集。保存的 Dataset 是建立时拷贝的静态副本（`workflowCanvas.js` 的 `workflow:add-dataset-node` 处理逻辑）。上游之后再变，没有任何代码会更新它，也不会把它标成过期。

保存之后，上游实际会不会变：

| 上游 | 保存后还会变吗 |
|---|---|
| Process | **会，这是主要来源**。改代码后再跑，输出会被覆盖。 |
| Run | 基本不会。Run 设计成一次性的：跑完后按钮变成 "Run completed" 并锁定，出错的行也算已处理、不会重试（`runDetailModal.js` 的 `refreshButton`）。只有一种情况：中途停下时保存了结果，之后又 Resume 跑完了。 |
| Sampler | 不会，每次都生成新的 Dataset。但旧 Dataset 显示的是 Sampler **当前**的抽样设置（`formatSamplerDescription`），设置改过之后，描述和内容就对不上了。 |

后果：

- 用户很难一眼看出一个 Dataset 是原始数据，还是某次结果的副本，以及它是否已经过期。
- 下游 Run 读的是上次保存的快照，不是上游的最新结果。整条 Pipeline 的 Runner 为此明确忽略中间 Dataset 的内容。

### 第一步（改动小，建议先做）：写清来源，让"过期"看得见

- 用一个 `origin` 字段替代分散的 `sourceRunNodeId`、`processOutputName`、`samplerNodeId`。内容包括来源类型（导入 / Run / Process / Sampler）、来源节点 ID 和分支名，再按来源类型记录下面各项。读取时兼容旧字段。
- **Process**：每跑一次，版本号加 1；Dataset 记下保存时的版本号。两者不一致时，节点上显示"已过期"，并提供"用最新结果更新"。Agent 通过同一个操作完成更新。
- **Run**：不需要版本号，只记录保存时 Run 是否已经跑完。没跑完就标"不完整"；Run 跑完后，同样可以"用最新结果更新"。
- **Sampler**：Dataset 记下生成时的抽样设置，描述改用这份记录，不再读 Sampler 当前的设置。
- 派生出来的 Dataset 用不同的图标或标题样式，写明"来自 Run X"。

运行语义不变，下游仍读快照，只是过期变得可见。

### 第二步（大改，建议与面板的 Pipeline 运行入口一起做）：把位置和快照分开

- Run 和 Process 直接提供输出端口，下游节点连到端口，不再需要中间 Dataset。
- "保存为 Dataset"变成明确的冻结操作，得到独立快照，不再充当 Pipeline 中的位置。
- 这与 Runner 的现有模型一致：它把中间 Dataset 当作逻辑位置。
- 代价：Pipeline 检测、编译器、Run 的输入选择、Agent 的 `save_run_results` 都要改。

### 待讨论

- Process 的版本号用递增计数，还是结果内容的哈希？哈希能识别"重跑后结果相同"的情况。
- "用最新结果更新"是覆盖原 Dataset，还是另存一份？
- 下游 Run 准备使用一个已过期的 Dataset 时，是否提醒？

## 4. Score 替 Review 存配置

### 现状

- Review 的方法、模型、目标 section 和参数（`reviewMethod`、`reviewCredentialId`、`gepaTargetSectionIndex`、`reviewSettings`）都存在 Score 节点上，发起 Review 时从 Score 读取（`workflowCanvasRuntime.js`）。Review 节点只存结果。
- Score 上的 `reviewResult` 不是名字取错的比较行字段，而是旧版本留下的 Review 结果副本（其中也有比较行）。当前代码只往 Review 节点写结果，只在兼容路径读取 Score 上的这份副本，例如打开一个没有结果的 Review 时从这里补。（初稿把它当成名字和内容不符的字段，实施时核实后更正。）
- 想并排比较两种 Review 方法，只能在两次运行之间去改 Score 的设置。

### 结论（2026-10-01）：简化，不再提供节点级设置

讨论中先后试过两种做法，都没有保留：
- 把配置搬到 Review 节点、新建时复制上一个 Review 的配置；
- 再进一步，把启动按钮移到 Review 窗口，像 Run 一样先建后跑。

最后决定简化：Run 和 Review 都不在节点上提供设置，模型、方法和各项数值一律使用 Settings → Run defaults / Review defaults。

- **Run 窗口**：只保留输入、列映射和 Run 按钮，去掉"Run settings"按钮和对话框。没有可用模型时，提示去 Settings 设置默认 Run 模型。
- **Score**：只保留"Review"按钮，去掉"Review settings"按钮和对话框。点"Review"会新建 Review 并直接运行；没有可用模型时，提示去 Settings 设置。Review 窗口不变。
- **Score 右键菜单的"Review"**：
  - 不再要求 Score 上先存有模型，没有时用 Settings 默认值；
  - 请求补上 `score_mapping`、方法、目标 section 和数值覆盖，和 Score 窗口一致。之前这条路径会漏掉这些字段，GEPA 这类需要 `score_mapping` 自行评分的方法会受影响。
- **Agent 同步**（用户做不到的，Agent 也不做）：
  - `add_run` / `update` 不再接受 Run 的 `credential_id` 和 `settings`；
  - `add_score` / `update` 不再接受 `review_method`；
  - 传入这些参数会明确报错，不会悄悄忽略。
- **代码**：设置对话框已删除。`nodeSettingsModal.js` 改为 `nodeSettings.js`，只保留读取节点上已存的数值覆盖，以及在节点首次用到时写入默认模型（Score 还会写入默认方法）。

需要知道的行为：
- 节点在第一次用到时（Run 窗口首次打开、Score 窗口首次打开或第一次发起 Review）记下当时的 Settings 默认模型，之后沿用。Run 有结果后会继续用同一个模型 Resume。要用另一个模型比较，就先改 Settings 默认值，再新建并打开新的 Run。
- 旧项目里节点上已存的模型、方法和数值覆盖仍然生效，只是界面上不再显示，也不能修改。

本节的问题（Review 的配置存在 Score 上）因此不再处理：用户不再按节点选择配置，配置放在哪个节点已经无关紧要。

## 5. Run 的"模型"其实是一条凭据

§4 简化后，Run 不再单独选择模型，下文"在用到的地方单独选模型"那部分已不适用。剩下的价值是一个 key 只存一份、换 key 只改一处，以及前端不再需要读明文 key，优先级相应降低。

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
| 2 | §5 凭据拆成连接 + 模型 | 大 | 一个 key 只存一份（§4 简化后不再用于按 Run 选模型） |
| 3 | §2 依赖只存一处，§3 第二步 | 大 | 去掉矛盾状态，画布与 Runner 对齐；与面板运行入口一起做 |

每项单独提交。每项都会改存档格式，所以都要带上旧项目迁移和测试。

## 附：本次评审中发现的其他待议事项

以下不属于节点设计本身，但都与"Agent 能做的事和用户一致"有关，一并记录：

- **Agent 独有**：`search_source` 可以按关键词检索 PubMed、ClinicalTrials.gov、ChEMBL；用户界面只能粘贴 ID 导入。建议给导入界面加搜索（后端接口已有），或者从 Agent 中移除这个工具。
- **Agent 独有（差别小）**：`try_process` 能在前 N 行上试跑代码且不改动画布；用户只有 Run，跑完会把输出存到节点上。
- **用户独有**：Export Python Project。Agent 不能导出。
- **已对齐**：Run 和 Review 的节点级设置用户和 Agent 都不再提供，一律用 Settings 默认值（见 §4 结论）。
- **运行历史清理**：与面板的 Pipeline 运行入口一起设计，已记入 [PIPELINE_EXECUTION_PLAN.md](PIPELINE_EXECUTION_PLAN.md) 的 P1.4。
