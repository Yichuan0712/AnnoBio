# 独立 Python 优化库的数据结构与边界

## 范围与依赖方向

新库放在 `python/`，发行名暂定 `annobio-optimize`，导入名 `annobio_optimize`。现有 `backend/` 和 `app/` 不作修改，也不依赖新库。新库不反向 import 应用模块、不读取应用配置、凭据或数据目录。

```text
用户模型/评估器 → 三个回调 → Optimizer → OptimizationResult
                                  ↓
                         JSON 兼容的类型化记录
```

核心只有 Python 标准库依赖；`original` extra 提供同原后端的 RapidFuzz 分支。用户可在回调中选择任意供应商 SDK、模型、输出解析和任务指标。回调为同步接口，v0.1 不隐式创建线程或事件循环。

## 两条路径，原功能不由新策略替代

`Optimizer.review()` / `ReviewSession` 是与原方法接近的分步入口，`Optimizer.optimize()` 保留前一版新增的自动策略。它们共享样本、评估、问题、精确修改、模型回调和预算设施，但不共享隐式采纳规则。

原路径的建议独立于工作副本：分析针对固定原文生成所有提议，Verify 独立测试单条提议，Optimize 独立搜索单条提议并新增未应用建议，Accept/Revert 从原文与所有 applied 建议重建工作副本。原建议及其验证从不被搜索结果覆盖。人工可直接 Accept；需要 Agent 原有门槛时使用 `require_verified=True`。

| 新增类型 | 关联关系与职责 |
|---|---|
| `ReviewSuggestion` | 稳定 ID + `PromptEdit` + 可选 `optimized_from_id`，保留候选血缘 |
| `Verification` | 建议 ID、`kind`、实际输入 ID、评价批次 ID、matched/total、full-pass 和错误状态；搜索结果不会冒充直接 Verify |
| `SearchTrial` | picks、实际拼接文本、对应 Verification、通过率/奖励、更新后的 alpha/beta 和错误 |
| `ReviewSearchResult` | 来源建议、实际配置、回归样本、完整试验、最佳文本、生成的新建议 ID 与停止状态 |
| `ReviewDecision` | Accept/Revert/Reject 及操作前后文本，可非 LIFO 撤销 |
| `ReviewResult` | 固定原文、工作副本、applied ID 集合及全部观察/操作，独立 JSON 格式 |

`Evaluation` 新增可选 `matched_count/total_count`，解决“一条输入产生多行输出”的计分问题。原路径跨输入求比较行匹配数之比，不使用用户权重平均 F1 代替通过率；无比较行计数时退化为每个输入一条布尔判定。`score` 继续供可选自动策略和诊断使用，二者有明确区别。`error` 排除错误评价的 full-pass。

原搜索默认允许重复组合与重新请求，未观察前所有 arms 都是 Beta(1,1)，不以独立 Verify 的结果 warm start。搜索目标输入加最多两个回归输入，优先原来通过的输入；奖励、候选选择都按观察到的比较行通过率。局部回归不会额外触发新策略的硬拒绝；它通过这些比较行的失配影响奖励。搜索不做自动采纳。

原后端的提议 span 解析函数已复制为独立 `spans.py`，保留截断延伸、Markdown/引号/换行规范化和唯一前缀分支；RapidFuzz 通过可选 extra 延迟导入。`original.py` 还提供 JS 文本重建辅助函数和原 Beta/Gamma 算法。基础路径增加了不依赖 RapidFuzz 的空白规范化回退，这是一个明确的工程差异。

默认 `ReviewSearchConfig.text_handling="original"` 保留旧片段/候选 trim、casefold 去重、原片段额外插入和拼接不一致仍继续的行为。精确拼接、候选去重、全量验证、缓存、评分奖励、warm start 与回归惩罚都是显式选项；不会悄悄替换默认原路径。`max_trials` 默认 40，4–200 的限制保留，独立 Verify 不占其次数。

以下关于轮次、全数据改善、Beta warm start、精确拼接与自动采纳的设计描述，均只针对 `optimize()` 自动策略。共享的数据契约仍适用于两条路径。

## 样本与评价

