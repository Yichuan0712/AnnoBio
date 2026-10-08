# 步骤间数据流：设计

状态：方向已定，未实施。基于 `261006-pipeline-runs` / `ed4672f`。

本文落实 [NODE_MODEL_REVIEW.md](NODE_MODEL_REVIEW.md) §2（依赖只存一处）和 §3 第二步（把位置和快照分开）。实施后，下列文档中的对应内容由本文取代：

- [RUN_HISTORY_PLAN.md](RUN_HISTORY_PLAN.md) 中与派生 Dataset 有关的部分：“Dataset 的签名”中的派生 Dataset、“下游跟随”中的派生 Dataset 写回、“已定”第 5 条、“迁移”中的派生 Dataset；
- [PIPELINE_EXECUTION_PLAN.md](PIPELINE_EXECUTION_PLAN.md) P1.4 中“运行结束后把副本加到画布、下游改连副本”的做法。

已定的前提：

- 这是破坏性更新，不为旧项目做迁移，只保证旧项目能打开、数据不丢（§9）。
- 旧格式的 History 迁移代码一并删除（2026-10-07 定）：`runHistoryMigration.js` 整个文件，以及补录旧 Pipeline 运行的 `withCompatibleLegacyCanvas`（§9）。
- 上游 Run 有出错行时，下游可以单独运行，窗口提示出错行数；Run Pipeline 照旧在出错时停止（2026-10-07 定，§3.7）。
- Agent 暂不同步，只做最低限度的适配，并列出受影响的工具（§10）。

## 1. 目标

Run、Process 这些执行节点之间直接连线，数据沿连线流动，和 Prompt → Run → Score → Review 一样。搭 Pipeline 时不再需要先生成一个 Dataset 才能接下一步。

- 各节点“生成 Dataset”的功能全部保留，生成的是冻结的拷贝，不再是 Pipeline 中的一环。
- Dataset 节点保留，作为数据入口：Run 可以直接读它，从它出发可以接 Process 和 Sampler。
- 中间数据不能原地修改。要改就先存成 Dataset，在 Dataset 上改，下游改读这份 Dataset。

核心原则是**数据只存一处**：画布只存结构，即节点配置、连线，以及每个节点当前用的是哪条记录；步骤产生的数据只存在 History 记录里（§3.1）。History 能大幅简化，根本原因就在这里（§4）。

## 2. 现状

### 2.1 Dataset 同时承担两种角色

Dataset 既是 Pipeline 中两个步骤之间的位置，又是某次结果的快照。

- **下游怎么读它**：Run 通过 `runWorkingSetId`；Process 通过 `dataset-to-process` 连线，主输入记在 `primaryDatasetId`，其他输入的别名记在 `datasetAliases`，并按 Dataset 名生成。
- **它从哪来**：Run 产出的记在 `sourceRunNodeId`；Process 产出的用 `process-to-dataset` 连线加 `processOutputName`；另有 `run-to-dataset-snapshot`、`process-to-dataset-snapshot` 两种快照连线。
- **是否跟随上游 History**：由 `savedCopy`、`snapshotSourceRecordId` 区分（`datasetHistorySource.js`）。
- **每次 Run Pipeline 结束后**：给每个产物新建一个 Dataset 副本，叠放在原节点上，再把下游改连到副本（`workflowCanvas.js` 的 `publishPipelineRun`）。

示例 `examples/Kinase–Substrate Evidence Curation.yc` 有 12 个 Dataset，其中只有 `kinase_abstracts` 是源数据。跑过 Pipeline 的副本项目（`... - repaired - Copy.yc`）有 34 个 Dataset，其中 22 个是 Pipeline 副本。

### 2.2 同一份中间数据存了好几份

一个步骤的输出，现在同时存在于：

1. 画布上 Dataset 节点的 `datasetContent`（每次 Run Pipeline 还会再加一个副本）；
2. 产出它的步骤的 History 记录；
3. 读它的下游记录的输入快照（`inputs.dataset.content`、Process 的 `inputs.bindings[].content`）；
4. Pipeline 运行时，Runner 的产物文件（`backend/data/pipeline_runs/`）。

前两份必须保持一致，History 的复杂度大多来自这里：

