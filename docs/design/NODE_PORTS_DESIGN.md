# 节点端口：设计草案（讨论稿）

状态：第一部分（端口和拖线，第 1–10 节、第 12 节）已定；第二部分（统一的运行入口、Pipeline 里的 Prompt，第 11、13 节）待讨论。基于 `261007-data-flow-design` / `790c0a7`（2026-10-09）。

## 1. 想法

参照 ComfyUI：每个节点的左边缘是输入端口，右边缘是输出端口，都是小圆点。从一个输出端口拖到一个输入端口就连上；线总是从端口出发、到端口结束。一个节点读什么、产出什么，在画布上直接看得见，也直接能改。

## 2. 为什么现在适合做

- 连线已经是“端口到端口”的了。[DATA_FLOW_DESIGN.md](DATA_FLOW_DESIGN.md) 之后，Run 和 Process 的输入是 `data` 连线，带 `fromPort`（Process 的分支）和 `alias`（Process 代码里的 `df_<名字>`）。只是这些在画布上看不见：要知道一个节点读谁，得打开它的窗口。
- 连线现在只能在窗口的选择器或右键菜单里建立，画布上不能直接拖。
- Process 的分支端口标签（第 2、8 步）已经是这个方向的第一步：线从分支标签出发，缺分支时线变红。

## 3. 要注意的地方

这几点不是不做的理由，而是做的时候要守住的边界：

- **不是所有线都是数据输入。** AnnoBio 画布上还有几类关系：Prompt 的版本（`prompt-to-prompt`）、Dataset 的版本（`dataset-to-dataset`）、保存出来的 Dataset 的来源线（`saved-from`）、Sampler 生成的子集（`sampler-to-dataset`）、Review 应用后得到的新 Prompt（`prompt-review-to-prompt`）。它们是谱系或动作的结果，不是节点运行时读取的东西。ComfyUI 里所有线都是数据流；AnnoBio 也把这些关系画成点和线（已定），但必须和数据线看起来不一样，否则会被当成数据输入，也会让人以为可以拖。所以**只有运行时读取的东西是能拖的端口**（实心点），来历类用空心点，不能拖（第 6 节）。
- **连线有规则。** 类型要对、一个输入只能接一条、不能成环、运行中的步骤不能改输入、Process 的别名来自代码参数。拖线和 Agent 必须走同一套候选和校验（`stepInputs.js` 的 `runCandidateSources`、`processCandidateSources`、`readsFromStep`），不能有一条绕过规则的路。
- **节点要变高。** Run 节点现在只有一行标题，放两个输入端口（Prompt、输入）需要两行。
- **Agent 一致性。** 用户能拖线做到的事，Agent 也要能做（多数已经能：`add_run` 的 `input`、`update` 的 `prompt`/`input`、Process 的代码别名）。断开一个输入这类新操作，要确认 Agent 有对应的写法。

## 4. 端口表（提议）

| 节点 | 左边：输入 | 右边：输出 |
|---|---|---|
| Dataset | 无 | `table` |
| Prompt | 无 | `prompt` |
| Run | `prompt`（必需，一条）、`input`（表，一条） | `result`（表） |
| Process | `df`（表，必需）；每个 `df_<别名>` 一个（表）；再加一个空的 “+” 端口，用来接新输入 | 每个分支一个（表）；单一输出时一个 `result` |
| Sampler | `source`（表） | 无数据输出（生成的样本用来历点，见下表） |
| Score | `run`（只接 Run 的 `result`）、`ground truth`（表） | `score` |
| Review | `score` | 无数据输出（Apply 生成的新 Prompt 用来历点，见下表） |

端口类型：`table`、`prompt`、`score`。Run 的 `result` 也是 `table`，可以接到 Run、Process 的输入；但 Score 的 `run` 端口只接 Run 的 `result`，因为 Score 要用 Prompt 的输出字段来比对。

来历点（空心，不能拖，只在有这条关系时出现）：

| 节点 | 左边：从哪里来 | 右边：生成了什么 |
|---|---|---|
| Dataset | 新建版本、Sample 或保存的来源 | 它的新版本 |
| Prompt | 新建版本或 Review 的 Apply 的来源 | 它的新版本 |
| Sampler | 无 | 生成的样本 |
| Review | 无 | Apply 生成的新 Prompt |
| Run、Process | 无 | 保存出来的 Dataset |

