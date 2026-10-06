# Pipeline 执行体系：整体计划

日期：2026-09-30。代码基线：`main` / `0b257f9`。

状态：编译器、导出器、后端 Runner 和 Current Pipeline 面板运行入口已实现；面板运行历史列表与清理尚未完成，Agent 仍不能启动整条 Pipeline。多起点 Dataset 的 Python 导出已支持命名输入。其余 Phase 2 工作待实现。

本文记录实施范围、执行语义、阶段顺序和验收标准。勾选表示实际完成并验证，不表示仅完成讨论。按里程碑逐步实施代码。

## 1. 目标与当前边界

让用户选择 Current Pipeline 后，一次启动已有的无环数据流，自动传递中间结果，查看整体进度，并在失败后恢复。画布运行与 Python 导出使用同一份编译后的执行定义。

当前实现依据：

- `app/src/pipelineDetection.js`：识别 Dataset、Process、Prompt/Run 组成的图；将 Prompt 版本归为 family；只有包含已关联 Run 的 Prompt 才识别为 pipeline。
- `app/src/pipelineOverviewModal.js`：解析当前路线及选项。部分分叉是备选路径，部分分支汇合被展示为 lanes；不能据此推定任意 DAG 都已完整支持。
- `app/src/workflowCanvas.js`、`workflowCanvasRuntime.js`：节点状态、依赖字段、单节点执行与结果保存。
- `backend/main.py`：Run/Process 等后端任务；已有单 Run 持久化与恢复相关逻辑，应先核实并复用。
- `backend/process_df_exec.py`：执行 `process(df)`，其他输入以 DataFrame 别名提供，输出一个 DataFrame 或命名分支。
- `backend/pipeline_export.py`、`pipeline_export_dag.py`：分别处理线性路线和 DAG 导出；当前 DAG 导出要求恰好一个起始 Dataset。

当前已有静态分支和多表 Process。缺口主要是统一执行、明确的路线选择、自动中间产物、恢复，以及导出与运行之间的一致性。

第一阶段保持现有七种画布节点。Score、Review、Sampler 不作为业务执行 job；Sampler 已生成的数据可作为入口。评测优化仍保留现有工作方式。

## 2. 目标架构

```text
Canvas + Current Pipeline 明确选择
                  |
          Pipeline Compiler
                  |
          PipelineSpec v1
             /         \
    Backend Runner     Python Exporter
         |
  PipelineRun + JobRun + Artifacts
         |
  Current Pipeline 进度、结果、恢复入口
```

后端负责调度和持久化；前端提交运行请求并显示状态。关闭详情窗口或刷新网页不应终止任务。桌面关闭导致后端退出时，下次启动进入恢复流程，不承诺关闭后继续计算。

编译器是无执行副作用的模块：不调用模型、不运行用户 Python、不加载密钥、不因为编译而创建 Dataset。输入为画布结构/配置/数据契约与明确的路线选择，输出为 spec 和诊断。

### 2.1 PipelineSpec：执行定义

建议新增 `backend/pipeline_compile.py`，具体模块拆分随实现调整。

Spec 包含：

- `format_version`：定义版本与兼容策略。
- `inputs`：命名输入及数据契约；结构允许多入口，首个可执行里程碑先支持单入口。
- `jobs`：LLM 或 Process 的配置快照、输入输出端口、依赖关系。
- `artifacts`：逻辑数据位置及其 schema、生产者、端口名称。
- `outputs`：本次选择的最终输出位置。
- `source_map`：job/数据位置与画布节点 ID、可见名称的对应，用于定位错误和展示进度。
- `diagnostics`：结构化错误与警告，包含代码、节点、字段和可读说明。

Spec 保存 Prompt 文本、schema、映射、有效运行设置和 Process 代码的快照。凭据通过执行时绑定解析；可移植 spec/导出包不含密钥、凭据 ID 或数据行。画布内部来源信息与导出配置通过明确的序列化边界分离。