- **“哪个 Dataset 是某个步骤的当前输出”写了三遍**：画布的 `liveHistoryOutputIds()`（决定画实线还是虚线），`runHistorySelection.js` 中切换记录后重设输出连线的部分，`runHistoryPresentation.js` 的 `exportedDatasetNames`。
- **“这个 Dataset 是谁产出的”至少写了六处**：`datasetHistorySource.js`，`runHistoryPresentation.js` 与 `runHistorySelection.js` 各自的 `datasetProducer`，`liveHistoryOutputIds()`，`runHistoryMigration.js`，编译器的 `link_producers`。
- **切换 History 时要写回内容、改画布连线**：把派生 Dataset 的内容换成上游记录的输出，并在 `process-to-dataset` 与 `process-to-dataset-snapshot`、`sourceRunNodeId` 与 `run-to-dataset-snapshot` 之间来回切换。
- **上游关系有三种写法**：记录的 `sourceRecordIds`、输入快照的 `sourceRecordId`、`upstreamPipelineRecordId`。此外还要靠 `publishedPipelineCopy` 把旧记录对应到画布上的 Pipeline 副本。

### 2.3 底层已接近数据流

- History 中派生 Dataset 的签名是“节点 ID + 来源记录 ID + 分支名”，内容由上游当前记录现算（`runHistoryResolver.js` 的 `resolveDataset`）。Dataset 节点在这里只起转发作用。
- 编译器和 Runner 把中间 Dataset 当作逻辑位置，而且已经支持不挂 Dataset 的产物 `output:<job>:result`（`backend/pipeline_compile.py` 的 `link_producers` 末尾）。
- Score 直接读 Run，不经过 Dataset。

## 3. 新模型

### 3.1 数据存在哪

| 数据 | 存在哪 | 说明 |
|---|---|---|
| 源数据，以及手动存出来的 Dataset | 画布上的 Dataset 节点 | 按内容签名，被下游用来产出结果后锁定，不跟随任何东西 |
| 步骤产生的数据 | 只在产出它的 History 记录里 | 下游记录只存引用（§3.8） |
| 画布 | 只存结构 | 节点配置、连线、各节点的 `historyRecordId` |
| Run/Process 节点上的当前结果 | 画布上的缓存 | 由 History 推出，只读；本次保留（§3.9） |
| Pipeline 运行的产物 | Runner 产物文件，导入后进入 History 记录 | 两份存储，本次不改（§12） |

画布上不再有需要和 History 保持一致的数据。

### 3.2 节点角色

| 节点 | 数据输入 | 数据输出 |
|---|---|---|
| Dataset | 无 | 自身内容 |
| Sampler | 一个 Dataset（不变） | 生成的子集 Dataset（不变） |
| Prompt | 无 | 不参与数据流，通过 `prompt-to-run` 供 Run 使用（不变） |
| Run | 一个来源：Dataset、Run 或 Process 的某个分支 | 一个输出，即结果表 |
| Process | 一个或多个来源，类型同 Run；其中一个是 `df` | 每个分支一个输出（§3.4） |
| Score | Run（`run-to-score`），Ground truth 是 Dataset（均不变） | 不参与数据流 |
| Review | Score（不变） | 不参与数据流 |

Run 的结果表和 Process 的分支表，与现在 Save results / Create dataset 生成的内容相同：Run 是 `Input: …` / `Output: …` 列（`buildRunResultsTable`），Process 是 `dfResults.outputs[分支]`。

### 3.3 数据流连线

Run 和 Process 的所有数据输入只用一种连线表示：

```json
{ "type": "data", "fromId": "<Dataset / Run / Process>", "fromPort": "result", "toId": "<Run / Process>", "alias": "df" }
```

- `fromPort`：Dataset 和 Run 固定为 `result`；Process 是分支名，单一输出时也是 `result`。
- `alias`：只在 `toId` 是 Process 时出现。`df` 表示主输入，其他是 `df_<名字>`（§3.5）。
- Run 恰好有一条输入连线；Process 至少一条，其中恰好一条的 `alias` 是 `df`。
- 不允许成环。选择器不会列出节点自己及其下游。

被这条连线取代、随后删除的有：

- Run 的 `runWorkingSetId`，以及由它派生的 `dataset-to-run` 线；
- `dataset-to-process` 连线、`primaryDatasetId`、`datasetAliases`；
- Dataset 上的 `sourceRunNodeId`、`processOutputName`、`savedCopy`、`snapshotSourceRecordId`、`resultMissing`、`pipelineRunId`、`pipelineLogicalId`；
- `run-to-dataset`、`run-to-dataset-snapshot`、`process-to-dataset`、`process-to-dataset-snapshot` 四种连线。

