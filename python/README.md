# annobio-optimize

独立的全 Python prompt 优化库：从错误样本诊断问题、按根因聚类、提出局部修改，经过验证和回归检查，必要时用 Thompson sampling 搜索修改片段的组合。

这是与 AnnoBio 应用并行的新实现。库不导入 `backend/`、不访问应用 API，也不包含生物医学匹配器、Pipeline runner、其他优化算法或界面代码。Python 3.10+，核心无运行时第三方依赖；`original` extra 提供原版的 RapidFuzz 文本定位分支。包名是本地暂定名，尚未发布到 PyPI。

**原方法的分步路径是主要入口：`optimizer.review()`。** 前一版新增的全量回归检查、自动采纳和多轮循环仍保留在 `optimizer.optimize()`，是独立的可选策略，不会替换原有操作。

## 原方法：分步分析、验证、搜索与人工采纳

```python
from annobio_optimize import ReviewSearchConfig

# model / predict / evaluate 的约定见下面“三个回调”。
review = optimizer.review(prompt, examples)
suggestions = review.analyze()  # 只生成建议，不更改 prompt

source = suggestions[0]
verification = review.verify(source.id)  # 只运行此建议针对的输入
candidate = source
if not verification.full_pass:
    search = review.search(source.id, config=ReviewSearchConfig(max_trials=40))
    if search.optimized_suggestion_id is not None:
        candidate = next(s for s in review.suggestions if s.id == search.optimized_suggestion_id)
        review.verify(candidate.id)  # 搜索新建另一条未采纳建议，需单独验证

if review.can_accept(candidate.id):
    review.accept(candidate.id, require_verified=True)  # 对齐 Agent 的 full-pass 门槛

print(review.prompt)
# review.accept(source.id)    # 人工可以明确采纳未通过/未验证的建议，同应用界面
# review.revert(candidate.id) # 从原文和其余已采纳建议重建，可非 LIFO 撤销
# review.reject(candidate.id)
trace = review.snapshot()     # ReviewResult；包含原建议、新建议、验证、搜索和操作历史
```

完整可运行版本见 [staged_demo.py](examples/staged_demo.py)。已有模型输出/评估时，可传入 `observations=[Observation(...)]` 作为 baseline，避免重新运行任务模型；也可通过 `review.add_suggestion(edit)` 导入已有修改，独立 Verify/Optimize，无需重做诊断。建议针对固定的 `original_prompt`，采纳后的工作副本为 `review.prompt`；重新诊断修改后的 prompt 时创建新 review。

原路径默认行为：

| 环节 | 保留的行为 |
|---|---|
| 诊断 | 按输入原顺序选择失败样本；保留标题、诊断、建议、类别和疑似参考错误说明 |
| 聚类 | 超过 5 个问题才调用模型；重复成员去重，缺失成员补单例，失败按类别回退 |
| 提议 | 针对同一原 prompt；同一修改去重；保留名称、所解决的诊断和目标样本；不自动应用 |
| Verify | 只验证目标输入；只有完整且全部通过才满足自动采纳门槛 |
| Optimize 输入 | 目标输入 + 最多两条其他输入；优先原本全部通过者，再按原输入顺序 |
| 搜索 | 全部候选从 Beta(1,1) 开始；允许重复组合，不用已有 Verify 更新先验；每次重新预测 |
| 奖励/选择 | 比较行 `matched_count / total_count`；失败 trial 给参与候选增加 beta；不额外惩罚回归；最好通过率胜出，同分保留先出现者，100% 提前停止 |
| 预算 | 默认 40 次搜索；限制在 4–200，初始 Verify 不计入搜索次数 |
| 结果 | 追加独立、未采纳的新建议；原建议与其验证保持原样，可单独采纳和撤销 |

抽取任务可以让评估器返回 `Evaluation(score, matched_count=..., total_count=...)`，让库按比较行累计通过率，而不是把“通过几个输入”误当成“匹配几条输出”。两个计数必须同时提供，且 `0 <= matched_count <= total_count`。没有计数时，每条输入按 `passed` 或 `pass_threshold` 产生一条布尔比较。零比较行不算 full pass；`error` 非空的评价不算通过。具体实体配对仍由用户 evaluator 实现。

