# Evaluate History 与 Optimize 固定来源

## 用户操作

- Evaluate 的规则与代码两种模式都使用 **Run**。每次点击创建独立记录；相同设置重跑也保留两次结果。
- History 使用现有选择器。选择完整的评估记录时，确认后恢复评估设置、Ground truth，以及对应 Generate 和上游输入。
- 修改规则、代码、模式、Ground truth、评分行选择或上游输入后，保留上一次评估的表格和指标，并显示：
  `These results are from an earlier setup: its inputs have changed since. Run to update them.`
- 从当前有效评估创建 Optimize。**一个 Optimize 节点终身绑定一条 Evaluate History**，不提供重新绑定操作。
- Generate 重跑后，Evaluate 保留旧结果，并提示：
  `These results are from an earlier Generate run. Run Evaluate to update them.`
- Optimize 只比较绑定记录与 Evaluate 当前显示的 History 记录（包括过期但仍显示的记录）。记录 ID 不同才显示：
  `This optimization uses a different Evaluate History record.`
  提示显示在 Findings 标题下方。Optimize 窗口不提供查看来源或创建新 Optimize 的入口。
  Generate 重跑、评估规则修改等造成 Evaluate 输入过期时，若仍显示原来的评估记录，Optimize 不显示版本提示。
- 画布上的过期 Evaluate 和版本不匹配的 Optimize 使用 60% 不透明度；提示、标记与透明样式采用相同判定。

## 保存的数据

沿用现有 `score` History 类型，完整评估记录增加 `evaluationVersion: 1`。

| 数据 | 内容 |
| --- | --- |
| 来源 | Generate 的记录 ID、Generate 节点 ID |
| 实际输入 | Prompt 及输出 schema、Generate 输入表、输入映射、结果与字段、模型凭据 ID、节点参数 |
| 评估设置 | Ground truth 的实际表格、规则、代码、匹配模式、排除行 |
| 结果 | 指标、导出表（规则模式）、配对与各规则判断、代码匹配结果、Optimize comparison rows |

每次 Run 先记录 `running`，再保存 `completed`、`failed` 或 `stopped`。
桌面和 Web 存储均拒绝改写已完成的完整评估，允许相同签名有多条记录。
失败和停止记录保留在 History 中，不能用来恢复当前评估或启动 Optimize。
重新打开项目时，未完成的 Evaluate 尝试标记为停止；重新 Run 创建新尝试。

## Optimize 的读取约束

Optimize 与前方 Evaluate 当前显示的 History 记录不一致时，节点显示 `Historical` 并变淡，Findings 下说明版本不匹配，Apply 禁用。
窗口打开期间切换 History 也会同步按钮；实际 Apply 和 Agent `apply_review` 均重新校验版本，失败时不创建 Prompt 或修改建议。
切回绑定的 History 后恢复 Apply。Evaluate 因 Generate 重跑而过期，但仍显示 Optimize 绑定的记录时，不影响 Apply。

节点保存 `evaluateRecordId` 和 `evaluateNodeId`。当前评估 History 切换仅影响版本不匹配提示，
不改变绑定、不清除优化结果。Optimize 初次运行、Resume、Verify、单条建议优化都从绑定记录读取
Prompt、schema、输入、Ground truth、规则或代码。模型凭据 ID 和 Generate 节点参数也取自快照。
Verify 仍会发起新的模型请求和匹配计算，所用输入与判定配置来自原评估。

删除记录时，仍在画布上的 Optimize 保护其绑定来源；
删除上游 Generate/Process History 的级联删除也遵守这个约束。

## 旧项目

没有完整输入快照的旧评估保留在 History 中，标注不完整且不能恢复。
旧 Optimize 已保存的内容仍可查看，但不会自动绑定当前评估；重新执行或验证需要先 Run Evaluate，
再创建新的 Optimize。项目保存、复制、导出和导入沿用现有 History 存储，不修改已有记录。

## 回归入口

- `app/tests/evaluationHistory.test.mjs`：独立尝试、失效、恢复、绑定、删除保护、取消、项目切换、中断恢复。
- `app/tests/runHistoryStorage.test.mjs` 与 `backend/test_project_history.py`：两端存储的多次评估与不可改写约束。
- 浏览器集成检查覆盖实际 Evaluate 窗口、History、旧结果提示、Optimize 来源、Verify 与 Resume。

## 指定示例存档修复（2026-10-16）

修复文件：`examples/Kinase–Substrate Evidence Curation - direct connections (before cleanup 2026-10-16).yc`。
原文件备份：`.cache/archive-backups/` 下同名文件，后缀 `.922da8102e1c.bak`。
原文件 SHA-256：`922da8102e1c7a04cdf2afa3af0d705725dab77602efbaee528317e2849a27f5`。

- 保留全部 43 条原始 History，新增 7 条完整评估快照与 5 条固定来源的 Optimize 缓存记录。
- 6 条旧评估依据原输入与签名恢复；另 1 条由两次 Optimize 中保存的评估签名、Prompt 和 Generate 结果唯一核实。
- 两份修改过的 Ground truth 从旧 Optimize 的比较行恢复，再验证其哈希与原评估签名完全一致。其余 Ground truth 直接验证存档表格的哈希。
- 匹配规则仅在本地重算，没有调用模型；已有 Optimize 比较行与重算结果核对后原样保留。每条新增记录的 `recovery` 字段记录修复来源。
- 补齐 Evaluate 的历史指针、恢复 5 个 Optimize 的原结果并固定其来源。没有改动其他节点、连线、原始模型结果、数据表、附件、对话或 Pipeline 执行记录。
- 加载修复后的实际画布验证：3 个 Evaluate 过期、3 个 Optimize 版本不匹配，均为 60% 不透明度；2 个 Optimize 与前方显示的 History 匹配，保持正常显示。

### 后续重新评估与清理（同日，用户授权删除旧记录）

- 使用存档当时选中的有效 Generate 结果，重新计算 3 个 Evaluate；F1 分别为 pairs 50%、uniprot 50%、sites 0%。
- 删除 10 条未被引用的旧评估与 8 条失效旧 Optimize 缓存。5 个现有 Optimize 的结果和绑定不变，保留它们依赖的 3 条来源评估。
- 存档共保留 40 条 History，3 个 Evaluate 均匹配当前 Generate，正常显示；现有 Optimize 因绑定旧版本显示版本提示与透明样式。
- 重跑前备份后缀为 `.before-evaluate-rerun.983134f054b7.bak`，仍保存在 `.cache/archive-backups/`。
- 已通过实际画布验证指标、当前记录、History 清理和 Optimize 来源；规则计算在本地完成。
