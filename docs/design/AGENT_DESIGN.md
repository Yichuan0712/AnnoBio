# Agent 重新设计

> 命名更新（2026-10-16）：界面中的 Run 节点现称 **Generate**；操作称 **Run to here / Run this step / Run again**，Settings 的对应页签称 Generate。本文旧称及历史实施记录保留原义；内部 `type: run`、工具名、字段和 API 不变。

状态：P1–P3 与 P4 的 Agent 模型检查已实现（2026-09-24）。2026-10-06 增加 `pipeline_action`（整条 Pipeline 的运行、停止、续跑和 Python 导出）、`get_pipeline_runs`，并接入 Current Pipeline 当前路线。以下早期设计记录保留原阶段背景，工具表和状态以现行实现为准。

## 1. 为什么重做

现有 Agent 的核心（规划循环、提示词、大部分 skill）在 2026-05 定型，当时产品只做 Prompt 优化。之后加入的 Process、图片/PDF 数据集、Current Pipeline、分支与合并、Python 导出、Gallery 发布、OpenRouter，Agent 都没有跟上：

- 快照 `app/src/agent/canvas/workflowSnapshot.js` 不含列类型、路线、分支、合并，也不知道 Process 的多 Dataset 输入和 `df_<name>` 别名；Process 仍按已删除的 row 模式描述。
- 提示词里的 "pipeline" 指 review 的 verify → accept → apply，不是产品现在的 pipeline。
- `app/src/pipelineDetection.js` 已经是纯函数，Agent 没用上。
- 循环是 plan（结构化 JSON）→ 前端执行 skill → 另一次调用写回答。规划器看不到自己之前的推理，只能靠大量规则和防循环补丁约束。这套结构化输出兼容层当初是为了照顾各家模型能力不齐；现在通过 OpenRouter/LiteLLM，主流模型都支持原生 tool calling。

这次重做不在旧结构上修补。

## 2. 已定的决定

| # | 问题 | 决定 |
|---|---|---|
| 1 | Agent 能否直接改画布 | **不能**。所有修改先成为一个提案，用户确认后才落到画布 |
| 2 | Agent 能否执行 Process 代码 | **能**。可以试跑来验证自己写的代码 |
| 3 | 旧会话与旧 skill | **放弃**，不做兼容 |
| 4 | 优化流程是否自动跑完 | **不自动**。每到一个阶段就汇报结果，由用户决定下一步 |

## 3. 定位

Agent 是 **Pipeline 协作者**，覆盖用户的整条工作线，Prompt 优化只是其中一段：

| 职责 | 典型请求 |
|---|---|
| 搭建 | 「这两张表按 PMID 合并，从摘要里抽出靶点和位点」 |
| 解释 / 排错 | 「第 12 行的 site 是怎么来的」「这条路线为什么断了」 |
| 评估 / 优化 | 「给这个 prompt 打分，看看哪里错得最多」 |
| 交付 | 「导出当前路线」「选哪个模型更便宜又够用」 |

## 4. 交互模型

每一轮用户消息之后，Agent 可以做任意多次**只读**操作。一旦需要改画布、花钱或需要用户决定，这一轮就停下来，由用户推动下一步。

```text
用户消息
  └─ Agent 循环（模型 ⇄ 只读工具，自动执行）
       ├─ 直接回答 ............................... 本轮结束
       ├─ propose_changes → 修改卡片 ............. 本轮结束，等用户 应用 / 拒绝 / 修改意见
       ├─ run_nodes → 运行卡片（含成本估计） ..... 本轮结束，等用户 运行 / 取消
       ├─ pipeline_action → Pipeline 操作卡片 ... 本轮结束，等用户确认 / 取消
       └─ ask_user → 选项卡片 ................... 本轮结束，等用户选择
```

用户在卡片上的操作作为对应 tool 调用的 `tool_result` 回到对话，Agent 从这里接着做。例如「应用成功，新节点 id 映射如下」「用户拒绝：不要删除旧的 Dataset」「运行完成：32/32 行，2 行出错」。

### 4.1 修改提案（决定 1）

`propose_changes` 提交一组有序操作，只在 Agent 内部生成，不动画布：

