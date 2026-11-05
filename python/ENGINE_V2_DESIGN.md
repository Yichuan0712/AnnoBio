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
- **按得分变化判断，不按全对与否（2026-11-05，先导第 0 步之后）：**
  - 第 0 步：同一 prompt 重跑 5 次。BioRED 上原本全对的摘要，有 20%–26% 下一次不再全对；而且全对的摘要很少，凑不满 4 道防回归题。按“全对与否”判断，好的修改在 BioRED 上几乎都会被拒。
  - 现在验证记录目标错题的得分增量（`target_gain`）和防回归题的得分下降（`regression_drop`）。防回归题取不在卡片目标里、原本得分最高的若干道，答对的题优先。
  - 对判对错的任务（PubMedQA、RoBBR），这和原来按对错判断完全一样。
  - 门槛（自动操作员）：
    - 卡片初筛：目标得分增量 ≥ 0.5，防回归题得分下降 ≤ 1；
    - 整批关口：16 道题配对净提升 ≥ 2，得分下降合计 ≤ 2。
    - 各门槛都不低于同 prompt 重跑噪声的 95% 分位。
  - app 界面仍按匹配行数显示通过率，不变。
- **方向与措辞（2026-11-05）：**
  - `proposals_per_cluster`（默认 1，与 app 现状相同）：每组问题让模型给出几个不同方向的改法。每个改法是一张卡片，都要验证。
  - 片段搜索只换措辞，不换方向。全自动模式下，每组问题最多搜索一张卡片：该组已有卡片通过验证时不搜；否则搜进展最大的那张。
  - `search_only_promising`（默认关）：只搜有进展的卡片，即修好了部分目标、或匹配行数增加；一点进展都没有的直接放弃。
  - 两个参数由先导比较后再定。
- **Thompson 搜索的奖励：** 目标题的通过率，扣除防回归题上的回归。现在 app 不扣回归。
- **全自动模式的接受规则（Operator）：** 目标题通过，并且防回归题上没有超出噪声的回归。有人介入时，接受与否由人决定；界面照样显示验证结果，用户仍可以手动接受任何卡片，与现在相同。
- **检查点与最终选择：** 引擎保留在位 prompt 和检查点。最终选择时，**初始 prompt 永远是候选**；成绩在噪声范围内取更短的。

### 6.0 整批关口改用下一批题（2026-11-05，先导第 2 步之后，已实现）

**发现。** 先导第 2 步的 PubMedQA 结果：
- 四种配置几乎每轮都被接受，每次在本批题上的净提升是 +2 到 +6；
- 但验证分并没有随轮数上升：配置 B 在 25% 预算时是 .72，之后掉到 .65；配置 A 一直是 .65。

原因是卡片针对本批错题而写，又在同一批题上判断，修好目标题本身就显示为提升。噪声门槛挡得住随机波动，挡不住这种“只对本批有效”的过拟合。

**做法（`OperatorConfig.gate = "next"`，默认）：**
- 第 i 轮用第 i 批题做诊断、卡片验证和片段搜索。
- 决定是否替换在位 prompt 时，用第 i+1 批题：这批题本轮的诊断和卡片都没见过，在它上面做配对比较，门槛不变。
- 第 i+1 批题上在位 prompt（或被接受的新 prompt）的预测结果，直接作为下一轮的基线，不重复预测。
- 最后一批没有下一批时，退回本批比较。
- `gate = "same"` 保留旧行为，作为对照。

### 6.1 提案：门槛自动校准（2026-11-05，待实现；第 2 步之后再做）

**问题。** 现在的 4 个门槛来自先导第 0 步的专门测量：3 个 prompt × 5 次重跑，花了 $0.98。门槛取决于任务、模型和批次大小。app 用户不会去做这种测量；换任务或换模型时，固定门槛要么太松（把噪声当进步），要么太严（什么都不接受）。

**做法：每轮顺便测一次噪声，门槛随数据自动定。**