Prompt 与选中的 Run 编译成一个 LLM job；Process 编译成一个 Process job。Dataset 表示数据位置，本身不参与调度。依赖以 artifact ID 和端口引用为准，展示顺序不能替代依赖。

### 2.2 PipelineRun、JobRun 与 Artifact：某次执行

- `PipelineRun`：运行 ID、项目归属、spec 快照、输入快照、整体状态、开始/结束时间。
- `JobRun`：本次执行中某个 job 的状态、尝试次数、进度、结果引用和错误。
- `Artifact`：实际数据快照，包含运行 ID、生产 job/端口、schema、行数、内容摘要和存储引用。

逻辑 artifact ID 与某次执行产生的 artifact ID 分开。同一 Pipeline 多次运行不会覆盖以前的数据。初期不实现跨运行自动缓存；恢复只显式复用已确认有效的成功结果。

现有画布 Dataset 继续表达步骤间的连接位置。本次运行时，下游读取本次上游产生的 artifact，不读取该位置上历史保存的数据。结果可预览并另存为工作区 Dataset。

第一阶段仍要求画布已有足够的连接和配置来表达路线。末端 Run 可有隐式 `result` 输出；多阶段首次搭建时没有中间 schema/连接的问题单列处理，不能宣称执行器自动消除了所有建图操作。

运行记录按项目隔离。桌面和 Web 都需要稳定的项目/运行归属及持久化目录；临时 asset session 不等于永久项目身份。图片/PDF 必须保存可恢复的资源引用，不能只记录一次性的本地路径。

## 3. 编译与执行规则

### 3.1 路线选择和校验

- 明确保留 Current Pipeline 当前所选版本、Run、Dataset 和分支；不擅自把备选项改为全部执行。
- 将 UI 路线选择逻辑抽成可测试模块；缺失依赖或歧义必须报错，不能静默补选其他版本。
- Process 主输入为 `df`，额外输入保持已有别名；多个输入不会被自动拼接。
- 一个逻辑数据位置只能有一个生产者。依赖缺失、重复生产者和环必须报错。
- 静态检查节点引用、Prompt 映射、已知输入类型、输出 schema、Process 函数结构和分支引用。
- Process 的实际列名、类型和返回分支可能依赖代码执行；编译阶段允许标注未知契约，在产物产生后、下游调用前再次校验。
- 不通过执行 Process 来做静态校验。未运行前不能保证发现所有下游 schema 错误。
- 稳定拓扑排序用于展示与生成代码；执行器依据输入是否就绪调度。

### 3.2 数据传递

- 复用当前 Dataset 格式、列命名与 Run 输出物化规则，包括 `Input:` / `Output:` 和 single/table 返回形状。
- 保留 row IDs、输入来源及展开输出的对应关系，避免影响后续 Score 配对。
- 静态命名分支各自产生 artifact；汇合节点等待全部必需输入。
- 空表仍然是有效 artifact。空输入 LLM job 不调用模型，并输出有契约的空表。
- 空输入 Process 仍应执行：它可能使用其他 Dataset 或自行产生行，不能一律跳过。
- 沿用现有 Process 输出文本化行为并明确提示；图片/PDF 加工后仍保留类型是后续独立任务。

### 3.3 状态、失败与取消

JobRun 基础状态：`pending`、`running`、`succeeded`、`failed`、`cancelled`、`interrupted`；依赖未成功导致无法执行的节点标记 `blocked`。`ready` 可由依赖推导，不必持久化。

