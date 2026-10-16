# Run 循环（Repeat）设计

> 命名更新（2026-10-16）：界面中的 Run 节点现称 **Generate**；操作称 **Run to here / Run this step / Run again**，Settings 的对应页签称 Generate。本文旧称及历史实施记录保留原义；内部 `type: run`、工具名、字段和 API 不变。

状态：设计稿，待确认，未实现。基于 2026-09-30 `main`（`c12f51d`）的代码。

## 1. 要解决的问题

有些任务一次调用模型做不好，需要把模型的输出再喂回给它，让它在上一轮的基础上修正、补全或追问，直到满足条件为止。例如：

- 先抽取候选实体，再让模型逐轮核对、剔除错误项；
- 让模型写出答案后自查，发现问题就改；
- 多轮补全一个结构化记录，直到所有必填字段都有值。

现在画布是单向的流程图（Dataset → Prompt/Run → Process → Dataset …），不能连出环。能做的只有把同一个 Prompt 在画布上串 2 到 3 次，轮数写死，改一处要改好几处。

## 2. 已定的决定

| # | 问题 | 决定 |
|---|---|---|
| 1 | 循环放在哪一层 | **放在 Run 里，每一行各自循环**。不新增 Loop 节点，画布仍然是单向的 |
| 2 | 停止条件 | **固定轮数**（必有的上限）+ 可选的 **Python 条件** |
| 3 | 先设计还是直接做 | 先出这份设计，确认后再实现 |

放在 Run 里的原因：

- 画布结构不变，`pipelineDetection.js`、代码导出的步骤顺序、Agent 读画布的方式都不用改结构，Run 只是多了几个参数；
- Run 已经有“数据集列 → Prompt 输入”的映射，循环只是给映射多加一种来源：“上一轮的输出字段”；
- 后端和导出代码的改动都集中在“处理一行”的函数里，把一次调用换成一个有上限的循环；
- “输出喂回给自己”本来就是逐行发生的。跨多个步骤的大循环暂不考虑（见第 10 节）。

## 3. 用户看到的样子

Run 详情左栏，在 “Map input dataset columns to prompt inputs” 下面加一个可折叠的 **Repeat** 区域，默认关闭。打开后：

1. **Rounds**：最多几轮，整数，1–20，默认 3。1 等于不循环。
2. **Feed back**：输入映射表里，每个 Prompt 输入的下拉框除了数据集列，多一组选项 “Previous round → `<输出字段>`”。选了它的输入：
   - 第 1 轮取 **Initial value**：另一个下拉框，可选数据集的某一列或 “(empty)”；
   - 第 2 轮起取上一轮对应输出字段的值。对象或列表按 JSON 字符串填入。
3. **Stop early（可选）**：一个小代码框，写 Python 函数，每轮结束后调用一次，返回真就提前停：

   ```python
   def should_stop(output, round, inputs):
       # output: 本轮的结构化输出（dict）
       # round:  本轮序号，从 1 开始
       # inputs: 本轮实际填进 Prompt 的输入值（dict，键是 Prompt 输入名）
       return output.get("done") is True
   ```

   没写就只按 Rounds 跑满。用的解释器和 Process 一样，是 Settings → Python 里设的那个；没设时 Run 按钮前给出同样的提示。
4. Run 按钮旁提示调用量：“Up to N × rows model calls”。

至少有一个输入选了 “Previous round” 才允许打开 Repeat。否则每一轮的输入都一样，没有意义。

## 4. 节点数据

Run 节点新增一个字段，和现有的 `runInputToColumn` 并列：

```js
node.dataset.runLoop = JSON.stringify({
  enabled: true,
  maxRounds: 3,
  feedback: [
    // Prompt 输入 previous_answer：第 1 轮取数据集列 draft（或 initialColumn: '' 表示空），之后取输出字段 answer
    { input: 'previous_answer', outputField: 'answer', initialColumn: 'draft' },
  ],
  stopCode: 'def should_stop(output, round, inputs):\n    return output.get("done") is True\n',
});
```

- 出现在 `feedback` 里的输入，不再写进 `runInputToColumn`，映射校验（“Unmapped: …”）把它们视为已映射；
- `outputField` 用输出 schema 里的 `key`。schema 改名或删字段后，打开 Run 详情时标红，Run 按钮禁用，和现在映射到已删除列的处理方式一致；
- `getCanvasState()` / `loadCanvasState()`、项目保存、复制节点、Gallery 发布都要带上这个字段。旧项目没有这个字段，等于未开启。

## 5. 前端 → 后端

Prompt 由前端渲染。前端遇到填不上的 `{key}` 本来就会保留原文（`prompt_template.py` 的文档里写了这一点），这里正好利用：

- 前端渲染每行的 `samples` 时，**不给 feedback 输入传值**，它们在文本块里保留为 `{previous_answer}`；
- 每行额外带上第 1 轮的初始值；
- 请求体多一个 `loop` 字段：

```jsonc
{
  "credential_id": "...",
  "samples": [
    { "content": [...], "loop_initial": { "previous_answer": "..." } }
  ],
  "output_schema": { ... },
  "run_node_id": "...",
  "loop": {
    "max_rounds": 3,
    "feedback": [{ "input": "previous_answer", "output_field": "answer" }],
    "stop_code": "def should_stop(...): ...",   // 可为空
    "python_path": "C:/.../python.exe"          // stop_code 非空时必填
  }
}
```

这样前端现有的多模态渲染（图片、PDF 块）完全不用动。后端只替换文本块里 feedback 输入的占位符，用的是 `prompt_template.py` 那套正则，只替换 `loop.feedback` 里列出的名字。

