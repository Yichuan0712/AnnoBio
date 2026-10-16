# PipelineSpec v1：编译契约

> 命名更新（2026-10-16）：界面中的 Run 节点现称 **Generate**；操作称 **Run to here / Run this step / Run again**，Settings 的对应页签称 Generate。本文旧称及历史实施记录保留原义；内部 `type: run`、工具名、字段和 API 不变。

状态：Phase 1 已完成；编译器、导出器、Runner 和静态分支兼容使用同一契约。编译器为 `backend/pipeline_compile.py`，消费者为 `backend/pipeline_export_spec.py` 与 `backend/pipeline_runner.py`。整体计划见 [PIPELINE_EXECUTION_PLAN.md](PIPELINE_EXECUTION_PLAN.md)。

`format_version` 2：Prompt 不再分 section，LLM job 的 `config.sections` 改为一段文本 `config.prompt`。不兼容版本 1。

## 调用与结果

```python
from backend.pipeline_compile import compile_pipeline

result = compile_pipeline(
    canvas_state=canvas_state,
    route=selected_route,
    input_dataset_ids=[],
    run_defaults={"run_max_tokens": 8192, "run_max_retries": 2, "run_concurrency": 4},
)
```

编译为纯函数：不读取文件/设置/凭据、不执行 Python 或调用模型、不修改输入对象。`run_defaults` 由调用方传入当前有效默认值；示例数字不由编译器硬编码。

输入 route 使用现有 `exportRoutePayload` 格式，字段为 `type`、`dataset_node_id`、`process_node_id`、`prompt_node_id` 和 `run_node_id`。它明确选择节点集合：所选的 Prompt Run 和 Process，以及它们读取的入口 Dataset。步骤之间传递的输出不出现在 route 中，编译器沿 `data` 连线找到它们，不依赖 route 的排列顺序。

```json
[
  {"type": "dataset", "dataset_node_id": "raw"},
  {"type": "prompt", "prompt_node_id": "extract", "run_node_id": "run-extract"}
]
```

返回 `{ "spec": ..., "diagnostics": [...] }`。任意 error 使 `spec` 为 null，调用方不能误执行半张图。warning 表示还需要配置绑定或运行时校验，不等于已具备启动条件。

diagnostic 包含 `severity`、稳定的 `code`、`node_id`、`node_name`、`field` 和 `message`。同一配置稳定生成排序后的诊断、artifact 和拓扑 job 顺序。

## 最小 spec 示例

以下为单个 LLM job 的结构示例；列类型、字段说明等按实际编译结果填充。

```json
{
  "format": "annobio.pipeline-spec",
  "format_version": 2,
  "inputs": ["dataset:raw"],
  "jobs": [{
    "id": "llm:run-extract",
    "type": "llm",
    "inputs": {"data": "dataset:raw"},
    "outputs": {"result": ["output:llm:run-extract:result"]},
    "depends_on": [],
    "config": {
      "prompt": "Extract {text}",
      "input_types": {"text": "text"},
      "input_mapping": {"text": "text"},
      "output_schema": {"return_shape": "single", "fields": [
        {"key": "answer", "display": "answer", "type": "str", "description": "", "examples": [], "allow_none": false}
      ]},
      "model_binding": {"run_node_id": "run-extract"},
      "mapping_policy": "strict",
      "settings": {"run_max_tokens": 8192, "run_max_retries": 2, "run_concurrency": 4},
      "unresolved_settings": []
    }
  }],
  "artifacts": [
    {"id": "dataset:raw", "name": "Articles", "producer": null,
     "schema": {"status": "known", "columns": [{"name": "text", "type": "text"}]}},
    {"id": "output:llm:run-extract:result", "name": "Extract",
     "producer": {"job_id": "llm:run-extract", "port": "result"},
     "schema": {"status": "known", "columns": [
       {"name": "Input: #", "type": "text"}, {"name": "Input: text", "type": "text"},
       {"name": "Output: #", "type": "text"}, {"name": "Output: answer", "type": "text"}
     ]}}
  ],
  "outputs": ["output:llm:run-extract:result"],
  "source_map": {
    "dataset:raw": {"node_ids": ["raw"], "names": ["Articles"]},
    "llm:run-extract": {"node_ids": ["extract", "run-extract"], "names": ["Extract", "Run extract"]},
    "output:llm:run-extract:result": {"node_ids": ["extract", "run-extract"], "names": ["Extract", "Run extract"]}
  }
}
```