保存出来的 Dataset 记录自己从哪来，改用 §3.6 的 `savedFrom` 字段。

### 3.4 Process 的输出分支

后端用 Python `ast` 识别分支。Process 代码一有变化就调用（来自窗口、Agent、撤销或打开旧项目都算），结果连同代码哈希记在节点上，代码没变就不重复调用。

- 新增接口 `POST /api/process/outputs`，请求 `{code}`，返回 `{ports: [...]}`、`{dynamic: true}` 或语法错误。解析在后端自身的 Python 中进行，不启动用户配置的解释器。
- 只看顶层 `def process` 自己的 `return`，跳过嵌套的函数、类和 lambda。
  - 所有 return 都是键为字符串常量的字典字面量：分支为这些键的并集，按首次出现的顺序排列。
  - 所有 return 都不是字典字面量：单一输出 `result`。
  - 二者混用、字典的键不是常量、字典用了 `**` 展开：动态输出。
- 有当前运行记录时：一次运行只会返回代码中某一个字典，所以实际分支都在识别结果里时，仍提供识别出的全部分支；运行返回了识别结果里没有的分支（说明识别不准，例如 `return out` 返回的其实是字典），改以实际分支为准，并在节点上显示提示。识别为动态时，以实际分支为准。
- 动态输出在第一次运行前没有分支可连，界面提示先运行一次。
- 下游连到的分支不存在时（代码改了，或运行时没返回）：这条线标红，下游节点不能运行，Run Pipeline 编译报错。连线不会被自动删除。

用示例项目验证（2026-10-07）：

| Process | 识别结果 |
|---|---|
| Check UniProt availability | `ready_for_uniprot_matching`、`needs_name_rewrite` |
| Resolve chosen accessions | `needs_full_text_site_extraction`、`missing_full_text` |
| Tidy extracted pairs、UniProt search、Combine UniProt candidates | `result` |

UniProt search 中辅助函数的 `return "\n".join(lines)` 被正确忽略。

### 3.5 别名

Process 的其他输入在代码里是 `process(df, df_x, ...)` 的参数，参数名就是别名。

| 来源 | 别名 |
|---|---|
| Dataset | `df_<Dataset 名>`（不变） |
| Process 的分支 | `df_<分支名>` |
| Process 的单一输出 | `df_<Process 名>` |
| Run 的输出 | `df_<Prompt 名>`。Run 默认都叫 “Run”；Current Pipeline 也用 Prompt 名称呼 Run |

- 名字按现有规则规范化（`processDatasetBindings.js` 的 `baseName`），重名时加 `_2`、`_3`。
- 现在 Process 的其他输入不是一个单独存的列表，而是由代码决定：选择器列出画布上所有可用的 Dataset 及其将来的别名，勾选会改写 `process()` 的参数，`syncProcessDependencies` 再按代码引用的别名重建输入连线。新模型沿用这一机制，只是候选来源加上步骤输出（不含节点自己及其下游），每个候选都先有一个确定的别名。
- 一个来源成为输入时，别名固定下来存在连线上，之后上游改名不影响它。
- 在选择器里给一个输入换来源时，保留原来的别名，代码不用改。这也是旧项目改成直连时最省事的路径（§9）。
- 第一版不提供手动修改别名。

### 3.6 保存出来的 Dataset

Run 的 Save results to workspace、Process 的 Create dataset / Create branch datasets、Score 的 Save results to workspace，都生成普通 Dataset，并带上 `savedFrom`：

```json
"savedFrom": { "kind": "run|process|score|pipeline", "nodeId": "...", "port": "result", "recordId": "...", "pipelineRunId": "..." }
```

- 字段名用 `savedFrom` 而不是 `origin`：画布上已有 `nodeOrigin` 字段（标记 Agent 创建的节点），名字太接近容易混淆。
- `savedFrom` 只用于显示：节点说明中写明来源；来源节点仍在画布上时，画一条来源线（§5.1）。History 列表显示“这条记录的输出存成了哪些 Dataset”时，按 `savedFrom.recordId` 查找。
- 同一种保存只有一个实现，生成的表格相同。现在 Run 的 Save results 从右键菜单点和从 Run 窗口点结果不同：右键菜单生成的表没有输入列，也不记录来源；Score 的三处保存都不记录来源。实施时统一为一个函数，Run 的表格与 §3.2 的 Run 输出表相同。
- Pipeline 检测、编译器和 History 签名都不读 `savedFrom`。这份 Dataset 被下游读取时，就是一条新 Pipeline 的入口。
- 签名、内容锁定和编辑规则与其他 Dataset 相同：签名按内容计算；被下游用来产出结果之前可以修改，之后锁定（`contentLocks.js`）。
- Sampler 生成的子集保留 `samplerNodeId`，行为不变。以后可以并入 `savedFrom`。