已知限制：如果数据集的单元格内容里恰好有字面的 `{previous_answer}`，也会被替换。概率很低，在文档里说明即可。

## 6. 后端执行

`backend/main.py` 的 `_do_run_work` → `process_one(row_index, prompt)`：

```text
values = sample.loop_initial
rounds = []
for r in 1..max_rounds:
    content = 把 content 的文本块里 {feedback 输入} 替换成 values
    out = llm_run_structured(...)          # 现有的重试、空输出判断原样保留，按“每一轮”计
    rounds.append({round: r, output: out, error: None})
    if 本轮出错: 结束，本行记为错误（带上已完成的轮次）
    if stop_code 且 should_stop(out, r, values) 为真: 结束
    if 取消: 结束
    values = { f.input: 序列化(out[f.output_field]) for f in feedback }
最终结果 = 最后一轮的 output
```

- **Python 条件**：每个 run job 建一个 `process_exec._RowRunner`，包装函数从 `process(row)` 换成 `should_stop(output, round, inputs)`，每轮发一行 JSON。行是并发跑的（`run_concurrency`），而 runner 一次只能处理一个请求，所以调用时加锁。这个检查很快，锁不会成为瓶颈。超时沿用 `ROW_TIMEOUT_SEC`（10 秒）；出错或超时时，这一行停在当前轮，记为错误：`Stop condition failed at round N: …`。
- **返回形状**：v1 只支持 `return_shape` 为单个对象的 Prompt。输出是表格（一行输入对应多行输出）时，“上一轮的某个字段”指哪一行说不清，所以前端禁用 Repeat 并说明原因。
- **进度**：`completed/total` 仍按行计。行内轮次不单独汇报进度，但日志里每轮打印 `[Run] Row i round r/N`。
- **取消**：每轮开始前检查 `_run_cancelled`，和现在每次重试前检查一样。

## 7. 结果与下游

每个结果项多一个字段，其余不变：

```jsonc
{ "row_index": 0, "input_row_index": 0,
  "output": { ...最后一轮... }, "error": null,
  "rounds": [ { "round": 1, "output": {...} }, { "round": 2, "output": {...} } ],
  "stopped_by": "condition" }   // "condition" | "max_rounds" | "error" | "cancelled"
```

- **Run Results 表**：`Output:` 各列仍显示最后一轮。新增一列 `Rounds`，显示 “2/3 · stopped by condition”，点开能按轮查看每一轮的输出；
- **Score / Review / 保存为 Dataset / 导出 CSV**：只用 `output`，也就是最后一轮，不需要改；
- **续跑**：按行续跑的逻辑不变。一行的所有轮次是一个整体，中途失败就整行重跑；
- **Review 的局限**：Review 只看得到最后一轮的输出，看不到中间轮次，所以它给出的修改建议只针对“最终结果”。v1 接受这个局限，见第 10 节。

## 8. 代码导出

`backend/pipeline_export.py` 的 `run_prompt_step` 加一个 `loop` 参数（`None` 表示不循环）：

- `run_one` 里对每行用同样的循环：`values` 先取映射列和初始值，每轮后用输出字段更新 feedback 输入，再调用 `compile_prompt_content`；
- `stop_code` 原样写进导出的 prompt 模块，作为模块里的 `should_stop` 函数。导出的程序本身就是 Python，直接调用即可，不需要子进程；
- 导出的结果表多一列 `Output: rounds`（实际跑了几轮）；
- `test_pipeline_export.py` 加一个用假 engine 的循环用例：固定轮数、条件提前停、条件出错三种情况。

## 9. Agent

- 快照（`workflowSnapshot.js`）里的 Run 带上 `loop`；
- `add_run` / `update_run` 操作接受 `loop`（字段同第 4 节），由 `changeSet.js` 校验：feedback 输入必须是 Prompt 的输入，`output_field` 必须在 schema 里，`max_rounds` 在 1–20；
- 在 Agent 的 prompt-optimization 相关说明里补一句：开了 Repeat 的 Run，Score 看的是最后一轮。

## 10. 不做的（v1）

- **跨多个步骤的循环**（例如 Prompt A → Process → Prompt B → 再回到 A）：需要真正的 Loop 节点，执行引擎、流程识别、导出、Agent 都要改。等真实场景出现再单独设计；
- **表格输出的循环**：见第 6 节；
- **把全部历史轮次都喂给模型**：v1 只喂上一轮的字段。需要历史的话，可以让模型在输出里维护一个累计字段（例如 `notes`），把它 feed back 回去即可；
- **模型自报 done 作为内置选项**：用 Python 条件 `output.get("done") is True` 就能实现，不单独做开关。

## 11. 待确认

1. Rounds 上限定 20 是否合适？
2. 中间轮次是否也要能在 Results 里导出（例如导出时可选 “all rounds”）？
3. 网页版：Python 条件依赖 Settings → Python 的解释器，和 Process 一样。网页版用户如果没有可用的解释器，是否接受 “只能用固定轮数”？

## 12. 实现顺序

1. 后端：`RunRequest.loop` + `process_one` 循环 + `_RowRunner` 包装 `should_stop`，加单元测试；
2. 前端数据：`runLoop` 字段、渲染时保留 feedback 占位符、请求体、canvas 保存与加载；
3. 前端界面：Repeat 区域、映射下拉的 “Previous round” 选项、Results 的 Rounds 列与按轮查看；
4. 代码导出与测试；
5. Agent 快照与操作；
6. Guide 里加一节示例（自查修正）。