这些是逻辑 artifact，不含数据行或存储路径。P1.3 Runner 将它们绑定到每次运行独立、带摘要的实际 artifact；持久化契约见 [PIPELINE_RUNNER_V1.md](PIPELINE_RUNNER_V1.md)。

artifact ID 只有两种（[DATA_FLOW_DESIGN.md](DATA_FLOW_DESIGN.md) §6.2）：

- 入口 Dataset：`dataset:<节点 ID>`，`producer` 为 null。
- 步骤输出：`output:<job>:<端口>`，例如 `output:llm:run-extract:result`、`output:process:split:left`。Run 只有一个端口 `result`。Process 的端口为它的代码静态识别出的分支（`backend/process_outputs.py`），加上被下游读取的分支；没人读取的分支仍是 Pipeline 的输出。

artifact 的 `name` 用于导出的工作表和变量：入口 Dataset 用 Dataset 名，LLM 输出用 Prompt 名，Process 的单一输出用 Process 名，分支用分支名。一个 job 输出端口对应一个 artifact；每个 artifact 恰好一个生产者。

## 配置和凭据边界

LLM job 使用 Prompt+Run 配置快照；只复制列映射、输入类型、Prompt 文本（`prompt`，去掉首尾空白）、输出字段以及支持的数字 Run 设置。继承设置与节点覆盖合并；未提供的默认设置进入 `unresolved_settings` 并产生 warning。

`model_binding.run_node_id` 是符号绑定位置，不是凭据 ID。启动时必须解析并冻结模型、有效设置、可用凭据及输入快照；单有 compiled spec 不表示模型已准备好。导出时解析非敏感模型配置，并去除内部绑定/来源信息。编译器不会复制 canvas 的 credential 字段、缓存结果、Dataset rows 或任意额外属性。用户主动写进 Prompt/代码的内容会作为源代码保留，不承担内容脱敏功能。

## 依赖与入口边界

- Run 和 Process 的输入都是 `data` 连线（`{type: 'data', fromId, fromPort, toId, alias}`）。来源是 Dataset 时读取 `dataset:<id>`，它必须在所选 route 中，否则报 `MISSING_DEPENDENCY`；来源是 Run 或 Process 的端口时读取 `output:<job>:<端口>`，生产 job 不在所选 route 中时报 `UNSELECTED_UPSTREAM`，信息中写明上游节点名。
- Run 恰好一条输入（多条报 `MULTIPLE_RUN_INPUTS`），且必须存在唯一且匹配的 `prompt-to-run` 边。
- Process 的主输入是 `alias` 为 `df` 的那条（只有一条输入时可省略），否则报 `INVALID_PRIMARY_INPUT`；其他输入使用连线上记录的 `df_<alias>`。
- 下游读取的分支不在 Process 的静态识别结果中时报 `UNKNOWN_OUTPUT_PORT`；读取 Run 的非 `result` 端口同样报错。识别为动态输出，或识别为单一输出而下游读取命名分支（例如 `return out`，返回的其实是字典）时，端口按下游读取的为准，并给出 `RUNTIME_PROCESS_CONTRACT` warning，在运行时检查。
- Dataset 只是入口：保存自某个步骤的 Dataset（`sourceRunNodeId` 等）不再把步骤串起来，读取它的步骤从这份表开始。
- 步骤互相读取形成环时报 `CYCLIC_DEPENDENCY`。
- 选中数据流必须连通；不因编译而自动加入遗漏节点。
- 已删除的诊断：`MULTIPLE_PRODUCERS`、`INPUT_PRODUCER_CONFLICT`、`UNSELECTED_PRODUCER`、`MISSING_BRANCH_NAME`（Dataset 不再有生产者）、`UNSUPPORTED_STEP_SOURCE`（步骤来源已支持）。

Compiler 支持多入口及纯 Process 图。前端把所选步骤读取的所有 Dataset 作为 `input_dataset_ids`（`pipelineInputAvailability.js`）；旧 API 调用方不传时，将路线首项 Dataset 视为入口。`input_dataset_ids` 只用于检查入口是否被选中、是否有当前结果。job 顺序由编译器的依赖决定。