- 首版按拓扑顺序串行执行 job，保留现有 Run 内逐行并发；之后增加有上限的分支并发。
- 默认 fail-fast：某 job 失败后不启动新 job；已有成功数据保留。并发阶段必须明确处理已运行的兄弟 job，并在全部收尾后确定整体终态。
- Run 行级错误与 job 失败分别记录。初版只要存在失败行，job 默认失败并保存部分结果，下游不消费部分表；后续再提供显式的容错策略。
- Stop 进入 `cancelling`，禁止启动新 job，向 Run/Process 传播取消；活动任务收尾后进入 `cancelled`。
- 取消不承诺撤回已发出的模型请求或费用；取消后迟到的结果不能把整条 Pipeline 重新标成成功。
- 刷新页面重新附着到原运行。后端重启时，原 `running` job 核对实际任务后标记 `interrupted`，由用户恢复，不自动重复收费调用。

### 3.4 Checkpoint 与恢复

- 先完整写入并校验 artifact，再原子提交成功 checkpoint；不能出现成功记录指向未写完的数据。
- checkpoint 记录 spec/input 快照、job 尝试、产物引用和有效性摘要。
- 同一运行的恢复必须使用冻结的配置和输入。运行期间编辑画布不改变正在执行的任务。
- 修改代码/Prompt/输入后重跑属于新的执行 revision；仅允许显式复用配置与输入均未变化的上游产物，并使修改节点及其后代失效。
- 首版 Process 按整个 job 重跑。LLM 行级恢复在确认已有 Run 的快照、索引和去重语义后接入；未验证前只承诺 job 级恢复。
- 重试/恢复请求需要幂等保护，防止双击或网络重发导致同一 job 被启动两次。
- Process 可包含外部副作用，无法承诺 exactly-once；恢复界面说明 Process 会重新执行。
- 凭据、解释器或资源缺失时给出可修复错误，保留 checkpoint。

## 4. 分阶段实施

### Phase 1：统一执行基础

按以下里程碑顺序实施，每一步完成测试后再扩大范围。

#### P1.1 PipelineSpec v1 与纯编译器（首先实施）

- [x] 固定 spec 字段、选择输入格式和 diagnostics 契约，提供最小 JSON 样例。
- [x] 提取可测试的 Current Pipeline 选择解析，保持已有 picker 语义。
- [x] 编译 Prompt+Run、Process、逻辑 Dataset、静态分支和多输入引用。
- [x] 检查依赖、环、生产者冲突、映射和已知类型，标注运行时待验证契约。
- [x] 建立成功与错误图样例，验证只包含选中路线。

验收：同一画布与选择稳定生成同一语义 spec；无模型调用或 Python 执行；诊断可定位到可见节点；未知 Process schema 不被伪装成已验证。

实现：`backend/pipeline_compile.py`、`app/src/pipelineRouteSelection.js`；契约及完整示例见 [PIPELINE_SPEC_V1.md](PIPELINE_SPEC_V1.md)。前端面板已复用提取后的选择模块；导出/API 在 P1.2 接入，Runner 在 P1.3 接入。

验证：compiler 单元测试、真实 JS 路线到 Python compiler 的跨语言测试、前端 picker/汇合回归、原有 Python 导出测试。复杂输出字段名及动态 Process schema 明确保留运行时校验；缺失默认模型设置显式标注待绑定。运行/导出接入时必须处理这些契约，不能把 warning 当成已可直接执行。

本里程碑结果：34 项 Python 测试（23 compiler + 11 原导出）与 5 项前端测试通过；Vite 前端生产构建通过，输出到独立 `.cache/pipeline-spec-check` 目录。构建仍有大 bundle 提示，未在本里程碑做拆包优化。未调用付费模型。

#### P1.2 导出消费统一编译结果

- [x] 将线性/DAG 导出器的图解释与校验逻辑移至 compiler。
- [x] 保留生成代码模块的可读性与现有单入口使用方式。
- [x] 多入口等暂不支持的导出能力单独报能力限制，不错误否定 spec 的合法性。
- [x] 使用 mock engine 验证旧导出案例及新分支案例，检查无数据/密钥泄露。

验收：导出器消费编译 spec，不再独立推测依赖；原有合法导出仍可运行；导出不需要启动 Pipeline。