每个节点最多只有一个来源（已核对：Prompt 来自“新建版本”或 Apply，二者取其一；Dataset 来自新建版本、Sample 或保存，三者取其一），所以左边最多一个空心点。

## 5. 交互

- **连接**：从输出端口按下，拖到输入端口松开。拖的过程中，能接的输入端口高亮，其余变暗；规则与窗口的候选列表相同（类型匹配、不成环、不是自己、目标没有在运行）。
- **替换**：拖到一个已经接了线的输入端口上，就替换原来的来源，不弹确认，撤销即可恢复。
- **断开**：从输入端口把线拖走松开，或在线上右键选 Delete。
- **在空白处松开**：弹出创建菜单，内容与现在的右键菜单相同（Run a prompt on results、Process results with code……），新节点已经接好这条线。这相当于 ComfyUI 的搜索框，第一版就做。
- **悬停**：输出端口显示名字、行数和列名；输入端口显示当前来源；不能接的端口说明原因（例如 “This would make a loop”）。
- **Process 的 “+” 端口**：接上一条线，就在 `process()` 的参数里加上这个输入的 `df_<名字>`，效果与现在在 Process 窗口里勾选一个输入相同（这个选择器之后会去掉）；断开一个别名端口，就从参数中去掉它。代码里手写的参数也会出现为端口。
- **只用拖线连接**（2026-10-09 定，与 ComfyUI 相同）：Run 窗口和 Process 窗口不再有选择来源的选择器，窗口里只显示当前来源，点击跳到那个节点。列映射、代码等设置仍在窗口里，相当于 ComfyUI 节点里的控件。
- **右键菜单保留**：“Run a prompt on results”“Process results with code”新建的节点已经接好线，与在空白处松开的创建菜单是同一件事。
- **撤销**：每次连接、替换、断开都是一个撤销步骤。History 项目里换输入的效果与现在相同：有匹配的记录就显示它，否则显示“没有结果”。

## 6. 显示

- 端口是节点边缘上的小圆点，按类型着色；每个端口占一行，圆点旁边写端口名（`prompt`、`input`、`df`、`df_lookup`、分支名……）。
- 线从输出点画到输入点；等待上游、缺分支（红线）等状态沿用现在的样式。
- **所有关系都画成点和线**（2026-10-09 定），只靠圆点区分：
  - 数据：实心点，按类型着色，可以拖；
  - 来历：空心点，不能拖。拖它或往它上面拖时，提示这条线由哪个动作生成（例如 “Created by Apply in Review”）。
  - 所有线都是实线，保持现在的灰色；悬停或选中一个节点时，高亮和它相连的线。现在 `saved-from` 的细虚线也改为实线。
- **端口名在需要时才显示**：某一边有两个以上端口，或名字本身有意义（Process 的 `df_<别名>`、分支名）时显示；Dataset、Prompt 只有一个输出，不写名字。第一版不做“折叠端口名”的开关。
- 来历线点击后的功能不变：Prompt 版本、Dataset 版本、Review → Prompt 的线，点击打开对比窗口。
- 空心点只在有关系时出现：它不能拖，空着的空心点没有用处。
- 节点高度随端口数增长。现在 Process 的分支标签只是这个样式的一个特例，统一后不再单独处理。

## 7. 数据与代码

- **存储基本不变。** `data` 连线已经有 `fromPort` 和 `alias`；`prompt-to-run`、`run-to-score`、`score-to-prompt-review` 本来就是连线。唯一例外是 Score 的 ground truth：现在存为字段 `scoreGroundTruthId`，画的是推导出来的线。建议保持字段不变，由端口层读写这个字段，这样不需要升级存档格式。
- **端口定义集中在一个纯函数模块**（暂名 `nodePorts.js`）：给定画布状态和节点，返回它的端口列表 `[{ side, id, type, label, source? }]`，以及“某个输出能否接到某个输入”的判断。画布绘制、拖线校验、Agent 的 `inspect_node` 都用它，规则只写一处。
- **绘制**：`renderEdge` 的起点和终点改为端口坐标（第 8 步已经对 Process 分支这么做了）。
- **Pipeline 检测、编译、History、导出都不受影响**，因为连线数据不变。现有项目不需要转换。

## 8. 待定（一起讨论）

