# AnnoBio 优化引擎 v2：接口设计（草稿）

- 状态：草稿，2026-11-05，分支 `optimizer-v2`，待用户审阅后开始写代码。
- 需求见 AnnoBio-Experiments 仓库 `docs/design/paper/ANNOBIO_V2_REQUIREMENTS.md`，以下简称“需求”。
- 本文件只定接口、数据结构和与 app 的对应关系，不定具体算法参数；参数由开发先导决定。

## 1. 要解决的问题

现在同一个功能有三套互不调用的实现：

| 实现 | 位置 | 谁在用 |
|---|---|---|
| 诊断 → 聚类 → 每类一条修改 | `backend/review_pipeline.py` | app |
| Verify、片段切分加 Thompson 搜索 | 浏览器：`app/src/reviewDetailModal.js`、`reviewSuggestionOptimization.js`、`reviewSuggestionOptimizer.js`；后端只出片段和候选：`review_optimization_compositional.py` | app |
| `ReviewSession`（app 流程的复刻）和 `optimize()`（另一套自动算法） | `python/src/annobio_optimize/` | 实验 runner、H1 控制台 |

v2 只保留一个实现：Python 库里的新引擎。三处都调用它：
- app 后端；
- 实验 runner（全自动，E4/E5）；
- H1 控制台（有人介入）。

app 的界面和推送给界面的事件格式保持不变（需求 1.1、7.8）。

## 2. 分层

```
annobio_optimize.engine        纯 Python，不 import app；所有外部动作经回调
  ├─ Session                    一次优化会话：状态 + 界面上的各个操作
  ├─ Operator                   自动操作员：按固定规则调用 Session 的操作（全自动模式）
  └─ History                    跨会话的隐藏记录（可选，用户无感）

backend/annobio_engine_adapter.py   app 适配层：实现回调，把 Session 事件翻译成现有事件格式
experiments/.../methods.py:annobio  实验适配层：实现回调（计费客户端、benchmark 打分）+ Operator
runner/console.py (H1)              控制台适配层：人输入命令 → Session 操作
```

### 回调

沿用现有库的 `model` / `predict` / `evaluate` 三个回调，签名不变。

| 回调 | 作用 | app 里的实现 | 实验里的实现 |
|---|---|---|---|
| `model(request)` | 优化模型调用：诊断、提出修改、切片段、生成候选 | 现有 LLM 调用，用 Optimize 选的模型 | 计费客户端 meta 角色（Sol） |
| `predict(prompt, example)` | 用候选 prompt 跑一道题 | `llm_run_structured`，与 Run 作业相同的 schema 处理；GEPA 适配已经这样用 | 计费客户端 task 角色（Luna） |
| `evaluate(example, output)` | 打分，返回 `Evaluation(score, passed, details)` | 规则树：`score_run_gt_pairing.py`（JS 移植）；自定义代码：`/api/score/match/run` 的同一执行器 | benchmark 打分 |

引擎本身不碰数据集格式、模型供应商或评估规则，这些都在适配层。

## 3. Session：界面上的每个操作对应一个方法

| 方法 | 对应界面 | 说明 |
|---|---|---|
| `analyze()` | 点 “Optimize prompt” 后的分析 | 逐道错题生成诊断卡片；聚类；按当前阶段提出修改卡片。逐步发事件，可取消 |
| `propose(kind, …)` | 无单独按钮，由 `analyze()` 和 Operator 调用 | 生成一张修改卡片，`kind` 见第 4 节 |
| `verify(card_id)` | 点 “Click to Verify” | 只应用这一张卡片，在它针对的错题上运行，并在一组防回归题上运行（第 6 节） |
| `search(card_id)` | 点 “Optimize”（验证不通过时） | 切片段、生成候选、Thompson 搜索。结果是一张新卡片，`optimized_from` 指向原卡片，并自动验证 |
| `accept(card_id)` / `revert(card_id)` | Accept / Revert | 工作中的 prompt = 原 prompt + 全部已接受的卡片 |
| `apply()` | Apply | 返回最终 prompt 文本；app 由它生成新的 Prompt 版本 |
| `snapshot()` / `Session.restore(snapshot)` | Resume | 中断后继续；所有记录都可序列化 |
| `events()` | 进度条、卡片逐张出现 | 事件流，见第 5 节 |