`ReviewSearchConfig` 的新增能力全为显式开关，默认保持原路径：`validation_scope="all"`、`reward="score"`、`text_handling="exact"`、`deduplicate=True`、`warm_start=True`、`cache_evaluations=True`、`penalize_regression=True`。可用 `continue_on_error=False` 改为直接抛出预测/评价异常。开关改变算法语义，实验时应保留实际配置。

默认 `text_handling="original"` 保留原版切片/候选 `.strip()`、大小写去重、原片段额外插入和拼接不一致仍继续的行为，包括原来的空白处理问题。需要修正这些行为时才显式使用 `exact`。原版 Beta/Gamma 采样器也已移植；相同均匀随机数流可对照 JS，Python seed 本身并不等于 JS 的随机种子。

模型回复格式：review 的 `diagnose` 使用原来的 `card_title/issue_summary/rough_modification_opinion/problem_category_hint/gt_suspect_note`；`propose` 返回 `prompt_edits`，每项含 `name/phase1_addresses/old_sentence/new_sentence/reason`。也接受自动策略的字段别名。聚类支持稳定 `issue_ids`，兼容原 `member_indices`。以每个请求中的 `response_schema` 为准。

原后端的 exactish、截断延伸、Markdown/引号/前缀定位已独立保留；安装 `python -m pip install "./python[original]"` 可启用同一 RapidFuzz 模糊分支。未安装该 extra 时保留无需依赖的定位路径和空白规范化回退，不能声称包含完整 fuzzy 行为。调用后通过 `PromptEdit` 保存真实原文区间。

`ReviewResult.to_json()/from_json()` 使用独立格式 `annobio.review`、版本 1，记录手动操作，不把搜索试验当成已采纳版本。`analyze/verify` 预算耗尽或取消抛出带部分记录的 `ReviewStopped`；`search` 则返回带停止状态的 `ReviewSearchResult`。取消/预算中断保留搜索历史，不追加或采纳候选。

## 安装与运行

从仓库根目录：

```shell
python -m pip install ./python
python python/examples/staged_demo.py
python python/examples/offline_demo.py
```

开发时可用 `python -m pip install -e ./python`。两个离线示例均不需要 API key；`staged_demo.py` 演示原路径，`offline_demo.py` 演示可选自动策略。

## 三个回调

```python
from annobio_optimize import Evaluation, Example, Optimizer, OptimizerConfig

def predict(prompt, inputs):
    # 调用你的任务模型。库不会插值 prompt 或假定 inputs 的字段名。
    return your_task_model(prompt, inputs)

def evaluate(example, prediction):
    score, explanation = your_metric(prediction, example.reference)
    return Evaluation(score=score, feedback=explanation)

def model(request):
    # 调用用于诊断、提议和改写的模型。具体 SDK 由你选择。
    # request.instruction: 此阶段的指令
    # request.payload: 此阶段需要的任务上下文，JSON object
    # request.response_schema: 期望响应的 JSON Schema
    # 返回符合 schema 的 dict，也可返回包含 JSON object 的字符串。
    return your_json_model(request.instruction, request.payload, request.response_schema)

optimizer = Optimizer(
    model=model,
    predict=predict,
    evaluate=evaluate,
    config=OptimizerConfig(max_rounds=3, max_trials=20, seed=42),
)
result = optimizer.optimize(
    "Your task instruction with any placeholders you choose",
    [Example(id="document-42", inputs={"text": "..."}, reference=[{"entity": "..."}])],
)
print(result.prompt, result.score, result.stop_reason)
```

上面的 `your_*` 是需要替换的用户函数；完整可运行版本见 [offline_demo.py](examples/offline_demo.py)。任务模型与优化模型可以完全不同。

## 参数检查与报错

库会检查公开入口、数据结构和回调返回值。参数本身有问题时，在调用任务模型/优化模型前报错；回调结果需要在实际返回时检查。错误消息包含具体字段路径、原因和可用的修改提示。

```python
from annobio_optimize import ValidationError

try:
    result = optimizer.optimize(prompt, examples)
except ValidationError as error:
    print(error)       # 完整说明
    print(error.path)  # 可用于定位输入框/数据字段
    print(error.hint)  # 可选的修复提示
```

例如：

```text
examples[1].id: duplicate ID 'sample-1'; first used at examples[0].id. Each Example needs a unique ID.
Example.inputs.documents[1].text: expected a JSON value, received object. ...
evaluate.return[example_id='sample-1']: must be in [0, 1]; received 1.5. Normalize your metric so higher is better.
review.config: expected ReviewConfig, received OptimizerConfig. Construct ReviewConfig(...) ...
```