1. ~~哪些关系做成端口？~~ 已定：所有关系都用点和线显示；能拖的只有运行时读取的输入（第 6 节）。
2. ~~Sampler 要不要有输出端口？~~ 已定：不要，生成的样本用空心点连回 Sampler（第 12 节）。
3. ~~Review 的 Apply 要不要做成输出端口？~~ 已定：保持为按钮，生成的新 Prompt 用空心点连回 Review（第 12 节）。
4. ~~Process 的输入怎么与代码对应？~~ 已定：双向同步（第 5 节）。
5. ~~在空白处松开时弹出创建菜单，第一版要不要做？~~ 已定：第一版就做。
6. ~~端口名何时显示？~~ 已定：需要时才显示（第 6 节）。
7. ~~线的颜色？~~ 已定：点按类型着色，线是灰色实线，悬停或选中时高亮。
8. ~~替换已有输入时要不要确认？~~ 已定：不确认，撤销即可恢复。
9. ~~来历点放在哪里？~~ 已定：左右边缘，与数据端口相同。
10. ~~要不要“折叠端口名”的开关？~~ 已定：第一版不做，做出来看实际效果再定。
11. ~~拖线到很远的节点？~~ 已定：第一版只做拖到画布边缘时自动平移，Reroute 以后需要再加。

已定：

- 只用拖线连接，窗口里不再选择来源（2026-10-09）。
- 所有关系都用点和线显示，不管能不能拖（2026-10-09）。所有线都是实线，只靠圆点区分：实心点是数据，可以拖；空心点是来历，不能拖。
- 第 2、3 条（2026-10-09）：Sampler 没有输出端口；Review 的 Apply 仍是按钮。
- 第 4、5、6、7、8、10、11 条（2026-10-09）：Process 输入双向同步；空白处松开的创建菜单第一版就做；端口名需要时才显示；点按类型着色、线是灰色；替换不确认；不做折叠开关；只做自动平移。
- 来历点和数据端口一样放在左右边缘（2026-10-09）。
- 三条线路（Dataset、Prompt 优化、执行 pipeline）在同一张画布上，由用户摆放；不同用法的 Run 是不同节点（2026-10-09，第 12 节）。
- 每个 Run 都画 Prompt → Run 的线，包括执行 pipeline 里的 Run（2026-10-09，第 13 节）。

## 9. 大致顺序（讨论定了再细化成步骤）

1. `nodePorts.js`：端口定义和连接规则，纯函数加测试。
2. 画出端口和来历点，所有连线接到点的坐标。
3. 拖线连接、替换、断开；拖到画布边缘时自动平移。
4. 在空白处松开的创建菜单。
5. Process 的 “+” 端口与代码参数同步。
6. 去掉 Run、Process 窗口里的来源选择器，改为只显示当前来源。
7. Agent 与文档同步。

统一的运行入口（第 11 节）是另一部分，端口做完再做。

## 10. 参考：ComfyUI 的做法

- 节点之间的数据（模型、图像、潜变量等）只能拖线连接，节点里没有“选择上游”的下拉框。一个输入只接一条线，一个输出可以接多条。
- 数值（文件名、种子、步数、提示词文本）是节点里的控件；控件也可以改由一条线供值，接上线后控件变灰。
- 从输出拖到空白处松开，弹出只列出可接节点的搜索框；从已接线的输入上把线拖走，就是断开或改接；端口和线按类型着色。
- 长距离连线是公认的麻烦，用 Reroute 节点转折，不少人还装第三方的 Set/Get 节点。
- 运行：一个 Run（Queue）按钮运行整张图；输入没变的节点用缓存，不重新执行；可以只运行选中的输出节点；节点可以设为 Bypass 或 Mute，不参与运行。

## 11. 统一的运行入口（草案，第二部分）

现状：

- Run、Process 窗口各有自己的 Run 按钮，只运行这一步；上游没有结果时，这一步等待。
- Current Pipeline 面板：画布上有并列的备选步骤时先选一条路线，Run Pipeline 在后端按顺序运行整条路线，结束后把结果加进各步骤的 History；有 Stop、Resume、运行记录和导出 Python 项目。
- 也就是现在有两个运行入口、两套执行方式。

AnnoBio 与 ComfyUI 不同的地方：