规则：
- 用户能做的事，Operator 和 Agent 也只能通过这些方法做，不新增只给自动模式用的捷径（Agent 与用户同权）。
- 每个方法都写入审计记录：时间、输入、输出、花费、前后 prompt 哈希。试验记录也保存。现在 app 只返回最佳通过率，试验记录不保存，v2 补上，用于追溯。

## 4. 卡片

### 4.1 诊断卡片（Issue）

沿用现有 `Issue`，加稳定 ID，修改卡片通过 ID 引用它。现在 app 只靠自由文本 `phase1_addresses` 关联。

| 字段 | app 事件字段（`diagnosis_row.opinion.*`） |
|---|---|
| `title` | `card_title` |
| `summary` | `issue_summary` |
| `advice` | `rough_modification_opinion` |
| `category` | `problem_category_hint` |
| `reference_note` | `gt_suspect_note`（“可能是标准答案有问题”） |
| `example_id` | `input_index`、`row_indices`（适配层换算） |

### 4.2 修改卡片（Card）

所有修改都表示成“原文 → 新文”。界面只认 `old_sentence` / `new_sentence`，所以新增的几种修改都按这个形式表达，界面不用改。

| `kind` | 含义 | 原文 `old_text` | 新文 `new_text` |
|---|---|---|---|
| `replace` | 原句 → 新句（现有） | prompt 里唯一出现的一句 | 新句 |
| `insert` | 在某句之后插入新句或新段落（需求 7.2） | 锚点句 | 锚点句 + 新内容 |
| `rewrite` | 整体或整段改写（需求 7.6 的大改阶段） | 整个 prompt，或一个完整段落 | 改写后的文本 |
| `demos` | 加入例题（需求 7.1） | prompt 末段 | 末段 + `WORKED_EXAMPLES` 块（`harness.with_demos` 的同一排版） |

| 字段 | app 事件字段（`suggestions[*]`） |
|---|---|
| `id` | 前端的 `suggestion_id`；v2 由后端给出 |
| `title` | `name` |
| `rationale` | `reason` |
| `old_text` / `new_text` | `old_sentence` / `new_sentence` |
| `issue_ids` | `phase1_addresses`（适配层由 ID 填回诊断标题，保持现有显示） |
| `target_example_ids` | `target_score_row_indices`、`row_indices` |
| `cluster_id`、`cluster_label` | `issue_cluster_index`、`issue_cluster_label` |
| `optimized_from` | `optimized_from_suggestion_id` |
| `kind` | 新字段，前端可以忽略；只在详情或调试里显示 |

`demos` 卡片的理由里列出每道例题对应的诊断卡片。例题只从优化集（app 里是用户勾选参与 Optimize 的行）中选，并排除 `reference_note` 不为空的题。

## 5. 事件

后端适配层把引擎事件翻译成现有事件，前端不用改：
- `plan`
- `diagnosis_row`
- `suggestions`
- `stage`
- `error`
- `done`

Verify 和 Optimize 现在由前端自己运行，v2 改到后端。新增两个后端作业接口，形式与现有 analyze 作业相同（202 加轮询）：
- `POST /api/review/verify`
- `POST /api/review/search`

前端把原来的本地运行换成调用这两个接口，界面上的状态（Verifying… / Verified / Verification not pass / Optimizing… / “Optimized from #N”）和存储字段（`verify_states`、`verify_results`、`review_optimization_meta`）不变。这是前端代码的改动，不是界面改动。

## 6. 验证、接受与选择（需求 4、7.3、7.4）