P1.2 实现记录（2026-10-01）：

- 新增 `backend/pipeline_export_spec.py`：统一编译入口、模型绑定及 spec 渲染；线性/DAG 只保留不同代码布局，不再分别解释画布或排序 job。
- `pipeline.json.execution` 保存去除凭据及内部绑定的编译结果，保留原 `route` 或 `graph`。直接渲染 spec 的接口不需要画布。
- 前端 `pipelineExportDefinition.js` 保留配置、schema、行数及必要依赖边，发送显式入口 Dataset 与 Run 设置，不发送数据行/缓存结果。
- compiler 统一旧 `process(row)` 迁移、输出 key/display 归一化；`legacy_export` 策略保留空分支的延迟同名映射，默认 strict 仍要求动态输入显式映射。
- 导出保留各 Run 的有效 token/重试/并发设置；`--concurrency` 仅在显式提供时覆盖。多份 Dataset 物化共享一次 LLM job，名称含引号/换行仍生成合法代码。
- 多入口和纯 Process 图仍是导出能力限制；P1.2 本身未新增 Runner 或界面按钮（Runner 已在下述 P1.3 接入）。

验证：42 项 compiler/导出测试（含原 11 项回归）、2 项 API 测试、7 项前端测试通过；Vite 生产构建通过。真实生成项目使用 pandas/Excel 完成拆分、合并、模拟 LLM 调用及多个最终工作表输出，未调用付费模型。

本机前 42 项测试使用具备 pandas/openpyxl 的全局 Python，API 测试使用具备 FastAPI 的 `backend/.venv`。生成项目 requirements 已包含 openpyxl。构建仍有原有大 bundle 提示。

#### P1.3 最小后端 Runner 与产物存储

- [x] 确定桌面/Web 的项目归属、持久化位置、资源生命周期和运行隔离。
- [x] 实现 PipelineRun、JobRun、Artifact 持久化与原子 checkpoint。
- [x] 从现有执行路径提取 LLM/Process adapter，复用输入构建、输出解析、有效设置和取消逻辑。
- [x] 跑通单入口、串行 `Dataset → LLM → Process → LLM`。
- [x] 下游从本次 artifact 读取数据；验证空输入、table 输出和动态 schema。
- [x] 提供 compile/start/status/cancel/resume/results 接口，名称以实现为准。

验收：mock LLM 和真实小型 Process 可完整执行链路；无需中途手工保存 Dataset；历史画布数据不被覆盖。

实现（2026-10-01）：`backend/pipeline_runner.py` 负责串行调度、项目隔离、原子 checkpoint、取消和 job 级恢复；`backend/pipeline_runtime_adapters.py` 复用已有结构化 LLM、资源解析与 `process_df_exec.py`。运行记录保存在 `backend/data/pipeline_runs/<project-id-sha256>/<run-id>/`，`run.json` 不保存 API key，表数据保存为带摘要的独立 artifact。详细接口和生命周期见 [PIPELINE_RUNNER_V1.md](PIPELINE_RUNNER_V1.md)。

验证：mock LLM + 真实 pandas Process 的 `Dataset → LLM → Process → LLM` 端到端测试；空 DataFrame schema、table 多行输出、动态 Process schema、项目隔离、失败 checkpoint/resume、取消及 API 转发测试。P1.3 不包含 Current Pipeline 的可见 Run/Stop/结果界面，该部分仍属于 P1.4。

#### P1.4 Run Current Pipeline 与结果查看

- [x] Current Pipeline 增加校验、Run、Stop、Retry/Resume 入口。
- [x] 显示选中路线、输入数量、所用模型、整体和各 job 状态。
- [x] 动态 Process/table 输出导致调用量未知时，明确显示未知，不给出虚假的精确成本。
- [x] 预览中间/最终 artifact，并显式另存为工作区 Dataset。
- [x] 页面刷新可重新附着；画布修改不改变本次冻结的执行计划。
- [ ] 运行历史列表与清理（保留规则、删除入口），与面板运行入口一起设计。