1. **成本。** 一个 Run 步骤对每一行调用一次模型，全部重跑又贵又慢。所以统一入口必须像 ComfyUI 一样跳过没变的步骤。History 已经有这个基础：每一步的输入（Prompt、上游的记录、列映射、代码）都有签名，签名匹配的记录就是这一步当前的结果。规则是只运行当前输入下还没有结果的步骤。
2. **画布上常有并列的备选。** 同一个 Prompt 的几个版本、几个对比用的 Run、Score 和 Review。把整张图都跑一遍会启动很多不需要的运行。现在是靠 Current Pipeline 的路线选择解决的。
3. **调 Prompt 时常常只跑一步看看。**

提议：

- 工具栏上一个 Run 按钮，是唯一的运行入口；节点窗口不再有 Run 按钮，只放设置和结果。
- 范围由选择决定：没有选中节点时，运行画布上所有需要运行的步骤；选中了节点时，只运行这些节点和它们需要的上游。
- 开始前列出将要运行的步骤、因已有结果而跳过的步骤，以及大致行数，确认后开始。
- 运行中的步骤在节点上显示进度；Stop 也在同一个地方。

待定：

- a. 并列的备选：靠选中范围，还是加 Bypass（节点设为不参与运行）？
- b. Score、Review 是否参与统一运行？（现在的 Pipeline 不包含它们。建议：Score 跟着它读的 Run 重新计算，Review 不参与，见第 12 节。）
- c. 两套执行方式是否合并成一套：前端逐步运行，还是后端 PipelineRunner（有 Stop、Resume 和运行记录）。
- d. Current Pipeline 面板以后的角色：还需要选路线吗？导出 Python 项目目前要按路线导出。
- e. 按钮叫 Run 会和 Run 节点重名，是否改名。
- f. Pipeline 不再按 Prompt 家族分组以后，优化线路里那些在样本上跑的 Run 会各自成为只有一步的 pipeline。面板和统一运行要不要把它们和执行 pipeline 区分开？如果要，按什么区分：例如“被 Score 读、又没有被其他步骤读的 Run”算优化用的。

## 12. 三条线路，一张画布

已定（2026-10-09）：

- 三条线路：**Dataset 线路**、**Prompt 优化线路**、**执行 pipeline**。都在同一张画布上，怎么摆完全由用户决定，应用不划分区域。
- Run 是同一种节点，有多种用法：在优化线路里，它在样本上跑、被 Score 评估；在执行 pipeline 里，它在全量数据上跑、结果往下传。不同用法是不同的 Run 节点，各是各的。

端口和拖线的规则只有一套，区分只有一条：

- **运行时读取的东西**是端口，可以拖线：节点运行时要读它。
- **一个动作生成出来的节点**用空心点连到来源，不能拖：Sample 生成的样本、Review 的 Apply 生成的新 Prompt、手动新建的版本、保存出来的 Dataset。这些线说明“它是从哪里来的”，不是“它读什么”。

| 线路 | 节点 | 端口（实心点，拖线） | 生成（空心点，按钮或菜单） |
|---|---|---|---|
| Dataset 线路 | Dataset、Sampler | Dataset → Sampler 的 `source` | Sampler 的 Create dataset → 样本 Dataset；Dataset → 新版本 |
| Prompt 优化线路 | Prompt、Run、Score、Review | Prompt → Run 的 `prompt`；样本 Dataset → Run 的 `input`；Run → Score 的 `run`；标准答案 Dataset → Score 的 `ground truth`；Score → Review 的 `score` | Review 的 Apply → 新 Prompt 版本；Prompt → 新版本 |
| 执行 pipeline | Dataset、Run、Process | 所有 `data` 连线 | 保存出来的 Dataset（`saved-from`） |

线路由用户的摆放和连线体现，不是节点上的一个属性。“Pipeline”指 Run 和 Process 组成的部分，Pipeline 检测现在就不包含 Score 和 Review。

以后如果想让三块区域更清楚，可以像 ComfyUI 一样加“分组框”：用户自己画一个带标题的框，框里的节点一起移动，纯视觉，不影响运行。不在这次范围内。

**Review 那一套**

- Run → Score、标准答案 → Score、Score → Review 都是运行时读取，适合拖线。
- Apply 保持为 Review 窗口里的按钮，不做成端口，原因有三：
  1. Review 是人参与的：先看建议，逐条接受、拒绝或修改，然后才 Apply；
  2. Apply 生成新的 Prompt 版本，不改原来的 Prompt（用过的 Prompt 是锁定的）；
  3. 如果 Review 的输出接回一个 Prompt，画布上就是一个环：Prompt → Run → Score → Review → Prompt。用版本展开以后是一条链：v1 → Run → Score → Review ┄ v2 → Run → …，数据连线始终没有环，统一运行也就不用处理循环。