### 3.7 输入解析与单节点运行

新增一个统一函数，把输入连线解析成表格：

- 来源是 Dataset：读它的内容。
- 来源是 Run 或 Process：读上游当前记录对应端口的输出表，用 `runHistoryResolver.js` 现有的 `runTable` / `processTable`。

窗口、Agent、History resolver 都调用这个函数，代替现在直接读 `datasetContentByNodeId.get(runWorkingSetId)` 的地方。

上游的当前记录不是“已完成”（没有记录、运行中、已停止、失败）时，下游显示“等待上游结果”，Run 按钮不可用，提示先运行上游或使用 Run Pipeline。

上游 Run 已完成但有出错的行时（出错的行算已处理、不重试，记录仍是已完成）：

- 单节点运行时，下游可以运行。出错的行照常传下去，输出列中是错误信息，与现在 Save results 生成的表相同。下游窗口提示 “上游 <名字> 有 N 行出错”。
- Run Pipeline 不变：Runner 只要有出错行就让这个 job 失败，下游不执行。两者不一致是有意的：手动运行时由用户自己判断，整条运行时保守处理。

### 3.8 History 记录

**签名**

- **来源是 Dataset**：签名的内容和字段名保持不变，即 `runInputSignature` 的 `datasetNodeId` + `datasetSignature`，以及 `processInputSignature` 中按 Dataset 计算的绑定。这样旧项目里读 Dataset 的节点，现有记录仍然能对上。
- **来源是步骤**：签名为 `sha256({kind: 'step-output', nodeId: 上游节点, recordId: 上游当前记录, port})`。Process 的绑定以 `节点 ID:端口` 作键，排序和指定主输入都用它，因为同一个 Process 的两个分支可能同时是输入。
- `datasetSignature` 中“派生 Dataset”的分支删除。

**记录中的输入**

Run 记录的 `inputs.dataset` 和 Process 记录的每个 `inputs.bindings[]` 统一为一种来源格式（字段名不变，只加 `kind`）：

```json
{ "kind": "dataset", "nodeId": "...", "name": "...", "content": { }, "signature": "..." }
{ "kind": "step", "nodeId": "<上游节点>", "port": "result", "recordId": "<上游记录>", "signature": "..." }
```

- Dataset 来源仍保存内容快照。之后切换回这条记录时，如果源 Dataset 被改过，要靠这份快照检查冲突或恢复内容。
- **步骤来源只存引用，不复制表格。** 上游记录不可修改；删除记录时，依赖它的下游记录会通过 `sourceRecordIds` 一起删除（`runHistoryDeletion.js` 的 `dependentHistoryIds`），所以引用不会悬空。一条 4 步的 Pipeline，中间结果现在要存两遍（产出记录一份，下游输入快照一份），改后只存一遍。
- Process 绑定另带 `alias`。`inputs.primaryDatasetId` 保留，值为 `df` 那个绑定的键（Dataset 来源是节点 ID，步骤来源是 `节点 ID:端口`），这样旧记录不用改。
- 读取旧记录时，没有 `kind` 的输入视为 `kind: 'dataset'`。

**上游关系只有一种写法**

- 上游记录 ID 只记在步骤来源的 `recordId` 中；记录顶层的 `sourceRecordIds` 由它们汇总，继续供删除级联使用。
- 删除的字段：输入快照的 `sourceRecordId`、`sourceNodeId`、`branch`、`upstreamPipelineRecordId`，以及 Score 记录的 `groundTruthSourceRecordId`。Ground truth 只能是普通 Dataset，不再有“派生的 Ground truth”。
- Pipeline 导入的记录与单节点运行产生的记录格式完全相同，只多一个 `pipelineRunId`。

**切换与跟随**

- 选一条记录时上游一起切（RUN_HISTORY_PLAN 已定第 4 条）：沿步骤来源的 `recordId` 直接追到上游记录，不再经过 Dataset 和 `publishedPipelineCopy`。
- 切换只改各节点的 `historyRecordId` 和输入连线，不再写回 Dataset 内容，也不再改输出连线。
- 下游跟随不需要专门处理：上游换了记录，下游签名随之改变，自动找到对应的记录，找不到就显示“没有结果”。
- 同一个上游被要求同时切到两条不同记录时，仍然拒绝并说明冲突节点，这一点不变。