验收：用户在 UI 中启动链路、查看结果并保存输出；执行中的路线与编译预览一致。

实现（2026-10-05）：`pipelineRunDefinition.js` 只把明确入口 Dataset 的行快照发送给 Runner，不会把画布中陈旧的中间 Dataset 当成本次输入；`pipelineRunClient.js` 封装 compile/start/status/cancel/resume/results API。面板先编译并显示诊断、模型和调用量估计，用户确认后以幂等 request ID 启动；已有 Stop/Resume、状态、artifact 预览和 “Save as Dataset” 可直接使用。

补充（2026-10-05）：面板轮询重绘时保留 runtime checks 的展开状态。Runner 提供项目级运行列表及冻结定义读取；面板显示 Pipeline History。运行结束后，即使整条 Pipeline 失败或取消，前端也按冻结 artifact 把已成功的 Run/Process job 导入节点 History，并为每个有效的产出 artifact 新建带 Pipeline 运行 ID 的 Dataset 副本；无效的部分结果仍只供预览。History 记录 ID 确定且 Dataset 带来源标记，重新打开项目或手动重试同步不会重复创建；旧运行没有冻结画布定义时，仅在当前节点配置与冻结 spec 相符时补录节点 History。

补充（2026-10-06）：副本同时接到下游。本次读取某 artifact 的 Run 改读其副本，以它为主输入 `df` 的 Process 改连其副本；导入的下游 History 记录也以副本（按画布上的内容签名）为输入，因此整条链显示本次运行的结果，下次运行的路线也经过最新副本。只在节点仍读取原 Dataset 时改连。Process 的 `df_<name>` 合并输入不改：别名由代码按 Dataset 名称引用，副本无法接替，此类 Process 保持原连接。

Runner 状态新增冻结的可展示执行计划：输入、依赖、模型快照、有效设置及调用量估计。单行形状的 LLM 可继续传播已知行数；经过 Process 或 table 形状后，下游调用量记为未知（`null`）。模型快照不含 API key；实际调用和恢复仍按凭据 ID 解析当前 secret。

运行归属：Web 复用项目 ID；桌面端使用规范化 `.yc` 绝对路径的 SHA-256 作为不暴露路径的稳定 owner，Save As 会获得新的运行历史归属。

验证：12 项前端路线/请求/预览测试、23 项 Runner/API/Process/设置测试、42 项 compiler/导出器回归测试通过；Vite renderer 生产构建通过。测试使用 mock LLM，未调用付费模型。构建仍有原有的大 bundle 提示。

#### P1.5 取消、失败恢复与重启恢复

- [x] 实现 fail-fast、行级失败处理、取消传播和迟到响应保护。
- [x] 实现 job 级恢复及双击/请求重发幂等。
- [x] 核实并接入已有 LLM 行级续跑，保证多输出行不会漏跑/重复。
- [x] 支持后端重启后的 interrupted 状态和持久化恢复。
- [x] 支持修改后建立新 revision、复用有效上游、使下游失效。
- [x] 验证桌面与 Web 两条运行生命周期；记录不可恢复情形。

验收：`A → B → C` 在 B 失败/取消/重启后可保留 A 并恢复；更改 B 不复用旧 B/C；缺失资源时显示原因；不因重复请求启动重复 job。

实现（2026-10-01）：LLM Job 在每个输入行完成后把成功/失败状态和结构化输出追加到该 Job 独立的 row checkpoint 文件，不重写 `run.json`。Retry/Resume 只提交未成功的行，成功行不会再次收费调用；Job 最终 Artifact 仍在全部行成功后统一提交。行 checkpoint 不随状态轮询返回前端，避免大结果重复传输。Process 仍按整个 Job 恢复。