```json
{
  "summary": "给抽取 Prompt 建新版本，在最后 3 行上跑，并和 gt_depod_last3 对比",
  "operations": [
    {"op": "add_prompt_version", "ref": "$v4", "prompt": "n_1772485936959_624104739",
     "text_edits": [{"old": "...", "new": "... 没有明确证据时返回空列表 ..."}]},
    {"op": "add_run", "ref": "$run", "prompt": "$v4", "input_dataset": "n_1778093075454_188030617",
     "input_mapping": {"title": "Title", "excerpt": "Abstract"}},
    {"op": "add_score", "run": "$run", "ground_truth": "n_1778108712899_475963798",
     "pairing": [{"run_input_column": "PMIDs", "ground_truth_columns": ["PMID"]}],
     "comparison": [{"field": "phosphatase", "ground_truth_columns": ["Phosphatase entry names"],
                     "match": {"ignore_case": true}}]}
  ]
}
```

- `ref` 是提案内的临时 id，后面的操作可以引用；应用后映射为真实 id 并回传给 Agent。
- 节点之间的关系都通过字段表达（Run 的 `prompt` / `input_dataset`、Score 的 `run` / `ground_truth`、Process 的 `primary_input` 和代码里的 `df_<alias>`），连线由引擎按画布规则生成，所以不单独提供 `connect` / `disconnect`。
- **提出时**先校验：列名、Prompt 输入与输出字段、列类型与输入类型、Process 别名、凭据 id 等。不通过的提案不会出现在卡片上，错误直接回给模型修正。
- 卡片逐条列出变更（新增 / 修改 / 删除）及其影响，例如删除一个 Dataset 时列出因此失去输入的 Run。Prompt 文本和代码显示行级 diff。鼠标悬停某条变更时，高亮画布上涉及的节点。
- **应用**：对**当前**画布重新规划一次（提出之后画布可能变了），外部导入此时才拉取数据。规划出的完整新状态通过 `loadCanvasState` 一次载入，只触发一次 `workflow:canvas-changed`，所以一次撤销就能全部回退。任何一步失败则整组不落地，错误回传给模型。
- 应用前如果画布上开着某个节点的详情窗口，会要求先关掉：那个窗口持有旧节点元素，重建画布后它的编辑会写到已脱离的节点上。正在运行的 Run / Review 节点上有不进快照的临时属性（续跑偏移等），重建时会原样带过去。
- **拒绝**：按钮拒绝，或直接在输入框里打字；打的字作为修改意见和拒绝一起回传。
- 删除节点只在用户明确要求时出现在提案里，系统提示词写明这一点。

### 4.2 执行与成本（决定 1、4）

`run_nodes` 请求一组按顺序执行的任务（`app/src/agent/execution/runJobs.js`）：

| kind | 做什么 |
|---|---|
| `run` | 运行一个 Run 还没处理的行（已有结果时接着跑） |
| `process` | 运行一个 Process 保存的代码，输出分支存在节点上 |
| `review` | 在一个 Score 下新建 Review 节点并运行 |
| `verify` | 用建议重跑它针对的行并与 ground truth 对比，已有验证结果的跳过 |

Score 不需要任务：它的 Run 有结果后会自己算出对比。

- **提出时**先校验，比如 Run 缺映射、没有可用凭据、Process 没设 Python、Score 还没有对比结果；不通过的请求直接退回模型。
- 卡片逐项列出行数、模型和估算，并给出总计。Run 的估算按字符数 ÷ 4 算输入 token，按每个输出字段 40 token 算输出（table 形状再乘 3），乘以 OpenRouter catalog 单价。非 OpenRouter 凭据只给 token 数。Review 和验证的调用次数取决于方法，只说明大致规模，不报价格。Process 不调模型。
- **运行**：对当前画布重新校验后按顺序执行，走的都是画布自己的函数（`startRunNode`、`runProcessNode`、`createAndRunReviewNode`、`verifyReviewSuggestions`），进度显示在状态行。遇到失败或被停止就不再继续，结果列出没开始的任务。
- **停止**：Run 停止后要先跑完已发给模型的行（实测约 40 秒），执行层最多等 90 秒，再如实报告停在第几行。验证无法中途停止，卡片上写明。
- 完成后结果回到模型，由它汇报并询问下一步（决定 4）。系统提示词要求一次只跑一个阶段。

### 4.3 Process 试跑（决定 2）