### 3.9 节点上的结果缓存

Run/Process 节点仍在画布状态中缓存当前记录的结果：`runResults`（`getCanvasState()` 还会把输入行嵌入每行结果）、`runInputContent`、`dfResults`。这份缓存由 resolver 从 History 写回，用户不能编辑，所以不存在一致性问题，本次保留。

以后可以单独去掉这份缓存，画布只存 `historyRecordId`，用到结果时再从 History 读取。这样还能顺带解决 [NODE_MODEL_REVIEW.md](NODE_MODEL_REVIEW.md) §1 遗留的问题：每次画布变化都全量序列化结果，撤销栈里每份快照都带着全部数据。代价是 Score 实时计算、各窗口、Pipeline 请求构建这些现在同步读节点字段的地方，都要改成异步读取。

## 4. History 的简化

中间数据不再存在画布上，History 不必再和画布上的数据保持一致。

| 现在 | 改后 |
|---|---|
| Dataset 有三种状态：跟随上游 History、保存的拷贝、Pipeline 副本 | 只有一种：普通的表 |
| “哪个 Dataset 是当前输出”写了三遍 | 输出就是节点的端口，不需要判断 |
| “这个 Dataset 是谁产出的”写了六处 | 删除；保存出来的 Dataset 只有显示用的 `savedFrom` |
| 切换 History 时写回 Dataset 内容，并改写输出连线 | 只改 `historyRecordId` 和输入连线 |
| 派生 Dataset 的“没有结果”状态及其向下游传播（`missingDatasetIds`、写入记录前的检查） | 删除；“没有结果”和“等待上游结果”只在 Run/Process 上 |
| 上游关系有三种写法，外加 `publishedPipelineCopy` 的映射 | 只有步骤来源的 `recordId` 一种 |
| 下游记录复制一份输入表 | 步骤来源只存引用 |
| Pipeline 导入的记录用发布副本作输入，格式与单节点记录不同 | 完全相同，只多 `pipelineRunId` |

不变的部分：

- 记录的存储和索引（Web 是独立文件，桌面是 `.yc` 中的 `history`），删除和级联删除，History 列表界面。
- 签名唯一性、按钮状态、Run 的 Resume、Process 的 Restart。
- 选一条记录时上游一起切，以及冲突检查。
- Score 和 Review 按完整输入归档。
- 节点上的结果缓存（§3.9）。

各模块的删减估计见 §8。

## 5. 界面

### 5.1 画布

- Process 节点右侧为每个分支显示一个端口标签，单一输出时不显示。Run 只有一个输出，不显示标签。
- 数据流线从产出节点（或它的端口标签）连到下游节点，不再经过 Dataset。
- 来源线（从来源节点指向保存出来的 Dataset）要和数据流线明显区分：细虚线、颜色较淡、不带箭头，悬停提示 “Saved from …”。它只表示来源，不参与 Pipeline，也不阻止删除来源节点；来源节点删除后线消失，Dataset 说明里的来源文字保留。
- 删除：表示“旧快照”的虚线边，以及 `liveHistoryOutputIds()` 对当前副本的判断。

### 5.2 右键菜单

| 节点 | 变化 |
|---|---|
| Run | 新增 “Run a prompt on results”：新建 Run，输入预填为这个 Run 的输出，Prompt 在 Run 窗口中选择。新增 “Process results with code”：新建 Process，`df` 预填为这个 Run 的输出。保留 Save results to workspace |
| Process | 新增同样两项，作用于输出。有多个分支时每个分支各列一项，例如 “Process 'needs_name_rewrite' with code”；点击端口标签弹出只含这个分支的同一菜单。保留 Create dataset |
| Dataset | 删除 “Save current source as new Dataset”，其余不变（Sample、Process with code、Duplicate、新版本、改名） |
| Prompt、Sampler、Score、Review | 不变 |

### 5.3 输入选择器

Run 窗口的 Input dataset 和 Process 窗口的 Input datasets 改名为 Input，分两组列出：

- Datasets：所有 Dataset。
- Step outputs：Run 显示为它的 Prompt 名；Process 的分支显示为 “Process 名 · 分支名”。不列出当前节点自己及其下游。

