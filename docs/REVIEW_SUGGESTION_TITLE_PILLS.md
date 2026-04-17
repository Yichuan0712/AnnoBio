# Review 建议卡片标题行标签（Title pills）

本文档描述 **Review 详情里每条建议标题右侧** 的单个状态标签：文案、CSS 类名、颜色变量，以及 **数据字段如何决定显示哪一种**，和常见 **状态流转**。实现入口：`app/src/reviewDetailModal.js` 中的 `collectSuggestionTitlePills`；样式：`app/src/modals.css`（约 3475–3634 行）。

---

## 1. 标签一览（格式与颜色）

每条建议 **最多显示一个** 标题标签；与 `#序号` 徽章（`.review-detail-suggestion-num`）不同，后者不是「Verified」这类语义标签。

| 显示文案 | CSS 类（另加 `.review-suggestion-title-pill`） | 文字色（CSS 变量 → 默认回退） | 背景 |
|--------|-----------------------------------------------|--------------------------------|------|
| **Proposal** | `.review-suggestion-proposal-tag-pill` | `--review-proposal-tag-text` → `#1d4ed8` | `color-mix` 约 20% 提案蓝 + 透明 |
| **Row check passed** | `.review-suggestion-rowcheck-pass-pill` | `--diff-added-text` → `#15803d` | `--diff-added-bg` → `rgba(22, 163, 74, 0.22)` |
| **Verifying** | `.review-suggestion-verifying-pill` | `--text-muted` → `#64748b` | `color-mix` 约 14% muted + 透明 |
| **Finetuning** | `.review-suggestion-tuning-pill` | 同 Verifying | 同 Verifying |
| **Finetuned**（未定 pass/fail） | `.review-suggestion-finetuned-pill` | 同 Verifying | 同 Verifying |
| **Finetuned** + 复检通过 | `.review-suggestion-finetuned-pill.review-suggestion-finetuned-pill--pass` | 同 Verified | 同 Verified |
| **Finetuned** + 复检未通过 | `.review-suggestion-finetuned-pill.review-suggestion-finetuned-pill--fail` | `--warning` → `#b45309` | `color-mix` 约 18% `--warning` + 透明 |
| **Click to Finetune** | `.review-suggestion-rowcheck-fail-pill`（可选 `.review-suggestion-rowcheck-fail-pill--click-finetune`） | 同 Finetuned--fail | 同 Finetuned--fail |

**交互：**

- 绝大多数标签为 `<span>`，不可点（`pointer-events: none`）。
- 仅当失败条目标签 **允许 Finetune** 时，渲染为 `<button>`，并带 `data-review-title-pill-action="finetune"`；加上 `--click-finetune` 后出现手型与 hover 轻微变亮。

**无障碍：**

- `Proposal` 使用 `aria-label`：`Edit proposed in chat; not Run+Score verified`（常量 `REVIEW_SUGGESTION_PROPOSAL_TAG_ARIA`）。
- 可点击的 Finetune 按钮：`aria-label="Finetune this suggestion"`。

---

## 2. 与诊断区弱标签的视觉族

`.review-detail-diagnosis-tag`（`modals.css`）为诊断卡片等处的 **小号灰底标签**；样式注释写明 **Verified等 title pill 与其同类弱样式**（非按钮外观）。当前仓库内 title pill **不** 复用该类名，但 **视觉层级一致**：小字号、圆角、弱对比。

---

## 3. 判定优先级（`collectSuggestionTitlePills`）

自上而下 **先匹配先返回**（与 `sug.source === 'assistant'` 等有关）：

1. **`source === 'assistant'`** → 仅 **Proposal**（不参与下方 Verify/Finetune 链）。
2. **`review_finetune_in_progress === true`** → **Finetuning**。
3. **`review_finetune_completed === true` 且 Run+Score 进行中**（`isReviewRowCheckInProgress`）→仍显示 **Finetuning**（与优化中同款灰 pill，表示流水线仍在动）。
4. **`review_finetune_completed === true`** → **Finetuned**；再根据 `getSuggestionTestOutcome` 加 `--pass` / `--fail` / 无修饰（未定 outcome时保持灰）。
5. **Run+Score 进行中** → **Verifying**。
6. **`actionsFull === true`** 时：
   - outcome **`pass`** → **Verified**；
   - outcome **`fail`** → **Click to Finetune**；若 `rowCheckFailPillCanStartFinetune` 为真则加 `--click-finetune` 并渲染为按钮。
7. 否则 **不显示**标题标签。

说明：**Verified** 在用户文案上对应 Run+Score **通过**（常量 `REVIEW_SUGGESTION_ROWCHECK_PASS_LABEL = 'Verified'`），不是单独的字段名 `verified`。