检查内容包括：

- `model/predict/evaluate` 是否可调用、是否接受约定数量的位置参数；同步接口拒绝直接传入 async/generator 函数。误返回 coroutine/generator 也会报错。
- prompt、样本类型、重复 ID、已提供 observation 的缺失/重复/未知 ID，以及修改的字符区间和目标 ID。
- JSON 数据的具体嵌套位置、非字符串键、NaN/Inf、循环引用和过深嵌套；SDK/Pydantic 对象需要用户先转换。
- 评分范围、布尔标记、比较行计数、配置类型与枚举值；不会把 `"false"` 当成 `False`，也不会把一个 ID 字符串拆成字符列表。
- Verify/Search/Accept 等操作的 suggestion ID；未知 ID 的错误会列出当前可用 ID。`require_verified` 必须是 bool。
- 保存结果的 JSON 格式、版本、必需字段、嵌套字段类型和主要记录引用；加载时指出具体路径，而不是延迟到读取 `score` 时抛出 `KeyError/StopIteration`。

`ValidationError` 下有 `InputTypeError`、`InputValueError`、`CallbackContractError`、`ModelResponseError`；前两类仍分别兼容 Python 的 `TypeError/ValueError`。`UnknownSuggestionError` 仍可按 `KeyError` 捕获。`AnnoBioError` 是库自身公开错误的共同基类，也包含 `ReviewStopped`。

用户回调内部发生的外部错误（例如 `ConnectionError`）保留原异常类型、cause 和 traceback，并添加回调名称、阶段或样本 ID 上下文。原 review 的 Verify/Search 对可恢复运行错误仍使用原有 error 记录/继续策略，记录中也包含上下文；**回调返回格式错误直接抛出，不会悄悄被当成一次效果差的候选**。原有聚类/切分/改写的模型格式回退仍保留，并写入 `notices`。

检查不会替用户判断任务语义：例如 `inputs` 是否必须有 `text` 键、实体如何配对和分数怎么算，仍由自己的回调定义。

`evaluate` 一次评价一条 `Example`，返回 `Evaluation` 或一个 `[0, 1]` 数值，越大越好。指标不在此范围时，由用户先归一化。整体目标是按 `Example.weight` 加权的逐样本均分。库不假定 accuracy、F1、实体配对或任何任务规则；`metrics` 仅用于记录。需要语料级非可加指标时，须自行设计样本分组和评分，不能假定逐文档 F1 均值等于语料级 micro-F1。

`Evaluation(score, feedback="", passed=None, metrics={}, details=None)`：

- `score`：优化目标，有限的 `[0, 1]` 数值，拒绝 NaN、Inf 和 bool。
- `feedback`：可选的自然语言错误说明，提供给诊断模型。
- `passed`：可选的明确通过标记；不提供时使用 `score >= config.pass_threshold`。它决定错误样本选择和完全通过时的提前停止；候选排序仍使用 `score`。
- `metrics`：附加指标；`details`：任意 JSON 结构的细节，两者都保留在记录中并可用于诊断。

一条样本代表一次任务调用，可包含多行预测和多条参考实体；不要为了每个输出实体重复同一条输入。`reference=None` 可以用于没有标准答案、完全由自定义 evaluator 判断的任务。输入、参考、预测和附加数据必须是有限数值构成的 JSON 数据；文件、图片或非 JSON 对象的读取由回调自行处理。

## 优化模型协议

模型收到 `ModelRequest(stage, instruction, payload, response_schema)`。所有响应都为 JSON object，具体字段如下：

| stage | 响应字段 |
|---|---|
| `diagnose` | `summary`, `advice`, `category`, `reference_note`，均为字符串 |
| `cluster` | `clusters: [{issue_ids: [str], label: str}]` |
| `propose` | `old_text`, `new_text`, `rationale`，均为字符串 |
| `segment` | `segments: [str]` |
| `paraphrase` | `candidates: [str]` |

`reference_note` 通常留空，记录疑似参考错误的证据，不改变参考或评分。库负责 issue、cluster、edit、trial 的 ID，模型不能自行决定修改针对哪些样本。

## 可选自动策略：验证与采纳

以下规则只适用于 `optimizer.optimize()`，不应用到 `review()` 的手动工作流。

