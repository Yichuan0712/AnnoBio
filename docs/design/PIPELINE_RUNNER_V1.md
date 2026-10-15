# Pipeline Runner v1

日期：2026-10-01。状态：Phase 1 Runner、可靠恢复及静态分支兼容验收已在后端实现。目前没有用户入口：Current Pipeline 面板和 Agent 都不能启动整条 Pipeline，Runner 只通过 API 和测试使用。

## 1. 责任边界

Runner 消费 `PipelineSpec v1`，串行执行其中的 LLM 与 Process job，并持久化本次运行的数据。编译器仍然无执行副作用；Runner 不修改画布节点、已有 Dataset 或单节点 Run 缓存。

一次运行冻结：

- 编译后的完整 spec；
- 所有入口 Dataset 的表快照；
- 每个 LLM job 使用的凭据 ID（不复制 API key）；
- Prompt、Process 代码、映射、schema 和有效运行设置（已包含在 spec 中）。

运行期间修改画布不会改变已经启动的运行。下游 job 只读取同一 `run_id` 中上游成功提交的 artifact，不读取画布上同名 Dataset 的旧内容。

## 2. 项目归属与存储

每个 start 请求必须给出稳定的 `project_id`。Web 使用现有项目 ID；桌面端把规范化后的 `.yc` 绝对路径做 SHA-256，并以 `desktop:<digest>` 作为 owner。后端看不到原始路径，页面刷新可得到相同 owner，Save As 则有意进入新的运行历史归属。移动或重命名 `.yc` 后不会自动关联旧路径下的历史。该 ID 不使用一次性的 asset session ID。

后端把项目 ID 做 SHA-256 后作为目录名：

```text
backend/data/pipeline_runs/
  active/<run-id>.json                     # 仅活动运行（pending/running/cancelling）有标记
  <project-id-sha256>/
    requests/<request-id-sha256>.json      # request_id → run_id 索引
    <run-id>/
      run.json
      artifacts/<artifact-instance-id>.json
      row_checkpoints/<job-id-sha256>.jsonl
```

这样既隔离项目，又不会把用户提供的路径直接用于文件系统寻址。状态/结果/取消/恢复都同时要求 `project_id + run_id`；使用另一个项目 ID 查询时返回不存在。

运行历史目前长期保留在应用数据目录，不随画布 Dataset 的编辑或清空而删除。已结束的运行可通过 `DELETE /api/pipeline/runs/{run_id}` 删除（运行中返回 409），但界面上目前没有删除入口；自动保留期尚未实现，在此之前不自动删除成功 checkpoint。Web 项目删除目前也不隐式删除运行历史，防止项目管理动作意外抹掉调试记录。

图片/PDF 单元格在 artifact 中保存稳定 asset ID。实际调用模型或 Process 时仍通过现有 `project_session_id` 解析资源。Web/桌面首次 start 需准备该 session；后端重启后恢复含媒体的运行时，客户端应随 resume 提交新 session。完全自动重建媒体 session 属于 P1.5 的重启恢复验收。

## 3. 持久化与 checkpoint

`run.json` 保存 PipelineRun、JobRun、spec、凭据 ID 绑定和 artifact 元数据，不保存 API key，也不保存任何行数据。每个 artifact 保存逻辑位置、实际实例 ID、生产 job/端口、schema、行数和表内容。

`run.json` 只在 Job 或运行状态变化时重写，写入次数与行数无关：

- LLM 每完成一行，只向该 Job 的 `row_checkpoints/*.jsonl` 追加一行（行号、状态、结构化输出、错误及 Job 指纹）。崩溃最多截断最后一行，读取时跳过。恢复只采用指纹与当前 Job 定义相同的记录，所以 Job 或其输入变化后不会误用旧行。
- 行级进度只保存在内存中，状态接口会把它合并进返回结果；attempt 结束时才写入 `run.json`。后端重启后，进度按已有的行 checkpoint 重新计算。
- `request_id` 通过 `requests/` 索引文件直接定位；后端启动时只检查 `active/` 中的标记。这两项的开销都不随运行历史增长。
- Windows 上替换文件时，如果遇到扫描或索引程序的短暂占用，会有限次重试。

提交顺序固定为：