取消状态使用本次 attempt token 隔离回调，并在 Artifact 和整体成功提交前再次检查 cancel 状态。无法中断的在途模型请求可能仍产生费用，其晚到成功响应只能保留在无效 partial Artifact/内部 checkpoint 中，不能把 Pipeline 改回成功或启动下游。新注册的 Process 子进程若已收到取消，会立即被终止。

start/revision 请求支持项目级 `request_id`：相同请求重放返回原 `run_id`。对 pending/running/cancelling 运行重复 Resume 直接返回当前状态，不创建第二个 worker。后端启动时把遗留的 pending/running/cancelling 运行标记为 `interrupted`；恢复前重新校验输入及成功 Artifact 的摘要，损坏的 Job 及后代会失效，冻结输入损坏则要求建立新 revision。

revisions API 创建新 revision。Runner 使用输入内容、完整 Job 定义、模型绑定快照及 Process runtime 计算指纹，把父 revision 中匹配且完整的成功 Artifact 复制为新实例；第一个发生变化或缺少输入的 Job 及其后代重新执行。旧 revision 保持不可变。

生命周期：Web 后端重启和桌面应用退出后的再次启动都会把未完成运行标记为 `interrupted`。桌面 owner 由规范化项目路径稳定派生，Save As 进入新 owner。含图片/PDF 的恢复需要客户端重新准备 asset session；源资源已删除、冻结输入损坏或凭据不存在时不会猜测替代项，而是保留 checkpoint 并显示原因。Process 可能有外部副作用，因此进程中断后的整 Job 重跑是 at-least-once，不承诺 exactly-once。

验证：新增行级失败续跑、重复 start/resume/revision、修改中间 Process 后的上游复用/后代失效、迟到 LLM 响应、模拟后端重启、缺失凭据以及桌面/Web owner 测试。29 项 Runner/API/Process/设置测试和 13 项前端测试通过；Vite renderer 生产构建通过，未调用付费模型。

#### P1.6 现有静态分支及兼容验收

- [x] Runner 支持 spec 已表达的分支与汇合，合流仅执行一次。
- [x] Runner 和导出使用同一组图样例验证语义一致性。
- [x] 保留单节点运行、手工保存 Dataset、旧项目打开和 Score/Review 工作方式。
- [x] 更新用户 Guide。

实现（2026-10-01）：以 compiler/exporter 已使用的 `raw → split(left, right) → merge → LLM` 图作为共享验收夹具。Runner 按 spec 的拓扑顺序物化两个命名分支，merge 同时读取 `df` 与 `df_right`，且 Job/attempt 记录证明只调度一次；导出项目继续用同一图执行真实 pandas split/merge、mock LLM 和双最终工作表。画布路线选择测试覆盖两条 lane 保留并在共享 merge 处汇合。

兼容边界：单 Run、单 Process、手工 Save to workspace、Score/Review/Sampler 的执行路径没有改成 Pipeline API；Pipeline Runner 是新增的独立执行路径。旧 `process(row)` 迁移、旧 Run 映射、原导出回归和 renderer 全量构建继续通过。多源导出以重复的 `--input DATASET_ID=FILE.xlsx` 绑定输入；ensemble 仍属于后续阶段。

验证：30 项 Runner/API/Process/设置测试、42 项 compiler/导出器测试和 13 项前端路线及运行测试通过；Vite renderer 生产构建通过。全部 LLM 测试使用 mock，未调用付费模型。构建仍有原有的大 bundle 提示。

Phase 1 完成标准：既有、可明确选择的无环业务路线能整体运行、追踪、取消、恢复及导出；不新增画布节点。

### Phase 2：扩大数据流能力