`try_process` 在不改画布的前提下执行一段 `process(df)` 代码（`app/src/processRunClient.js`，与 Process 详情页发同样的请求）：

- `df` 是主输入 Dataset 的前 `max_rows` 行（默认 50，最多 1000）；代码里引用到的其他 Dataset 以 `df_<alias>` 完整提供，别名规则与画布相同；
- 走 `/api/process/df/run`，使用 Settings 里配置的 Python；
- 返回每个输出分支的行数、列和前 5 行，失败时返回 Python 报错；
- 不需要确认，因为它不改画布也不花模型费用。系统提示词要求 Agent 写的 Process 先试跑通过，再放进 `propose_changes`。

## 5. 架构

### 5.1 循环

循环放在 renderer，工具也在 renderer 执行：画布状态本来就在这里，现有 skill 在这里执行也是对的。后端只做模型代理。

```text
renderer                                   backend                     LLM
  messages[] + tools[] ── POST /api/agent/turn ──► LiteLLM completion(tools, stream)
  ◄──────────── SSE: text delta / tool_calls / usage ◄─────────────────
  执行只读 tool，把 tool_result 追加进 messages，再次请求
  …直到模型不再调用 tool，或调用了 propose_changes / run_nodes / pipeline_action / ask_user
```

- 删除 `/api/agent/plan`、`AgentPlanResponse` 及结构化输出路径，改用原生 tool calling。
- 单轮上限：只读 tool 调用最多 30 次，总时长最多 5 分钟。超限就让模型基于已有信息作答。其余防循环规则全部删除。
- `/api/agent/turn` 改为流式返回。**Hub 需要同步改造**：`hub/proxy.py` 现在会缓冲完整个响应再返回（`upstream.content`），需要让 `text/event-stream` 按流透传。
- 消息里保留完整的 tool_use / tool_result 历史，每个会话一份，按项目存储（沿用 `/api/projects/{id}/agent-conversations`，换新的 `format_version`；旧格式直接忽略，见决定 3）。

### 5.2 模型

- Agent 使用自己的凭据（沿用 `default_agent_credential_id`），与 Run 节点的模型相互独立。
- 用户接什么模型事先未知，所以能不能当 Agent 用以**实测**为准：在 Settings → Agent defaults 选中一个模型时，`POST /api/credentials/{id}/agent-check` 给它一个假工具并要求调用（`llm.probe_tool_calling`，一次很小的调用），结果按模型记在凭据上（`agent_check`），下拉框和状态行显示"可用 / 不能调用工具"，可以重新检查。检查本身失败（密钥、网络、额度）时只报告失败，不下结论。
- 模型目录只作参考，未检查前显示：OpenRouter 用 catalog 的 `supported_parameters`，其他厂商用 LiteLLM 注册表（`/api/credentials/agent-hints`）；不在注册表里或自定义 endpoint 的显示为"无公开信息"。注册表会过时：deepseek-reasoner 在 LiteLLM 里标为不支持，实测可以。
- 运行中厂商拒绝 `tools` 时（`llm.is_tools_unsupported_error`），Agent 窗口显示"该模型不支持工具调用，请在 Settings 换一个 Agent 模型"，而不是原始报错；已知检查失败的模型在输入框里提前提示。
- 请求的排列顺序是系统提示词、工具定义、会话历史，前两部分固定不变，以便命中 prompt caching。

### 5.3 上下文

不再每轮塞入完整快照。系统提示词后附一段**工作区摘要**，每个用户回合开始时重新生成一次：

- 各 Pipeline 的路线（来自 `detectPipelines`），包括分支、合并点和当前选中的路线；
- 每个 Dataset 的名称、行数、列名和列类型（`text` / `image` / `pdf`）；
- 每个 Prompt 的输入、输出 schema 和版本关系；每个 Run 的模型和状态；每个 Score 的指标；每个 Review 的状态；
- 当前选中的节点。

控制在几 KB 以内，细节交给只读工具按需读取。

### 5.4 知识

系统提示词只讲心智模型：节点角色、连线含义、路线的概念，以及第 4 节的交互规则，目标在 150 行以内。领域方法放进 `read_guide(topic)` 按需加载：

