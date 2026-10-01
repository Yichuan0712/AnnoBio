# PipelineSpec v1：编译契约

状态：Phase 1 已完成；编译器、导出器、Runner 和静态分支兼容使用同一契约。编译器为 `backend/pipeline_compile.py`，消费者为 `backend/pipeline_export_spec.py` 与 `backend/pipeline_runner.py`。整体计划见 [PIPELINE_EXECUTION_PLAN.md](PIPELINE_EXECUTION_PLAN.md)。

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

输入 route 使用现有 `exportRoutePayload` 格式，字段为 `type`、`dataset_node_id`、`process_node_id`、`prompt_node_id` 和 `run_node_id`。它明确选择节点集合；编译器从连接与字段解析依赖，不依赖 route 的排列顺序。

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
  "format_version": 1,
  "inputs": ["dataset:raw"],
  "jobs": [{
    "id": "llm:run-extract",
    "type": "llm",
    "inputs": {"data": "dataset:raw"},
    "outputs": {"result": ["output:llm:run-extract:result"]},
    "depends_on": [],
    "config": {
      "sections": [{"name": "Task", "content": "Extract {text}"}],
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
    {"id": "output:llm:run-extract:result", "name": "Result",
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

这些是逻辑 artifact，不含数据行或存储路径。P1.3 Runner 将它们绑定到每次运行独立、带摘要的实际 artifact；持久化契约见 [PIPELINE_RUNNER_V1.md](PIPELINE_RUNNER_V1.md)。末端 Run 未保存结果 Dataset 时自动获得逻辑 `result`；Process 暂要求已选择的输出 Dataset 来确定分支。

一个 job 输出端口对应 artifact ID 数组，允许同一结果保存为多个逻辑 Dataset；不是对同一个 job 重复执行。每个 artifact 最多一个生产者。

## 配置和凭据边界

LLM job 使用 Prompt+Run 配置快照；只复制列映射、输入类型、sections、输出字段以及支持的数字 Run 设置。继承设置与节点覆盖合并；未提供的默认设置进入 `unresolved_settings` 并产生 warning。

`model_binding.run_node_id` 是符号绑定位置，不是凭据 ID。启动时必须解析并冻结模型、有效设置、可用凭据及输入快照；单有 compiled spec 不表示模型已准备好。导出时解析非敏感模型配置，并去除内部绑定/来源信息。编译器不会复制 canvas 的 credential 字段、缓存结果、Dataset rows 或任意额外属性。用户主动写进 Prompt/代码的内容会作为源代码保留，不承担内容脱敏功能。

## 依赖与入口边界

- Run 读取 `runWorkingSetId`，且必须存在唯一且匹配的 `prompt-to-run` 边。
- Process 读取 `dataset-to-process` 边；主输入绑定为 `df`，其他输入使用已记录的 `df_<alias>`。单输入可推导主输入，多输入必须明确。
- Process 输出读取 `process-to-dataset` 边及 `processOutputName`。单输出旧节点无名字时兼容为 `result`；多输出缺名时报错。
- Dataset 的 `sourceRunNodeId` 是 LLM 生产者。与 Process 生产者冲突时报错。
- 选中 Dataset 的生产者在路线外时，必须通过 `input_dataset_ids` 显式声明“从这份已保存数据开始”；否则报错，避免误把缺失上游的历史缓存当成新输入。
- 已被选中 job 生产的 Dataset 不能同时声明为起始输入。边界不能绕过循环校验。
- 选中数据流必须连通；不因编译而自动加入遗漏节点。

Compiler 支持多入口及纯 Process 图，UI 的识别规则和导出能力仍保持原有范围，后续按 Phase 2 开放。P1.2 前端将路线首个 Dataset 作为显式 `input_dataset_ids`；旧 API 调用方不传时，也将路线首项 Dataset 视为显式入口。后续 job 顺序由编译器的依赖决定。

## Schema 与代码检查

入口 Dataset headers/type 为已知契约，空输入行不使契约失效。已知列可兼容现有 Run 的同名映射推导；没有唯一匹配时报错。默认 `mapping_policy="strict"` 下，动态输入需要明确的列映射。

导出使用明确的 `mapping_policy="legacy_export"`（写入 job config）。动态输入可从 observed schema 推导唯一同名映射，但实际列仍须运行时验证；历史空分支仍无法确定映射时保存 null 并产生 `RUNTIME_INPUT_MAPPING` warning，由生成代码在有数据时推导或报错。历史有数据却无法映射时仍报错。前端只发送 `row_count`，不发送数据行。这些兼容规则属于 compiler，渲染器不自行猜测映射。

Process 只做 AST 解析、入口函数签名和 Dataset alias 检查，不执行代码。要求顶层 `process(df)` 可由一个位置参数调用；P1.2 将老 `process(row)` 的纯文本迁移纳入 compiler，沿用前端适配语义。AST 检查不能保证代码运行成功或返回正确分支；实际返回值必须在运行时检查。

所有 Process 输出为 `schema.status = runtime`；历史 Dataset schema 仅保留为 `observed_schema`。下游 LLM 在执行前验证真正产生的列和类型。即使代码看似简单，也不假定保存的表结构是新代码的返回契约。

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