## Schema 与代码检查

入口 Dataset headers/type 为已知契约，空输入行不使契约失效。已知列可兼容现有 Run 的同名映射推导；没有唯一匹配时报错。默认 `mapping_policy="strict"` 下，动态输入需要明确的列映射。

导出使用明确的 `mapping_policy="legacy_export"`（写入 job config）。动态输入（步骤输出）的映射为空时保存 null 并产生 `RUNTIME_INPUT_MAPPING` warning，由生成代码在有数据时按唯一同名列推导或报错，用户可在导出的 prompt 模块中补上。Run Pipeline 使用 `strict`，这种情况直接报 `UNMAPPED_INPUT`，避免上游已花费调用后才失败。前端只发送 `row_count`，不发送数据行。这些兼容规则属于 compiler，渲染器不自行猜测映射。

Process 只做 AST 解析、入口函数签名和 Dataset alias 检查，不执行代码。要求顶层 `process(df)` 可由一个位置参数调用；P1.2 将老 `process(row)` 的纯文本迁移纳入 compiler，沿用前端适配语义。AST 检查不能保证代码运行成功或返回正确分支；实际返回值必须在运行时检查。

所有 Process 输出为 `schema.status = runtime`。下游 LLM 在执行前验证真正产生的列和类型。即使代码看似简单，也不假定以前的结果表结构是新代码的返回契约。

对已知输入，LLM 输出契约包含 `Input: #`、输入列、`Output: #`、输出列。字段统一包含结构化 `key` 与原始 `display`，例如 `drug-name` → `key=drug_name, display=drug-name`；归一化碰撞通过后缀消歧。导出直接使用这些字段，不重新归一化。single/table 使用同一列契约，行展开留给执行器。

输入 image/pdf 类型保留；输出列按画布契约标记 text。P1.3 live adapter 与原单节点路径一样保留结构化模型值，同时把物化输出列标记为 text；独立导出仍允许 pandas 暂存数值/list 原值并在 Excel 写出时序列化。两条路径的列名、展开行与空表语义已统一，但文件序列化层仍有表示差异。

P1.2 已统一编译与导出的字段 key/display、列名和依赖。P1.3 live adapter 在消费 artifact 前验证实际列映射，验证 Process 返回 DataFrame/命名分支，保留空 DataFrame 的运行时列，并在输入构建时检查多模态资源。Pipeline Runner 使用本 spec；原有单节点运行路径为兼容旧工作流仍保持独立。

## 导出消费者

`compile_and_export` 编译一次并绑定非敏感模型配置；`export_compiled_pipeline` 只接受 spec 和已解析模型配置，不读取画布。`pipeline.json.execution` 保存去除内部模型绑定与 source_map 的可移植结果，原 route/graph 字段保留。多入口/纯 Process 是有效 spec，但当前导出器明确报告能力限制。

每步 Run 设置被保留；`--concurrency` 仅在显式提供时覆盖。`max_retries` 控制生成的逐行调用重试，provider 内原有传输重试/结构化输出降级机制仍保留。CLI/环境变量对模型及 engine 的全局覆盖行为保持不变。

## 验证

```text
python -m unittest backend.test_pipeline_compile backend.test_pipeline_export backend.test_pipeline_export_spec -v
backend/.venv/Scripts/python.exe -m unittest backend.test_pipeline_export_api backend.test_pipeline_runner_api -v
backend/.venv/Scripts/python.exe -m unittest backend.test_pipeline_runner -v
node --test --test-isolation=none app/tests/pipelineRouteSelection.test.mjs app/tests/pipelineExportDefinition.test.mjs
```

Python 测试覆盖无副作用、选择边界、静态/动态 schema、分支汇合、多入口、纯 Process、恢复所需的不可变配置基础和错误诊断。Runner 测试以 mock LLM 和真实 Process 子进程覆盖串行传递、table 输出、空表、取消、项目隔离和 job 级恢复。跨语言测试通过实际 JS detector/selector 生成路线交给 Python compiler。前端测试保护原有 picker 与分支行为；导出回归测试验证提取路线代码没有破坏原导出。