| 类型 | 关键字段 | 设计理由 |
|---|---|---|
| `Example` | `id`, `inputs`, `reference`, `weight`, `metadata` | ID 不依赖表格位置，支持重排；输入与参考不强制字符串或固定 schema |
| `Evaluation` | `score`, `feedback`, `passed`, `metrics`, `details` | 把优化目标、错误解释和通过条件分开，避免将所有任务强制转成 exact match |
| `Observation` | `example_id`, `prediction`, `evaluation` | 一次预测与其逐样本评价绑定，完整保留结构化输出 |
| `EvaluationBatch` | `id`, `prompt_id`, `observations`, `score` | 一次完整数据集评价，支持候选复查与版本追溯 |

`inputs`、`reference`、`prediction` 都是 JSON 值。一条样本是一次任务执行及其评价单位，内部可以有多条实体、关系或表格行。库不负责给预测实体和参考实体配对，用户 evaluator 负责这些语义。`Example.reference` 可为空，以支持无参考指标。

`score` 必须归一化到 `[0, 1]` 且越大越好，以统一候选选择和 Beta 搜索奖励。整体分数是正权重均值，不是任意 batch metric。`metrics` 里的 accuracy/F1 等仅保留用于分析，不自动变成优化目标。`passed` 可选地覆盖通过阈值，但不能替代可比较的 `score`。

预测函数只收到 `prompt` 和 `inputs`，不收到参考，避免默认泄漏标准答案。评估函数收到 `Example` 和预测。诊断模型收到输入、预测、参考和评估反馈，以推导 prompt 修改；推理阶段的任务模型不承担诊断职责。

公共记录采用 frozen dataclass 和 tuple 关联容器；JSON dict/list 仍是普通 Python 可变对象，因此不能把 frozen 理解为深度不可变。进入运行时复制数据，回调也收到独立副本，避免回调篡改内部历史。不能把大对象隐式转成字符串，非 JSON 或非有限数值在边界报错。

## 问题、聚类与修改

| 类型 | 关键字段 | 不变量 |
|---|---|---|
| `Issue` | `id`, `example_id`, `evaluation_id`, `summary`, `advice`, `category`, `reference_note` | 每个诊断都可定位到实际评价证据；怀疑参考有误不影响评分 |
| `IssueCluster` | `id`, `issue_ids`, `example_ids`, `label` | 一轮内构成问题的完整互斥分区；样本目标由库推导 |
| `PromptEdit` | `id`, `base_prompt_id`, `start`, `end`, `old_text`, `new_text`, `rationale`, `target_example_ids`, `issue_ids` | 只应用于绑定的完整 prompt 内容及字符区间 |

prompt ID 是 UTF-8 内容的 SHA-256；`start/end` 为 Python Unicode code point 的半开区间，不是 UTF-8 字节或 JS UTF-16 偏移。模型先输出唯一的 verbatim `old_text`，库解析为区间并保存。发现重复、缺失或重叠出现的旧文本时不猜测，跳过并保留 notice。`new_text=""` 表示删除。`PromptEdit.apply()` 会复核全文摘要和旧区间内容。

每轮的诊断基于轮首评价。每组的提议针对最新已采纳的 prompt，并附带当前目标样本的观察；如果前一组修改已修复后一组的全部目标，则跳过后一组。每轮结束后再决定是否重新诊断，避免将多个旧区间机械地叠加到变化后的 prompt 上。

## 搜索、验证与历史

| 类型 | 关键字段 | 用途 |
|---|---|---|
| `SearchSpace` | `cluster_id`, `proposal_edit_id`, `segments`, `candidates` | 保存实际搜索空间；每行第 0 项是原片段 |
| `Trial` | `edit`, `source`, `picks`, `evaluation_id`, `target_gain`, `total_gain`, `regressed_example_ids`, `eligible`, `rejection_reason` | 记录每个已完成的候选评价及可采纳性 |
| `PromptVersion` | `id`, `text`, `parent_id`, `accepted_trial_id`, `evaluation_id` | 初始版本及每个已采纳版本的链 |
| `RoundRecord` | `index`, 起止 prompt ID, 问题/聚类/采纳 trial ID | 跨轮追踪；预算/取消中断也保留已生成记录 |
| `ModelCall` | `id`, `request`, `response` | 保存阶段、请求 schema、实际输入与原始响应 |
| `RunStats` | `model_calls`, `prediction_calls`, `evaluation_calls`, `cache_hits` | 不把一次批评价误认为一次模型请求 |