1. **重跑一次。** 每轮开始时，在位 prompt 在本批题上除了正常的基线运行，再多跑一次，得到每道题两次结果的差 `d_i = s2_i − s1_i`。
   - 它们是同一个 prompt 的两次结果，差异纯粹来自噪声。
   - 这次重跑还有第二个用处：基线改用两次的平均。候选和在位 prompt 配对比较时，在位一方的噪声减半。
2. **积累噪声样本。** 每轮的 `d_i` 加进一个噪声池：
   - 全自动模式：跨轮积累；
   - app 里：同一个 Prompt 节点跨次积累，作为隐藏状态，用户无感，符合需求 1.3。

   池里按题目第一次得分高低分成两组：高分题（用于防回归门槛）和低分题（用于修复门槛）。
3. **由噪声池算门槛。** 用自助法（bootstrap）从池里抽样，模拟“候选和在位其实一样好”时会看到的差别，取它的 1−α 分位作为门槛：

   | 门槛 | 模拟的是 |
   |---|---|
   | `min_gain` | 整批 n 道题的配对净差 |
   | `max_batch_drop` | 整批题得分下降部分的合计 |
   | `min_fix` | 卡片目标题（低分题）的得分增量 |
   | `max_drop` | 防回归题（高分题）的得分下降 |

   - 对用户只剩**一个旋钮 α**（多保守），默认 0.05。
4. **样本少时不乱放。** 噪声池小的时候估计不稳，比如 PubMedQA 一批 16 道题可能一道都没翻转，估出来的噪声是 0。所以：
   - 门槛 = max（自助法估计，保底值）；
   - 保底值来自通用的先验噪声，并随池子变大逐渐让位给实测值，例如按池中题数加权。
   - 开发期实测的第 0 步数据可以作为实验里的先验，但 app 不依赖它。

**代价。** 每轮多跑 n 道题的预测，不调用 Sol。诊断（每道错题一次 Sol 调用）才是每轮的大头，按冒烟的数字，多出来的花费约占每轮的 5%–15%。

**要验证的事（先导或 E5）：**
- 自动门槛和第 0 步测出的固定门槛是否接近：同一批数据上两种都算，直接对比；
- 在 E5 里加一组对照：固定门槛 vs 自动校准，看对准确率、回归率和花费的影响。

**论文。** “按实测噪声自动设定接受门槛”可作为单独的贡献。正式写进论文前，要先查文献确认 prompt 优化领域有没有同类做法，比如统计检验式的接受规则或序贯检验。

## 7. 阶段：先大改，后小改（需求 7.6）

- 由 `Session` 的 `phase` 状态决定 `analyze()` 提出哪类卡片：
  - `coarse` 阶段：`rewrite` 卡片；
  - `fine` 阶段：`replace` / `insert` 卡片。
  - `demos` 卡片在开关打开时，于诊断后提出一次。
- **默认模式 `compete`：由验证决定大改还是小改（用户决定，2026-11-05）。**
  - 每轮都提局部卡片。
  - 整体改写卡片：在搜索预算用到 `coarse_budget_fraction` 之前，每轮都提；之后只在连续 `coarse_patience` 轮没有任何改动被采纳时才提，而且每 `coarse_patience` 轮最多提一次（卡住时再整体整理一次）。
  - 两类卡片都在同一批题上验证。通过的卡片组成几个方案：整体改写、全部局部卡片、最好的一张局部卡片。每个方案都放到整批题上，和当前 prompt 做配对比较，从合格的方案里取提升最大的，相同时取更短的。
- `coarse_to_fine`：按时间单向切换。先只大改，连续若干轮没被采纳，或者用掉设定比例的预算后，转为只小改，不再回头。
- E5 消融只改模式开关，算法其余部分相同：
  - `coarse_only`：只大改；
  - `fine_only`：只小改；
  - `coarse_to_fine`：按时间切换；
  - `compete`：由验证决定，即新版本身。
- 参数（`coarse_patience`、`coarse_budget_fraction`、`min_gain`、`max_lost`）由先导决定。
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