- [ ] 端到端多命名入口，包含 UI 输入绑定及 Python CLI。
- [ ] 明确“选一个备选项”与“全部执行”，支持同 Prompt 多 Run ensemble。
- [ ] 有上限的分支并发；整体模型并发预算，避免 job 并发乘以行并发失控。
- [ ] 纯 Process Pipeline 可被识别、运行和导出。
- [ ] 显式失败行 artifact、部分结果继续策略。
- [ ] 多模态 Process 输出契约，按实际需求决定如何保留/创建资源。
- [ ] 改进尚无中间结果时的首次建图体验与 schema 声明。

验收：多源 join、分支汇合、ensemble 和纯 ETL 均能从 UI 表达到运行及导出，不能只在底层 spec 中支持。

### Phase 3：控制流

- [ ] 实现 Run Repeat，重新核对 [RUN_LOOP_DESIGN.md](RUN_LOOP_DESIGN.md) 与当前执行体系的契约。
- [ ] 提供基于命名表格分支的 Router UI；与整 job 条件跳过分别定义。
- [ ] 节点 retry/fallback 策略，区分传输重试与业务失败处理。
- [ ] 通用 Approval/Gate：持久化等待、人工修订/批准/拒绝、继续执行和审计。

Gate 与现有 Review 分开。Repeat 先覆盖逐行反馈，规定最大轮数、中间历史、停止条件、Score 最终输出语义及导出行为。

### Phase 4：按真实需求扩展

- [ ] 可复用 Subflow 与结构化 Loop 容器，避免任意反向连线。
- [ ] 有状态处理，明确状态属于行、组、运行还是项目，定义恢复与并发语义。
- [ ] 独立 Agent/Tool 执行能力：工具范围、步骤/费用限制和调用记录。
- [ ] 定时、事件和增量触发。

本阶段是候选方向，不作为 Phase 1 的完成条件；每项先补充具体使用场景和独立设计。

## 5. 验证矩阵

| 场景 | 必须验证的行为 |
|---|---|
| Dataset → LLM → Dataset | 选中配置、输出列、source map 正确 |
| LLM → Process → LLM | 下游使用本次上游结果，动态列在调用前校验 |
| Process 两个命名分支再汇合 | 分支不混淆，必需输入完成后汇合一次 |
| 多入口 Process | spec 正确表达；导出未支持前返回明确限制 |
| 多版本、多 Run、多次保存输出 | 只编译所选项，不误执行所有实验 |
| 空分支、table 输出、重复输入行 | 保留 schema 和行来源；空 LLM 不发请求 |
| 图片/PDF | 运行、保存、重启恢复后的资源引用有效 |
| 缺映射、类型错、代码缺失、环 | 编译诊断可定位；动态错误运行时可定位 |
| B 失败或取消、后端重启 | A 的成功 artifact 保留，B 可恢复，C 不提前执行 |
| 更改 B 或输入 Dataset | 运行快照不变；新 revision 正确失效下游 |
| 重复 start/resume 请求 | 不重复启动同一任务 |
| Python 导出与画布执行 | mock engine 下数据变换、分支、列映射一致 |
| 旧项目和原有单节点操作 | 保存/打开/Score/Review 不回归 |

自动测试默认使用 mock LLM，不调用付费模型。Process 使用小型、确定性的 pandas 例子。故障测试在 artifact 写入和 checkpoint 提交边界注入中断，验证恢复而不只验证状态字段。

## 6. 开发组织与交付

专用分支：`feat/pipeline-execution`。首先交付 P1.1，再以 P1.2 验证编译结果有真实消费者；之后逐步接入 Runner 和 UI。每个里程碑记录实现文件、验证结果、已知限制，并更新本文复选框。

已有导出设计见 [PIPELINE_EXPORT_DESIGN.md](PIPELINE_EXPORT_DESIGN.md)，Agent 交互见 [AGENT_DESIGN.md](AGENT_DESIGN.md)。实现改变这些文档中的行为时同步更新，不能让设计稿中的计划被描述成已上线功能。

本计划不要求一次实现所有 Phase，也不触发模型调用、部署、发布或远端 push。