- **目标题：** 卡片针对的错题，在应用卡片后的通过情况。与现在相同。
- **防回归题：** 不能总用同一小组题（需求第 4 节）。每次验证从“原本答对、未参与这张卡片诊断”的题中按批次轮换抽取。数量由先导决定；现在 app 是最多 2 道。
- **“超出噪声才算改进”：** 噪声幅度由先导里同一 prompt 的重复测量定下来。比较时用同一批题的配对差，不用两次独立打分的差。
- **Thompson 搜索的奖励：** 目标题的通过率，扣除防回归题上的回归。现在 app 不扣回归。
- **全自动模式的接受规则（Operator）：** 目标题通过，并且防回归题上没有超出噪声的回归。有人介入时，接受与否由人决定；界面照样显示验证结果，用户仍可以手动接受任何卡片，与现在相同。
- **检查点与最终选择：** 引擎保留在位 prompt 和检查点。最终选择时，**初始 prompt 永远是候选**；成绩在噪声范围内取更短的。

## 7. 阶段：先大改，后小改（需求 7.6）

- 由 `Session` 的 `phase` 状态决定 `analyze()` 提出哪类卡片：
  - `coarse` 阶段：`rewrite` 卡片；
  - `fine` 阶段：`replace` / `insert` 卡片。
  - `demos` 卡片在开关打开时，于诊断后提出一次。
- 切换规则：`coarse` 阶段连续若干次被接受的大改都没有超出噪声的提升，或者用掉了设定比例的预算，就转入 `fine`。参数由先导决定。
- E5 消融只改模式开关，算法其余部分相同：
  - `coarse_only`：只大改；
  - `fine_only`：只小改；
  - `coarse_to_fine`：先大后小，即新版本身。
- app 里，阶段对用户不可见：用户看到的仍是一组卡片，其中前期可能出现一张整体改写卡片。

## 8. 隐藏历史（需求 1.3、7.3 吸收 OPRO）

- **会话内：** 提出新卡片时，模型能看到本会话里以前试过的卡片、验证结果和是否被接受，避免重复失败的方向。
- **跨会话（可选，默认关闭，先导决定是否打开）：** 同一 prompt 节点以前的会话记录，作为提示材料。实验中每个单元都从空历史开始，保证各重复互相独立。

## 9. 实验需要的钩子

- 每次模型调用都经过 `model` / `predict` 回调，由适配层计费和限额；引擎不自己发请求。
- 种子：所有随机选择用会话种子派生，可复现。
- 轮次：每完成一次“诊断 → 卡片 → 决定”调用 `on_round`，供调度器记录 rounds.json 和检查点。
- E5：可以导出、导入冻结的候选池（同一批卡片和片段候选），三种模式在同一池上运行。

## 10. 迁移顺序

1. 库：`annobio_optimize.engine` 加 Operator，配离线测试（固定模型响应）。不花钱。
2. 实验适配：runner 的 `annobio` 方法改用 Session 加 Operator；H1 控制台改用 Session。离线演练。不花钱。
3. 开发先导（上限 $35，每次开跑前问用户），定参数，冻结。
4. 第二期运行。
5. app：
   - 后端加适配层和 verify/search 作业接口；
   - 前端把本地 Verify 和 Optimize 换成调用后端；
   - 删除 `review_pipeline.py` 里被取代的逻辑和浏览器端搜索，或只留兼容层；
   - 库里旧的 `ReviewSession` 复刻和 `optimize()` 一并移除。
6. app 回归检查：界面、卡片字段、状态与改动前一致（截图对比加事件字段对比）。

## 11. 已知差异与待核实

- 片段和候选的生成调用，现在 app 用的是 Generate 节点的模型凭据（`reviewSuggestionOptimizer.js:51`），不是 Optimize 选的模型。**v2 所有优化步骤统一用 Optimize 模型（用户决定，2026-11-05）**，与实验一致。界面不变，费用可能改变。
- GEPA 适配里的 `_run_task_prompt` 对表格输出只取第一行。v2 的 `predict` 要按 Run 作业的完整行为处理多行输出，再交给打分。
- 规则树打分的 Python 移植要和 JS 版逐项对齐（嵌入相似度、概念 ID 匹配需要预取映射），迁移时用同一批样例做对拍。
- “每次最多错题数”（默认 30）、“最多试验次数”（默认 40）两个设置项保留，含义不变；引擎新增的参数（阶段切换、防回归题数、噪声幅度）不暴露为设置项。