每一轮先诊断当前失败样本，按分数从低到高选择，最多 `max_failed_examples` 条。问题数超过 `cluster_threshold`（默认 5）时调用聚类模型，否则各自为一组。

每组针对**当前 prompt**生成一个修改，并在**全部输入样本**上评价。候选必须同时满足：

1. 目标样本加权均分严格提高，超过 `min_improvement`。
2. 整体加权均分严格提高，超过 `min_improvement`。
3. 任意样本的得分回退不超过 `max_score_drop`（默认 0）；原本通过的样本也不能变为不通过。

这是一套明确的自动采纳策略。一次修改被采纳后，下一组以更新后的 prompt 和评分为基线；下一轮重新诊断。`result.accepted_edits` 记录采纳的修改。回归检查只针对用户提供的数据，不构成未见数据上的保证。

初次提议没有让目标样本全部通过时，库先切分新文本，再生成各片段的候选，用独立的 Beta 后验做 Thompson sampling。每个片段候选都保留原片段，按原样拼接，不 trim 空白；非法切分退回完整单片段。每个组合在全部样本上评价；回归候选的搜索奖励为 0，其余使用整体加权分。搜索候选仍必须通过上述采纳条件。选取最高分合格候选，同分保留先出现者；完整通过目标样本时提前结束该次搜索。

`max_trials` 是**每组**的候选评价上限，包含最初的提议。取 1 可以关闭片段搜索。组合按最终文本去重；搜索空间耗尽时可以提前结束。纯删除支持验证与采纳，不进行空文本片段搜索。

## 预算、停止与结果

```python
config = OptimizerConfig(
    max_rounds=3,
    max_trials=20,
    max_model_calls=100,   # 所有诊断、聚类、提议、切分、改写回调的总次数
    max_predictions=1000, # 所有任务预测回调的总次数，包含 baseline
    seed=42,
)
```

候选评价前会检查剩余预算能否覆盖整批样本，不生成半批分数。达到预算上限时，已验证且合格的候选仍可被采纳；返回 `budget_exhausted`。初始预测预算必须至少覆盖一遍输入样本。

`stats` 分开记录优化模型、任务预测和 evaluator 的调用次数；预算限制的是库发起的回调次数，回调内部的重试、请求数、token、费用由用户负责。没有隐式网络重试。

默认在一次运行内按完整 prompt 内容缓存整批评价，用于保持候选比较一致、避免重复请求。`cache_evaluations=False` 可以关闭缓存；缓存不跨运行。`seed` 只控制库内搜索随机数，无法保证外部模型可复现。

`optimize(..., is_cancelled=lambda: ..., on_event=callback)` 支持同步协作取消和进度事件。取消在回调边界检查，不能中断正在执行的外部请求；返回最后已采纳版本。baseline 之前取消时分数为 `None`。预测或评估回调异常直接抛出，不会被当成模型质量变差。模型输出解析失败抛出 `ModelResponseError`；聚类/切分/改写的可恢复格式错误使用记录在 `notices` 中的保守回退，无法定位的提议被跳过。

`stop_reason` 为 `perfect`、`converged`、`max_rounds`、`budget_exhausted` 或 `cancelled`。所有输入样本通过才是 `perfect`；一整轮没有采纳任何修改则为 `converged`，它不代表找到了全局最优。

`result` 包含原 prompt、最终 prompt、每个候选的逐样本评分、问题、聚类、精确修改、搜索空间、候选试验、采纳版本链、模型请求/响应、预算计数和停止原因。

```python
from pathlib import Path
from annobio_optimize import OptimizationResult

Path("optimization.json").write_text(result.to_json(), encoding="utf-8")
restored = OptimizationResult.from_json(Path("optimization.json").read_text(encoding="utf-8"))
assert restored.prompt == result.prompt
```

保存是显式操作，导出的记录含用户提供的输入、参考、预测与模型响应。格式带版本号；加载记录用于检查与分析，目前不提供从中断处继续执行的 resume API。

优化数据用于提议、搜索和采纳，属于训练/开发数据。测试集应保持独立，最终用用户自己的 `predict/evaluate` 对选定 prompt 评价，不要把它传入优化过程。

## 测试

安装后从仓库根目录运行：

```shell
python -m unittest discover -s python/tests -v
```

数据结构和现有实现的差异见 [DESIGN.md](DESIGN.md)。