1. 将 artifact 完整写入同目录临时文件；
2. 原子替换为最终文件；
3. 计算并记录 SHA-256 摘要；
4. 最后原子更新 `run.json`，把 JobRun 标记为 `succeeded`。

读取 artifact 时重新核对摘要。LLM 某些行失败时，部分结果可作为 `valid: false` 的 artifact 预览，但 job 标记失败且下游不会消费。恢复时保留已经成功的 job 和 artifact，只重置失败/取消/中断的 job 及后续 blocked job。

## 4. 执行语义

- v1 按 spec 的稳定拓扑顺序串行执行 job；LLM job 内继续使用节点自己的逐行并发设置。
- LLM adapter 复用现有结构化输出模型、空输出判断、媒体解析和重试设置，并物化 `Input:` / `Output:` 列。
- table Prompt 可为一个输入产生多行，并保留输入行序号。
- 空输入 LLM 不调用模型，但会生成带确定 schema 的空 artifact。
- 空输入 Process 仍执行；`process_df_exec.py` 额外返回显式列名，因此空 DataFrame 的动态 schema 不会丢失。
- Process 多输入仍以 `df` 为主表，其他输入使用编译后的别名，不做隐式 join。
- 任一 job 失败后 fail-fast；未启动 job 标记 `blocked`。
- cancel 禁止启动新 job，并终止活动 Process 子进程。已经发出的模型请求可能产生费用；其迟到结果不能把已取消 Pipeline 改回成功。

## 5. API

### 编译

`POST /api/pipeline/compile`

请求包含 `canvas_state`、具体 `route` 和 `input_dataset_ids`。成功或静态校验失败都返回 `{spec, diagnostics}`；该接口不创建运行、不调用模型、不运行 Process。

### 启动

`POST /api/pipeline/runs`

在编译字段之外增加 `project_id`，媒体输入可增加 `project_session_id`。编译或凭据绑定错误返回 400；创建成功返回 202 和运行状态。

### 状态、取消、恢复和结果

```text
GET  /api/pipeline/runs/{run_id}?project_id=...
POST /api/pipeline/runs/{run_id}/cancel?project_id=...
POST /api/pipeline/runs/{run_id}/resume
POST /api/pipeline/runs/{run_id}/revisions
GET  /api/pipeline/runs/{run_id}/results?project_id=...&logical_id=...
```

resume body 包含 `project_id`，媒体恢复可增加新的 `project_session_id`。results 默认返回 spec 声明的最终输出；传 `logical_id` 可读取一个中间逻辑 artifact。失败行产生的部分 artifact 默认允许预览，但带 `valid: false`。

start 和 revisions body 可带 `request_id`。同一项目内重复提交相同 ID 会返回第一次创建的运行，不会启动第二个 worker。revisions 还包含当前画布、路线和输入；它创建新的不可变运行，并通过指纹复用父运行中仍有效的成功 checkpoint。Resume 始终使用原运行的冻结 spec/输入；对已在恢复中的运行重复调用是幂等查询。

status/start/resume 的公开响应包含 `plan`，用于显示本次冻结的输入行数、Job 依赖、模型名称、有效设置和预计调用量。该响应不包含 API key。Process 或 table 输出会让后续行数依赖运行时结果，此时 `estimated_calls` 为 `null`，不会伪造精确值。

## 6. 当前限制

- 桌面项目文件移动/重命名后 owner 会变化，需要历史迁移功能才能自动找到旧运行。
- Runner 已验收单源静态命名分支与汇合：一个 Process 可物化多个输出 Artifact，汇合 Job 等待全部输入并只执行一次。多源导出的 CLI 输入绑定、纯 Process Pipeline 检测、ensemble 和分支并发仍属于 Phase 2。
- LLM 按成功输入行续跑；Process 在失败、取消或进程中断后按整个 Job 重跑。用户 Process 可能有外部副作用，因此只提供 at-least-once，不承诺 exactly-once。
- 模型请求发出后不保证可由客户端撤回，Stop 也不保证避免已经发生的费用；晚到结果受 attempt token 和提交前状态检查保护。图片/PDF 的恢复仍需要客户端建立新的 asset session。
- 当前后端进程内串行管理单次 Pipeline 的 job；多次独立 Pipeline 运行可以各自拥有后台线程，尚未增加全局调度配额。