Process 窗口在每个输入旁显示它的别名，和现在一样。

## 6. Pipeline

### 6.1 检测与路线选择

- `pipelineDetection.js`：步骤之间沿 `data` 连线串联，Dataset 只作为入口出现。生产者冲突的诊断删除，因为结构上已不可能出现（删除 `pipelineProducerConflicts.js`）。
- `pipelineRouteSelection.js`：同一生产者的多个 Dataset 副本形成的“Dataset 备选项”不再存在。Prompt 版本和 Run 的备选项保留。分支、汇合的 lane 逻辑要用新的连线重新验证。

### 6.2 编译器

- Job 的输入直接来自 `data` 连线。
- 入口产物仍为 `dataset:<id>`；步骤输出为 `output:<job>:<port>`，现在的兜底写法变成唯一写法。
- `link_producers` 删除，`MULTIPLE_PRODUCERS`、`MISSING_BRANCH_NAME`、`INPUT_PRODUCER_CONFLICT`、`UNSELECTED_PRODUCER` 随之删除。
- Process 的输出端口取 §3.4 的识别结果。动态输出仍标为运行时校验（`RUNTIME_PROCESS_CONTRACT`）。

### 6.3 Run Pipeline 结束后

- `publishPipelineRun` 只做两件事：把成功的 job 导入节点 History，再把各步骤切到这次运行的记录。不再新建 Dataset，不再叠放位置、改连下游或改写别名，也不再把旧输出标成拷贝。
- `importPipelineRunHistory` 按 §3.8 的格式写记录：入口 Dataset 存内容快照，步骤来源存上游记录引用。原来输入快照的三条分支（发布副本、拷贝、派生 Dataset）和 `pipelineCopyInputs` 删除。
- `pipelineRunDefinition.js`：入口就是路线中 `data` 连线起点上的 Dataset，不需要再排除陈旧的中间 Dataset。

### 6.4 Run History 窗口

现在每个 Pipeline 卡片上有 Run History 按钮，打开一个只读的运行列表（状态、开始时间、运行 ID）。运行结束后结果自动加到画布；界面上没有删除运行的入口（`deletePipelineRun` 没有调用方）。注意：PIPELINE_EXECUTION_PLAN P1.4 中描述的 “Pipeline Runs 页签”、“Add results to canvas” 和逐条删除已不在代码中。

改后运行结束时自动导入记录并切换各节点（§6.3），Run History 窗口本身不变。以下两项可以以后再加，不在本设计范围（§12）：在 Run History 中对某次运行 “Show on canvas”；运行涉及的节点已被删除时 “Save outputs as Datasets”。

### 6.5 Export Python Project

入口仍按 Dataset 名命名。中间和最终产物改按“步骤名”或“分支名”命名，所以导出代码中的变量名和输出表名会变。

## 7. 功能变更清单

| 功能 | 现在 | 改后 |
|---|---|---|
| Run 的输入 | 只能选 Dataset | Dataset，或上游 Run 的结果、Process 的分支 |
| Process 的输入（`df` 和 `df_` 参数） | 只能是 Dataset | 同上，别名见 §3.5 |
| Process 的输出 | 先 Create dataset 才能接下游 | 节点上有输出端口，直接连 |
| Save results / Create dataset | 生成的 Dataset 带产出关系，Pipeline 穿过它 | 照样生成，画来源线；Pipeline 不穿过它，被读取时它是新入口 |
| Sampler 的 Create sample、Score 的 Save results | — | 不变（Score 保存的 Dataset 加上 `savedFrom`） |
| 修改中间数据 | 打开中间 Dataset 直接改 | 先存成 Dataset 再改，下游改读这份 |
| 单独运行下游节点 | 读 Dataset 当前内容，可能已过期 | 上游没有已完成的当前记录时不能运行 |
| Dataset 右键 “Save current source as new Dataset” | 有 | 删除 |
| 旧快照虚线边、Dataset 的“没有结果”状态 | 有 | 删除；“没有结果”和“等待上游结果”只出现在 Run/Process 上 |
| Run Pipeline 结束后 | 每个产物建 Dataset 副本，下游改连 | 不建 Dataset，只切换各节点的记录 |
| Run History 窗口 | 只读运行列表 | 不变 |
| Run 的 Save results（右键菜单与窗口） | 两处生成的表格和来源信息不同 | 统一为一个实现：表格含输入列和输出列，带 `savedFrom` |
| Current Pipeline、Run Pipeline 对话框 | 穿过中间 Dataset 识别，有生产者冲突诊断 | 沿 `data` 连线识别，入口只有 Dataset，无冲突诊断 |
| 切换 History | 下游派生 Dataset 写回内容，改写输出连线 | 只切换各节点的记录和输入连线 |
| History 列表中“输出存成了哪个 Dataset” | 按产出关系和副本状态推断 | 按 Dataset 的 `savedFrom.recordId` 查找 |
| Score 的 Ground truth | 可以是跟随上游的派生 Dataset | 只能是普通 Dataset |
| Export Python Project | 产物按 Dataset 名命名 | 中间和最终产物按步骤名、分支名命名 |
| 内容锁定 | 中间 Dataset 被用过之后锁定 | 中间 Dataset 不再存在；源 Dataset、保存出来的 Dataset、Prompt 照旧 |
| Score 读 Run、Sampler 读 Dataset | — | 不变 |

