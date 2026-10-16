# Agent 与界面功能对齐

Agent 的写入继续通过提案卡片确认，执行代码和模型任务通过执行卡片确认。界面的纯布局变化
不需要新增工具；涉及配置、数据和运行行为的变化应同步到工具定义、校验器、执行入口和指南。

| 功能 | Agent 入口与规则 |
| --- | --- |
| Prompt 文本、输入类型、输出 schema | `add_prompt`、`add_prompt_version`、`update`；文本整段替换（`text`）或按片段替换（`text_edits`，每个 old 只出现一次）；保留 Allow None、数字和嵌套列表示例；字段名大小写不敏感地唯一 |
| Dataset 行列与类型 | `add_dataset`、`update`；Text/Image/PDF 列；已有文件单元格保持结构，`row_ids` 保留删除/重排行的身份 |
| Dataset 副本与版本 | `duplicate_dataset`；版本通过 Dataset 版本边连接，保留行身份；副本独立；均不计为新的 Sample 输出 |
| 表格内移动图片 | `move_image`；同一 Dataset 的图片列间移动，源单元格移除，目标追加；遵守内容锁 |
| Sample 配置及重复抽样 | `add_sampler` 可仅创建配置；`sample_dataset` 使用已有 Sample；与画布共用抽样代码；不放回有限、指定行/放回可重复 |
| Sample 进度与锁定 | `inspect_node`/workspace summary 显示模式、已抽/剩余次数；首个真实输出后锁定 Sample 设置及原始 Dataset 内容 |
| 独立 Run/Process | 可先创建空输入节点再 `connect`；Process 可先写代码；`duplicate_process` 复制代码而不复制输入/结果 |
| 节点输入与分支 | `connect`/`disconnect` 使用共享端口校验；Run/Process 直接读上游结果或 Process 分支 |
| 单节点执行 | `run_nodes` 支持 Run、Process、自定义代码 Evaluate、Optimize、verify；规则 Evaluate 自动计算 |
| Evaluate 自定义代码 | `score` job 复用 Evaluate 窗口的数据字典和匹配 API，存储同样的结果，支持进度及取消后的部分结果 |
| Evaluate 分组规则及评分行 | `rule_tree` 完整保留嵌套 AND/OR；读取返回原始规则树；`exclude_row_keys` / `include_row_keys` 修改评分行，使用 `read_rows.rowKey`，保留已有 Optimize 的证据 |
| 已有 Process 试跑 | `try_process.process_node_id` 保留实际连接及固定别名，避免源改名后错读；新 Process 才使用 `primary_input` 推断输入 |
| Optimize 状态与恢复 | 中断不返回成功；`resume_review` 恢复已有节点，和界面 Resume 共用入口 |
| Optimize 诊断与建议优化 | inspect 的 diagnostics/data_refinement/stages/verification 分页提供证据；`optimize_suggestion` 与界面共用样本选择和优化算法，产生独立候选，验证另行确认 |
| 单节点停止 | `run_nodes` 的 `stop` 请求取消界面或 Agent 启动的任务，Process / code Evaluate 共用瞬时任务取消句柄；已发出的模型请求可能继续完成；建议验证仍不可中途停止 |
| History | `select_history`/`delete_history` 的预览和应用方法完整传入聊天运行环境；保留原有独立提案要求 |
| 内容锁与删除 | `inspect_node.contentLock` 显示锁定来源；内容更新受相同锁约束；不能删除仍被下游使用的节点，可按用户要求整组删除 |
| 整条 Pipeline | `pipeline_action` 请求运行、停止、恢复、Python 项目导出；`get_pipeline_runs` 查询整条 Pipeline 历史 |

以下仍由用户在界面操作：选择并上传本地新文件、配置凭据与 Python、选择 Current Pipeline 路线、
点击节点文件导出、发布 Gallery。Prompt Version 以横向家族树展示来源，点击节点定位并高亮画布上的 Prompt、点击连线比较版本。
Agent 的指南会说明实际入口，
不会伪造已上传文件、凭据或这些操作的完成状态。已有上传文件可以直接通过 Agent 复用或重排。
桌面底部另有 Log 标签，用于后端日志与前端错误；Agent 不具备读取该日志的工具。

回归入口：`agentCapabilityParity.test.mjs`、`agentScoreCode.test.mjs`、`agentHistoryProposal.test.mjs`，
以及现有 Agent 端口、输入、Pipeline、内容锁与 Sample quota 测试。
`agentAlignment.test.mjs` 覆盖改名后的 Process 试跑、Optimize 中断/恢复、嵌套规则、评分行、诊断分页、
单节点取消、过期确认、跨项目隔离，以及建议优化提交前的输入校验；模型请求使用模拟响应。