| topic | 内容 |
|---|---|
| `pipeline-building` | 从需求到路线的一般做法；何时用 Process、何时用 Prompt |
| `process-code` | `process(df)` 约定、`df_<name>` 别名、返回命名分支、可用的库 |
| `prompt-design` | 输入变量、输出 schema、图片/PDF 输入 |
| `evaluation` | Score 映射、ground truth 配对、指标含义 |
| `prompt-optimization` | run → score → review → checkpoint → follow-up 方法（由现有提示词压缩而来） |
| `export-and-share` | 什么样的路线可以导出，导出包的内容，Gallery 发布 |

guide 放在 `backend/agent/guides/*.md`，随后端发布。

## 6. 工具

| 工具 | 类别 | 说明 |
|---|---|---|
| `get_workspace` | 读 | 重新生成 5.3 的工作区摘要（改动应用后刷新用） |
| `inspect_node` | 读 | 单个节点的完整配置：Prompt 全文、Process 代码、Run 映射、Score 映射、Review 建议 |
| `read_rows` | 读 | Dataset / Run / Score / Process 输出的行，支持 `start_row`、`max_rows`、`columns`；图片/PDF 单元格返回文件名，不返回内容 |
| `trace_row` | 读 | 追溯 Run 的某一输入行：输入值、该行的全部输出、每个下游 Score 的判定。Process 会重塑行，行身份无法穿过 Process，所以不跨 Process 追溯 |
| `list_models` | 读 | OpenRouter catalog，可按 vision、pdf、tools、价格、上下文长度过滤 |
| `search_source` | 读 | PubMed / ClinicalTrials.gov / ChEMBL 关键词检索：命中总数、id 列表、几条样例和可导入字段，不导入。bioRxiv/medRxiv 没有关键词检索 API，只能按 DOI 导入 |
| `read_guide` | 读 | 第 5.4 节 |
| `try_process` | 验证 | 第 4.3 节，自动执行 |
| `propose_changes` | 需确认 | 第 4.1 节 |
| `run_nodes` | 需确认 | 第 4.2 节 |
| `get_pipeline_runs` | 读 | 查询整条 Pipeline 的运行列表及单次运行的状态和各步骤进度 |
| `pipeline_action` | 需确认 | 对面板当前路线发起运行或导出，也可停止、续跑已有 Pipeline 运行；确认时再次核对路线 |
| `ask_user` | 需确认 | 一个问题加 2–4 个选项，用户也可以直接输入 |

`propose_changes` 支持的操作（`app/src/agent/operations/changeSet.js`）：

| op | 说明 |
|---|---|
| `add_dataset` | 新建纯文本表（列名 + 行） |
| `import_dataset` | 按 id 从 PubMed / ClinicalTrials.gov / ChEMBL / 预印本导入；应用时走现有的 `/api/<source>/import` 任务 |
| `add_sampler` | Sampler 和它产出的 Dataset：随机 N 行 / 百分比 / 指定行 |
| `add_process` | 新 Process，代码必须定义 `process(df)`，用到的 `df_<alias>` 必须对应画布上的 Dataset；不运行 |
| `add_prompt` | 新 Prompt：文本 `text`、输入类型、输出 schema |
| `add_prompt_version` | 新版本：`text_edits`（`[{old, new}]`，每个 old 在文本里必须只出现一次）或完整 `text`，其余复制 |
| `add_run` | 新 Run：Prompt、输入 Dataset、完整的输入映射；使用 Settings 中的 Run 默认模型，不启动 |
| `add_score` | 新 Score：配对规则、比较规则、组合方式与匹配选项，或自定义 `match_code` |
| `save_run_results` | 把 Run 结果存成 Dataset，表格与画布 "Save to workspace" 完全相同（共用 `app/src/runResultsExport.js`） |
| `save_process_output` | 把 Process 的一个输出分支存成 Dataset，连到该 Process |
| `apply_review` | 按用户选定的建议 id，把 Review 看到的 Prompt 改写成新 Prompt（Review → Prompt 连线），并在 Review 上记录哪些建议已采纳；未验证的建议给出提醒 |
| `update` | 按类型的字段白名单修改（名称、说明、sections、代码、输入、映射、规则等） |
| `remove` | 删除节点及其连线，并清理其他节点对它的引用 |


工具参数一律用 JSON Schema 定义，以便模型端做参数校验。

## 7. 删除清单（决定 3）