候选以一整批输入样本验证。默认要求目标分数和整体分数都严格提高，且没有逐样本退步；`max_score_drop` 可以允许小幅数值回退，但不能把已通过样本改成未通过。这比只检查两条回归样本更保守，成本也更高，因此用全局预测调用预算约束。

`Trial.eligible` 仅表示可采纳，不表示最终被选中；最终选择以 `PromptVersion.accepted_trial_id` 为准。比较最高整体分数，同分按候选出现顺序保持稳定。每次采纳都改善相对于当前 prompt 的整体分数。

片段拼接必须与新句完全一致。空格属于片段，不能 trim 后再拼接。原片段始终包含于候选中。Thompson sampling 使用运行内独立 `random.Random(seed)`；一个组合的奖励分配给参与的片段候选。回归组合奖励为 0，其余为实际整批加权分数。组合依最终文本去重。小空间即将耗尽时使用有界枚举找剩余组合，大空间不保证穷举。

每次调用 `optimize()` 创建全新的 session、缓存和随机数生成器，不复用前次结果。预算耗尽时可提交此前已经完整验证的合格候选；主动取消则返回最后已提交版本。外部预测/评估错误直接抛出，不把基础设施故障作为候选的负反馈。

## 可选自动策略与应用版本的明确差异

下面只描述 `optimize()`，不是 `review()` 的默认行为：

- 不包含 GUI 中的人工确认；使用可解释的自动采纳条件。
- 验证全部输入样本，默认不容许任何逐样本得分下降；现有应用的部分验证/片段搜索会使用局部输入和有限回归样本。
- 精确绑定 prompt 区间，不使用应用中的模糊文本定位。
- 严格复核片段拼接并保留空白；非法切分降级，不继续使用变形后的片段。
- 使用标准库 Beta 采样、显式 seed、候选去重和全局预算。
- 模型/指标由用户传入；没有应用凭据、worksheet、score mapping 或数据库服务的依赖。

这些差异可单独评估，不影响现有应用。基准实验应记录库版本、配置、模型设置和输入划分，不能将两个实现当作完全相同的实验条件。

`review()` 已通过读取 live JS 的测试对照输入选择、文本操作、Beta 采样和完整搜索循环（使用相同 uniform stream）；span helpers 也与 live 后端函数对照。仍不承诺 LLM 实验输出逐次一致：模型供应商、调用参数、提示消息包装、用户 evaluator 和随机源都可能不同。Python 接口的稳定 ID、JSON 对象协议也替代了 GUI worksheet/credential 与 HTTP 状态。

## 持久化与暂缓功能

公开输入与回调边界使用统一的 `ValidationError` 体系，异常带 `path/message/hint`，同时保持 TypeError/ValueError/KeyError 兼容性。初始化时用签名绑定检查回调位置参数，不执行回调；运行时检查同步返回、预测 JSON 与 Evaluation。参数/返回契约错误不消耗额外试验，也不作为 Thompson 的负反馈。外部调用异常保留原类型和 traceback，补充样本/阶段上下文；原方法的可恢复异常策略继续生效。

数据入口检查具体 JSON 路径、循环引用与有限数值；已有 Example/Observation 在进入 session 时重新验证，防止 frozen 记录内的 dict/list 被用户修改后绕过检查。保存记录通过统一递归 decoder 检查缺字段、未知字段、嵌套类型与主要 ID 引用，再恢复 dataclass；序列化也检查输出数据路径。该机制不新增模型供应商依赖，也不推断用户的任务 schema。

`OptimizationResult.to_dict()/to_json()` 提供格式 `annobio.optimization`、版本 `1` 的完整记录；`from_dict()/from_json()` 恢复类型化容器。数据集保存在顶层，各阶段用稳定 ID 关联。候选预测本身保留在评价批次，模型请求也保留了实际发送的上下文，因此导出大小随候选数及输入内容增长。

v0.1 不提供任意对象 pickle、自动磁盘写入、跨运行缓存、异步批处理、任意 corpus-level evaluator、供应商 SDK 封装或 resume。先明确并验证完整优化算法及其数据契约；这些扩展应保持同一套 trace 关联语义。