---

## 4. 数据字段与 outcome 读取

### 4.1 Run+Score 是否进行中

- `isReviewRowCheckInProgress(sug)`：`sug.review_test_in_progress === true || === 1`。

### 4.2 通过 / 失败（`getSuggestionTestOutcome`）

- 若存在 Finetune 前后文本（`suggestionFinetuneHasBeforeAfterText`：`review_finetune_completed` 且 meta 中 `newSentenceBeforeFinetune` 与当前 `new_sentence` 不同）→ 只读 **`review_test_result_finetune_after`**（或回退 legacy字段，见 `getSuggestionTestOutcomeAfterSlot`）。
- 否则读 **`review_test_result`** 为 `'pass' | 'fail'`。
- 兼容：**`review_test_passed === true`** 视为 **`pass`**。

相关键名常量：`REVIEW_TEST_RESULT_FINETUNE_AFTER` / `REVIEW_TEST_RESULT_FINETUNE_BEFORE`（`reviewDetailModal.js`）。

### 4.3 Finetune 状态

-进行中：`review_finetune_in_progress === true`（及可能的 `review_finetune_progress` 等，见清除 stale 逻辑）。
- 已完成：`review_finetune_completed === true`；完成后标题为 **Finetuned**，复检结果仍用上一节的 outcome。

### 4.4 「Click to Finetune」何时可点（`rowCheckFailPillCanStartFinetune`）

需 **同时** 满足：

- 卡片可定位（非 `noButton` / 非 unlocatable）；
- `getSuggestionTestOutcome === 'fail'`；
- 不在 `review_finetune_in_progress`；
- 未被 `suggestionFinetuneRowCheckNudgeBlocked` 拦住（例如：Finetune 已完成但无有效 before/after 文本时，不再引导点击 Finetune）；
- 尚未 `review_finetune_completed`（已完成则走 Finetuned 分支）。

### 4.5 `actionsFull`（何时显示 Verify结果 pill）

由 `suggestionActionsFullForCard` 决定（简化理解）：

- **Assistant** 建议：恒为 `true`（但标题只显示 Proposal，不显示 Verified/Fail）。
- Review **流未完成**（`saved.streamComplete !== true`）：多数情况下 `actionsFull` 为 `false`（除非当前无任何建议），此时 **不会出现** Verified / Click to Finetune。
- 不需要自动 Row-check 的建议：视为 `true`。
- 否则：Run+Score **未**在进行时 `actionsFull` 为 `true`（进行中则按钮区可能 pending，标题仍可能先显示 Verifying）。

Finetune 进行中且 `streamComplete`：仍可为 `true`，便于继续 Accept/Revert。

---

## 5. 典型转换关系（状态流）

以下仅描述 **流水线建议**（非 Assistant）标题标签的常见路径：

| 从 | 到 | 典型触发 |
|----|----|----------|
| （无 pill） | **Verifying** |开始 Run+Score，`review_test_in_progress` 置位 |
| **Verifying** | **Verified** | 复检通过 → `review_test_result` / slot 为 `pass`（或 `review_test_passed`） |
| **Verifying** | **Click to Finetune** | 复检失败 → `fail`；若可 Finetune 则加可点击样式 |
| **Click to Finetune** | **Finetuning** | 用户点击启动 Finetune |
| **Finetuning** | **Finetuned**（灰） | Finetune 完成，`review_finetune_completed`，outcome 尚未写入 |
| **Finetuned**（灰） | **Finetuned** + 绿 / 橙 | 对 Finetune 后文本再次 Run+Score → `pass` / `fail` |
| **Verified** | **Verifying** | 文本或目标变更后重新触发校验（实现中若清空 outcome 再跑） |
| 任意 | **（无 pill）** | `actionsFull` 为 false（例如 review 未完成且无例外） |

**Assistant 路径：** 始终 **Proposal**，不随 `review_test_result` 切换为 Verified（对话提案不参与 Run+Score 验证 pill）。

---

## 6. 维护时请同步更新

修改标签文案、类名、颜色或判定顺序时，请同时更新：

- `app/src/reviewDetailModal.js`（常量与 `collectSuggestionTitlePills`）
- `app/src/modals.css`（上述 pill 选择器）
- **本文档**

---

## 7. 源码锚点（便于跳转）

- 标签收集：`app/src/reviewDetailModal.js` — `collectSuggestionTitlePills`, `buildSuggestionTitlePillsHtml`
- Outcome / 进行中：`getSuggestionTestOutcome`, `isReviewRowCheckInProgress`, `suggestionFinetuneHasBeforeAfterText`
- 样式：`app/src/modals.css` — `.review-suggestion-*-pill` 区块