- `backend/agent/prompt/agent_plan_prompt.py`、`/api/agent/plan` 及相关 Pydantic 模型
- `backend/agent/prompt/agent_system_prompt.py`（重写）
- `backend/agent/context/*`（由工作区摘要取代）
- `app/src/agent/skills/*/`（参数校验迁移后删除目录）、`registry.js`
- `app/src/agent/payload/compactObservations.js`
- `app/src/agentChatSession.js` 中的规划循环、防循环逻辑、等待逻辑（约 1000 行，由新的循环取代）
- `app/src/agent/canvas/workflowSnapshot.js`（由工作区摘要取代）

保留 `agentWindowModal.js` 的窗口、侧栏和会话列表，消息区改为渲染流式文本、tool 调用和卡片。

## 8. 分期

| 阶段 | 内容 | 完成后 Agent 能做的事 |
|---|---|---|
| P1 ✅ | `/api/agent/turn`（流式、tools）、Hub 流式透传、新循环、工作区摘要、只读工具（除 `search_source`）、`read_guide`、`ask_user`；删除旧 Agent | 读懂任意 pipeline，回答和排错 |
| P2 ✅ | `propose_changes` 及卡片、增 / 改 / 删操作、单步撤销、`search_source` 与导入 | 按用户确认搭建和修改 pipeline |
| P3 ✅ | `try_process`、`run_nodes` 及成本估算、`apply_review`、把 Run / Process 输出存为 Dataset | 验证 Process 代码，逐步完成评估和优化 |
| P4 ✅ | Agent 模型实测检查与报错提示；导出由 `pipeline_action` 实现 | 模型可用性检查；按用户确认导出 |
| 后续对齐 ✅ | `get_pipeline_runs`、`pipeline_action`、当前路线和 Pipeline 结果来源 | 查询和操作整条 Pipeline |

P1 完成后旧 Agent 即下线，不做新旧并存。

### 实现位置

| 部分 | 文件 |
|---|---|
| 流式接口、guide 接口 | `backend/main.py`（`/api/agent/turn`、`/api/agent/guides/{topic}`）、`backend/llm.py`（`stream_chat_with_tools`） |
| 系统提示词、guides | `backend/agent/system_prompt.py`、`backend/agent/guides/*.md` |
| Hub 流式透传 | `hub/proxy.py` |
| 循环、流式客户端 | `app/src/agent/agentLoop.js`、`app/src/agent/api/agentTurnClient.js` |
| 工作区摘要、节点视图 | `app/src/agent/context/workspaceSummary.js`、`app/src/agent/canvas/workflowNodeInspector.js` |
| 工具 | `app/src/agent/tools/agentTools.js` |
| 窗口与会话 | `app/src/agentChatSession.js`、`app/src/agentWindowModal.js` |
| 变更引擎（纯函数） | `app/src/agent/operations/changeSet.js` |
| 提案预览、导入、应用 | `app/src/agent/operations/proposals.js`；画布侧 `applyAgentCanvasState`（`app/src/workflowCanvas.js`） |
| 数据源检索 | `backend/agent/source_search.py`（`/api/agent/sources`、`/api/agent/search`） |
| 提案卡片、运行卡片、行级 diff | `app/src/agentChatSession.js`、`app/src/agent/lineDiff.js` |
| 运行任务（预览、估算、执行、停止） | `app/src/agent/execution/runJobs.js`；画布侧 `runProcessNode`、`stopRunNode`、`stopReviewNode`（`app/src/workflowCanvas.js`） |
| Process 试跑与运行 | `app/src/processRunClient.js` |
| Run 结果转 Dataset（与画布共用） | `app/src/runResultsExport.js` |

会话存储带 `format_version: 2`；没有该字段的旧会话不再加载。

某些模型偶尔在工具结果之后返回空回复（测试中 Gemini 2.5 Flash-Lite 稳定复现，与消息格式无关），循环会自动重试一次，仍为空则提示用户重发或换 Agent 模型。

## 9. 待验证

- LiteLLM 在 Bedrock、Gemini 直连下 tool calling 与流式输出的一致性；不一致时，这两种凭据的 Agent 功能先通过 OpenRouter 提供。
- 图片/PDF：`read_rows` 默认不回传文件内容。是否允许 Agent 查看样本图片（仅限支持 vision 的 Agent 模型）留到 P3 之后再定。
- 成本估算的精度：输出长度只能按 schema 粗估，卡片上标注为估算值。