## 8. 删除或缩减的代码

行数为估计，只计删减，不含新增代码（分支识别接口、`data` 连线、输入解析函数、端口界面、`savedFrom`）。

| 位置 | 现在（行） | 改后约（行） | 删减内容 |
|---|---|---|---|
| `app/src/datasetHistorySource.js` | 57 | 0 | 整个文件 |
| `app/src/pipelineProducerConflicts.js` | 22 | 0 | 整个文件 |
| `app/src/runHistorySelection.js` | 342 | 190 | 重设输出连线、当前输出与快照的判断（`datasetSources`、`datasetProducer`、`setDatasetOutput`），`visitDataset` 的副本映射 |
| `app/src/runHistoryPresentation.js` | 114 | 65 | `inputLabel` 的副本映射、`datasetProducer`、`exportedDatasetNames` |
| `app/src/runHistoryResolver.js` | 206 | 150 | 派生 Dataset 的解析和“没有结果”传播；Process 输入不再遍历所有 Dataset 推断别名，直接读连线 |
| `app/src/runHistoryCapture.js` | 105 | 85 | 派生输入的签名分支 |
| `app/src/pipelineHistoryImport.js` | 218 | 80 | 输入快照的三条分支、`pipelineCopyInputs`、`withCompatibleLegacyCanvas` |
| `app/src/runHistoryMigration.js` | 243 | 0 | 整个文件 |
| `app/src/runHistorySession.js` | 310 | 260 | `open` 中的旧格式迁移、补录没有记录的结果、旧 Score/Review 缓存归档 |
| `app/src/runHistorySignature.js` | 60 | 55 | 派生 Dataset 签名 |
| `app/src/runHistoryDeletion.js` | 66 | 60 | `groundTruthSourceRecordId` |
| `app/src/runAnalysisHistory.js` | 93 | 80 | 派生 Ground truth 的签名和 `groundTruthSourceRecordId` |
| `app/src/workflowCanvas.js` 相关部分 | 约 250 | 约 30 | `publishPipelineRun` 的建副本和改连、`liveHistoryOutputIds`、`isHistorySnapshotEdge`、`pipelineResultPosition`、`save-current-source-copy`、编辑时转成拷贝、`getDerivedDataFlowEdges` 的 Run 输入部分 |
| `backend/pipeline_compile.py` 的 `link_producers` | 约 60 | 约 10 | 生产者推断及相关诊断 |

前端合计约 2,090 行减到约 1,060 行，后端另减约 50 行。

## 9. 旧项目

画布状态的 `version` 从 2 升到 3。打开 version 2 的项目时只做一次转换，不推断、不删除：

- 所有 Dataset 变为普通 Dataset。原来的产出关系（`sourceRunNodeId`、`process-to-dataset` 及两种快照连线）转换成 `savedFrom`，原有的旧字段删除。
- Run 的 `runWorkingSetId`、Process 的 `dataset-to-process` / `primaryDatasetId` / `datasetAliases` 转换成 `data` 连线，别名保持不变。
- 结果：旧 Pipeline 在每个中间 Dataset 处断成几段，每段仍可单独运行。要恢复成一整条，把下游改连到上游步骤（别名保留，代码不用改），再删除那个 Dataset。
- 运行结果：读 Dataset 的节点签名不变（§3.8），已有记录仍对得上。只有旧的“跟随 History”的输出（没有 `savedCopy`）改为按内容签名，它下游的节点可能显示“没有结果”，记录仍在 History 中。
- 旧记录中的派生输入字段（`sourceRecordId`、`upstreamPipelineRecordId` 等）不再读取；`sourceRecordIds` 保留，删除级联照常。
- Pipeline 留下的副本不自动删除，由用户自己删除。
- 改动之前产生、但还没导入画布的 Pipeline 运行（冻结定义中的中间产物是带生产者的 `dataset:` 产物），不再导入节点 History，只在 Run History 列表中保留记录。已经导入过的运行不受影响。
- 删除旧格式迁移代码后：
  - 从未启用 History 的老项目（画布没有 `historyVersion: 1`）打开时直接标记为已启用，不再把节点上的旧结果转成记录。这些节点、以及旧 Score/Review 的缓存结果都显示“没有结果”。
  - 把这样的老项目合并进来时，带过来的节点同样显示“没有结果”。
  - 没有冻结画布定义的旧 Pipeline 运行不再导入。