**Sampler 那一套**

- Sampler 只有输入端口 `source`。Create dataset 仍然是按钮，每次生成一个固定的样本 Dataset。
- 样本固定是有意的：比较几个 Prompt 版本时，要在同一批行上比，分数才有可比性。如果 Sampler 变成一个会重新抽样的步骤，这一点就保证不了。
- 样本 Dataset 和其他 Dataset 一样有输出端口，拖到 Run 的 `input` 或 Score 的 `ground truth`。

**对统一运行的影响**

- Run 按钮运行数据流：Run、Process，以及读它们的 Score（Score 按规则比对，不调用模型，Run 的结果一变就重新计算）。
- Review、Sample、Apply、新建版本、保存为 Dataset 是动作，仍然是各自的按钮或菜单，不进入 Run 按钮。

## 13. Pipeline 里的 Prompt（建议，与第 11 节一起做）

分两件事说。

**画布上 Prompt → Run 这条线：每个 Run 都画（2026-10-09 定）。**

讨论过两种做法：

- A. 画线：执行 pipeline 里的 Run 也用 `prompt` 端口连到优化线路里的那个版本，换版本就是拖线。
- B. 不画线：执行 pipeline 里的 Run 在节点上写明用的是哪个版本（例如 “Extract pairs · v5”），在节点上换版本，像 ComfyUI 里选模型文件的下拉框。

如果三条线路是应用划分的区域，B 更干净。但线路完全由用户摆放，不同用法的 Run 又是同一种节点，应用并不知道一个 Run 属于哪条线路；只在“pipeline 里的 Run”上不画线，就得让应用去猜。所以选 A，每个 Run 都一样：

- Run 运行时执行的就是这个 Prompt 的内容，它是真实的输入，History 的签名里也有它。
- Prompt 是独立节点，后面这些才成立：一个 Prompt 可以有多个 Run（样本上一个、全量上一个）；用过的 Prompt 锁定，修改就新建版本；Review 的 Apply 生成新版本；Prompt Optimization 面板按版本家族列出每个版本的 Run 和 Score。
- 线长不长由用户的摆放决定：把执行 pipeline 的 Run 放在它用的 Prompt 附近，线就短。
- 可以加一个小提示：Run 用的 Prompt 有更新的版本时，在 `prompt` 端口旁标出（例如 “v6 available”）。
- 把 Prompt 直接并进 Run 也不合适：版本、Apply、锁定、Prompt Optimization 面板都要重新设计，代价很大。

**Pipeline 的定义里：Prompt 不再参与。**

- 现状：Pipeline 检测把一个 Prompt 家族（所有版本，以及它们的所有 Run）当作一步，Current Pipeline 面板在这一步上让人选用哪个版本的哪个 Run（`pipelineDetection.js` 的 `buildPromptFamilies`、`pipelineRouteSelection.js`）。
- 后果是三条线路混在一起。用 `detectPipelines` 验证过一个例子：v1 在样本上的 Run → Score → Review，Apply 得到 v2；v2 在样本上一个 Run，在全量上一个 Run → Tidy。检测结果是一条 pipeline：两个样本上的优化 Run 和全量 Run → Tidy 在一起。v2 的两个 Run 被当作同一步的备选，v1 的 Run 因为和 v2 的样本 Run 读同一个样本 Dataset 也被连了进来。
- 直接连线以后，下游读的是某一个具体的 Run。在面板上选另一个版本的 Run，路线就变成那个 Run 自己的下游，通常它没有下游，路线到它为止。也就是说，这个选择其实是在选另一条链，而不是给同一条链换 Prompt。
- 建议：Pipeline 只由 Run、Process 和它们之间的 `data` 连线组成；Prompt 是 Run 的设置，与 Process 的代码地位相同。
  - 要让 Pipeline 用新版本：把 Run 的 `prompt` 线拖到新版本上。旧版本的结果仍在这个 Run 的 History 里，拖回去就显示出来。
  - 版本家族只属于 Prompt 优化，由 Prompt Optimization 面板展示。
- 影响：Pipeline 检测不再按 Prompt 家族分组；面板上“选版本”的选择消失；导出定义不再需要 `prompt-to-prompt` 连线。这与第 11 节的统一运行入口和 Current Pipeline 面板的去留（第 11 节待定 d）是同一批改动。