不做自动改连，是因为那需要判断拷贝是否等于上游当前结果、改写别名、为 History 重新签名，正是这次要删掉的复杂度。

## 10. Agent

完整同步以后再做。需要改的地方：

- `add_run`、`update`（run）的 `input_dataset`：改为通用输入来源（Dataset，或节点加分支）。
- `add_process` 的 `primary_input` 及其他输入、`update`（process）的 `primary_input`：同上。
- `save_run_results`、`save_process_output`：保留，产物带 `savedFrom`，不再串进 Pipeline。
- `inspect_node`、工作区摘要（`workspaceSummary.js` 的 `datasetLine`）：描述输出端口、输入来源和 `savedFrom`。
- `run_nodes`：上游没有已完成的当前记录时拒绝运行，错误信息和窗口一致。
- `select_history`：随 §3.8 的切换逻辑一起变，不再涉及 Dataset。
- `changeSet.js`：删除对 `process-to-dataset`、`sourceRunNodeId` 的处理，改为维护 `data` 连线。
- 系统提示中“先保存结果再接下一步”的说法。

不能推迟的最低适配：存储格式变化时，`changeSet.js` 不能再写旧字段。按 [DATA_FLOW_PLAN.md](DATA_FLOW_PLAN.md)，第 3、4 步让 `changeSet.js` 改用输入访问层，第 6 步切换存储时它自动写 `data` 连线；第 11 步改用 `savedFrom` 时，`save_run_results`、`save_process_output` 同步改写。Agent 先只支持 Dataset 作为来源；第 13 步之前 Agent 能做的事少于用户，发布说明中要写明。

## 11. 实施顺序

每一步要读的代码、要改的文件和函数、测试与验收标准见 [DATA_FLOW_PLAN.md](DATA_FLOW_PLAN.md)。概要：

| 步骤 | 内容 | 能否单独发布 |
|---|---|---|
| 0 | 删除旧格式的 History 迁移代码 | 可以 |
| 1 | 后端识别 Process 输出分支 | 可以 |
| 2 | Process 节点记录并显示分支 | 可以 |
| 3 | Run 输入访问层（纯重构） | 可以 |
| 4 | Process 输入访问层（纯重构） | 可以 |
| 5 | 编译器输入访问层（纯重构） | 可以 |
| 6 | 存储切换为 `data` 连线，画布格式 version 3 | 可以（文件格式升级） |
| 7 | 步骤来源：输入解析、History、单节点运行 | 可以（还没有界面入口） |
| 8 | 界面：选择步骤输出、右键菜单、端口连线 | 否 |
| 9 | Pipeline 沿 `data` 连线：检测、路线、编译、导出 | 否 |
| 10 | Run Pipeline 结束后只导入记录并切换 | 否 |
| 11 | 保存出来的 Dataset 改用 `savedFrom` | 否 |
| 12 | 删除派生 Dataset 逻辑，更新文档 | 第 8–12 步一起发布 |
| 13 | Agent 完整同步（§10） | 可以 |

## 12. 待定

- **节点结果缓存是否去掉（§3.9）。** 建议作为后续单独的改动。
- **Runner 产物和节点 History 是否合并存储。** 目前 Pipeline 运行的结果先存在 Runner 产物中，再导入 History 记录，是两份存储，本设计不改变。
- **Run History 窗口是否增加操作。** 例如对某次运行 “Show on canvas”（把各节点切到那次的记录），或运行涉及的节点已删除时 “Save outputs as Datasets”。
- **是否允许手动修改别名。**
- **Sampler 的 `samplerNodeId` 是否并入 `savedFrom`。**
