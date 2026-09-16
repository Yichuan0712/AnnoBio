# Dataset 图片支持设计

状态：第一版核心链路已实现。基于 2026-09-14 当前工作区代码。

已完成图片导入与项目资源管理、Dataset 图片列和预览、Prompt 输入类型、手动/Agent Run、Review 诊断与 Verify/Optimize 的多模态传递，以及含图片数据集导出。模型能力预检、拖放与图片排序等增强项仍按本文后续设计继续推进。

## 1. 目标和主要决定

第一版打通「图文样本 → Prompt → Run → Score → Review → 验证/优化 → 新 Prompt」，模型输出继续使用现有结构化字段。

- 保留 7 种节点，扩展 Dataset 的列类型为 `text`、`image`。
- 一行代表一个样本；一个图片单元格可有多张有序图片。
- Prompt 的输入变量声明类型；Run 根据类型映射数据列。
- 项目保存图片引用，图片文件由项目统一管理。
- 普通 Run、Agent Run、Review 验证和优化共用输入编译与提交模块。
- 第一版包含图片的导入、预览、运行、评分上下文及 Review，构成可实际使用的闭环。

第一版支持本地静态 PNG、JPEG、WebP。图片生成、图片输出评分、视频、PDF 页解析、Excel 内嵌图片提取、远程图片 URL 下载列入后续范围。表格里的图片路径列可以在第一版导入。

## 2. 当前代码中需要跨越的边界

| 位置 | 观察到的现状 | 对实现的影响 |
|---|---|---|
| `app/src/addDatasetModal.js` | CSV/TSV/Excel 转为 `headers + rows`；另有 PubMed 导入 | 增加图片导入入口、列类型和路径解析 |
| `app/src/datasetDetailModal.js` | 文本单元格编辑、增删行列、表格导出 | 增加图片单元格组件和类型感知导出 |
| `app/src/workflowCanvas.js` | Dataset 在内存 Map 中保存；序列化同时写 `subsetContent` 与 `datasetContent` | 集中迁移和克隆数据；新格式写一个权威数据字段 |
| `app/src/main.js`、`renderer.js` | 项目是 JSON 文件；画布变化约 400 ms 后自动保存 | 图片放配套目录；另存为需要复制资源 |
| `app/src/runDetailModal.js` | 替换 `{变量}`，提交 `prompts` 文本数组 | 编译成有序文本与图片块 |
| `app/src/workflowCanvasRuntime.js` | Agent Run 另有一套文本请求构建 | 与手动 Run 共用逻辑 |
| `app/src/reviewDetailModal.js`、`reviewSuggestionOptimization.js` | 验证、优化各自拼接文本并请求 `/api/run` | 两条路径都要携带同一份图片输入 |
| `backend/main.py` | `RunRequest.prompts: list[str]`；Process 请求的行也是字符串数组 | 扩展请求模型，保留旧文本请求入口 |
| `backend/llm.py` | 结构化调用走 LangChain / LiteLLM，JSON 回退通过字符串追加说明 | 所有分支都要保留图片块 |
| `backend/review_pipeline.py` | 逐样本诊断把 `row_input` 放入文本 | 分开组织文字上下文与实际图片内容 |
| Agent 数据预览和 Process 结果显示 | 多处直接 `String(cell)` | 显式处理图片引用，避免出现 `[object Object]` |

## 3. 用户操作设计

### 3.1 创建 Dataset

在现有创建窗口增加 `Import images` 数据源，保留表格文件和 PubMed 两个入口。

支持三条导入路径：

1. **直接导入图片**：多选或拖入图片，每张图创建一行，默认列为 `filename`、`image`。预览中显示排序，用户再添加问题和标注列。
2. **向已有表格添加图片**：新增列时选择 Image；点击图片单元格选择一张或多张图，也可拖入该单元格。追加、替换、删除和调整图片顺序都有明确按钮。
3. **表格中的图片路径**：导入预览中把指定列设为 Image，选择图片根目录。相对路径以该根目录解析；CSV/Excel 表格单元格中的绝对路径也可导入。解析完成后复制进项目资源目录。

图片路径列的一格一个路径作为默认格式；需要多图时支持显式 JSON 路径数组。避免用逗号/分号猜测分隔，文件名本身可能包含这些字符。

坏图、找不到的文件、重复匹配显示到具体行；导入不悄悄丢行。Excel 内嵌图片暂不能提取时，界面说明当前只读取表格值和路径列。

示例：

| sample_id | invoice（图片） | question（文本） | expected_total（文本） |
|---|---|---|---|
| 001 | [票据 A 缩略图] | 提取总金额 | 128.50 |
| 002 | [正面] [背面] | 提取总金额 | 64.00 |

### 3.2 图片单元格

- 表格里显示固定尺寸缩略图及图片数量，多图显示第一张和 `+N`。
- 点击打开查看器，支持放大、适应窗口、前后切图，并显示文件名、尺寸。
- 缩略图按可见行加载、缓存；关闭预览释放临时 URL。
- 搜索匹配文件名和图片说明。普通文本搜索不声称可以搜索图中文字。
- 图片列改成文本列需要明确转换操作，输出文件名/引用；不能在类型切换时丢掉图片。

### 3.3 Prompt 输入

保留现有 `{变量名}` 语法，在 Inputs 区为变量添加类型选择：

| 输入变量 | 类型 |
|---|---|
| invoice | Image |
| question | Text |

提示词示例：

```text
请阅读以下票据：
{invoice}

任务：{question}
按定义的输出字段返回结果。
```

输出 schema 继续沿用现有功能，例如 `total: float`。旧 Prompt 没有输入类型配置时，所有变量默认 Text。

### 3.4 Run 配置和预览

- `invoice → Dataset.invoice`，图片变量只允许映射图片列。
- `question → Dataset.question`，文字变量只允许映射文字列。
- `expected_total` 不映射到 Prompt，因此不会随普通 Run 发给模型。
- 增加单样本「Input preview」，展示实际文字、图片及顺序，并可切换样本。
- 模型选择显示图像输入能力：支持、不支持、未验证。已知不支持时阻止图片运行；自定义端点允许配置能力并做单样本验证。
- 图片数量、格式和大小按实际适配器能力检查，不使用一个假定适用于所有模型的上限。
- 映射图片必填；缺图行明确报错，其他有效行仍可运行。该行在结果中保留，指标沿用运行错误的处理规则。

## 4. 数据和项目资源

### 4.1 扩展现有 Dataset 结构

继续保留 `headers` 和二维 `rows`，增加平行的列类型和稳定行 ID。图片值是显式引用对象：

```json
{
  "schemaVersion": 2,
  "headers": ["invoice", "question", "expected_total"],
  "columnTypes": ["image", "text", "text"],
  "rowIds": ["row_001"],
  "rows": [
    [
      {"kind": "images", "assetIds": ["sha256:<full-content-hash>"]},
      "提取总金额",
      "128.50"
    ]
  ]
}
```

约束：

- `columnTypes` 与 `headers` 等长；`rowIds` 与 `rows` 等长。增删、排序必须经公共函数同步操作。
- 图片列空值统一为 `{"kind":"images","assetIds":[]}`，多图顺序保存在数组中。
- 文字值维持原来的字符串语义；不会因为看起来像文件路径就自动变成图片。
- 克隆 Dataset、创建版本、采样和导出结果时深拷贝单元格引用对象，资源文件按内容复用。
- 有放回采样的每次抽取产生独立行 ID，记录来源 Dataset/行 ID；允许两行使用同一张图片。

新增公共模块负责 `normalizeDatasetContent`、`cloneDatasetContent`、`selectDatasetRows`、`displayCell` 和行列修改。禁止在各个节点中分别丢弃类型信息或把图片对象转成字符串。

### 4.2 图片由项目管理

```text
invoice-eval.json
invoice-eval.assets/
  originals/
    <hash>.png
    <hash>.jpg
  thumbnails/
    <hash>.webp
```

项目 JSON 顶层增加 `schemaVersion` 和 `assets` 清单；每项记录 asset ID、相对资源路径、MIME、尺寸、字节数、原始文件名。完整内容哈希作为不可变资源标识；同图导入多次可共用文件。

图片导入由 Electron 主进程负责读取、校验、复制和生成预览。复制成功后才向 Dataset 提交引用。缩略图可重建，原图和已被运行引用的处理版本必须保留。

保存与迁移规则：

- 自动保存只更新 JSON；使用临时文件再替换，避免保存中断截断项目。
- 资源先落盘，JSON 再提交。删除 Dataset 节点不立即删除图片，因为 Run 快照或其他版本仍可能引用。
- `Save as` 复制所有被 Dataset、历史 Run 和 Review 引用的资源，完成后才切换项目路径。失败时继续使用原项目。
- 第一版手动迁移要同时复制 JSON 和同名 `.assets` 目录；界面提供「打开项目目录」提示两者的位置。单文件项目包导入/导出后续实现。
- 丢失原图时显示缺失资源状态，禁止受影响样本调用模型；重新定位文件须验证哈希。不同内容作为新资产导入，不覆盖历史输入。
- 暂不自动回收未引用文件；后续清理需遍历历史快照及活动任务。

### 4.3 前后端如何访问图片

Electron 是持久资源目录的管理者，Python 后端通过已打开项目的资源会话解析引用：

1. 新建/打开项目时，Electron 主进程把资源根目录及资产清单注册到本地后端，获得临时 `project_session_id`。
2. 注册接口使用主进程与后端启动时共享的凭据；渲染器不直接指定后端任意文件读取路径。
3. Run 请求只传资源会话与 asset ID，后端根据清单解析、校验实际路径仍在项目资源目录内，再读取图片。
4. UI 缩略图经主进程受控资源接口获取，限制为当前项目中的图片资源。
5. 后端重启、项目另存为后重新注册资源会话。项目文件保存稳定 asset ID，不保存临时会话或预览 URL。

发送模型时从已校验图片构建所需编码。日志、Run 结果和 Agent 快照只保存引用和元数据，图片编码不反复写入项目 JSON。

## 5. 统一运行输入

### 5.1 一个公共编译入口

新增 `app/src/runInputBuilder.js` 与 `runClient.js`，负责输入类型检查、模板编译、图片排序、快照和请求提交。调用方包括：

- `runDetailModal.js` 的手动运行。
- `workflowCanvasRuntime.js` 的 Agent 运行。
- `reviewDetailModal.js` 的建议验证。
- `reviewSuggestionOptimization.js` 的候选验证。

编译器沿现有章节顺序处理模板，生成应用内部的有序内容块：

```json
{
  "sample_id": "row_001",
  "source_row_index": 0,
  "content": [
    {"type": "text", "text": "请阅读以下票据：\n"},
    {"type": "image_ref", "asset_id": "sha256:<full-content-hash>", "input_name": "invoice", "image_index": 0},
    {"type": "text", "text": "\n任务：提取总金额\n按定义的输出字段返回结果。"}
  ]
}
```

`image_ref` 是应用内部格式，交给后端转换；不是直接发送给供应商的请求格式。图片变量可展开多张图片，保留各变量、各图片的顺序和可读标签。重复出现同一变量时第一次附图，后续保留指向首次图片的文字标签，避免重复计费和顺序歧义。

新 `/api/run` 请求使用 `samples`，并携带 `project_session_id`、`credential_id`、`output_schema`、`run_node_id`。

兼容期接受旧 `prompts: list[str]`，在 API 边界规范化成只有一个 text 块的 samples。`prompts` 与 `samples` 二者必须提供一个且只能提供一个，避免优先级歧义。

### 5.2 后端适配

`llm.run_structured()` 接收规范化消息，而所有现有文本调用通过兼容封装进入。图片解析由公共资源模块完成。

需要覆盖三条分支：

1. LangChain structured：构建含文本/图片内容的消息列表，传入 structured runnable。
2. LiteLLM structured：转换成适配器可识别的多模态消息并调用 completion。
3. JSON fallback：向原消息追加输出 schema 的文字要求，完整保留已有图片块。

LiteLLM 的官方文档展示了文本与图片组成的消息以及视觉能力查询；LangChain 官方文档也提供多模态消息接口。因此可沿用现有适配层，但具体模型、安装版本与「图片 + 结构化输出」组合需要分别验证。参考：[LiteLLM Vision](https://docs.litellm.ai/docs/completion/vision)、[LangChain Messages](https://docs.langchain.com/oss/python/langchain/messages)。

图片读取失败、模型明确不支持图像等错误不能触发丢图后的纯文本回退。供应商结构化输出能力与图像能力分别检查。

第一版优先保持原图信息；如适配器需要旋转归一化、转码或尺寸调整，保存处理参数、原图哈希和实际发送图哈希。预览方向应与模型收到的图片一致；缩略图只用于预览。

### 5.3 实验输入快照

首次 Run 冻结：Prompt 章节与输入类型、输出 schema、变量映射、Dataset 行及类型、行 ID、多图顺序、资产哈希、图片处理配置和模型配置标识。密钥继续保留在现有凭据管理中。

- Resume 使用冻结快照，不重新读取后来修改的 Dataset。
- 修改 Prompt、图片映射、图片或模型配置之后，界面允许继续原配置或创建新 Run；不能把两个配置的结果合并。
- 新请求显式携带 `sample_id` 与原始 `source_row_index`。结果保留两者；任务批次索引单独处理。
- 现有 `mergeResumeResults` 会对续跑结果加偏移。新 samples 路径返回绝对来源索引后要避免再加一次；旧请求保持兼容。
- 一条输入产生多行输出时，所有输出仍归属于同一 sample ID。

## 6. Score、Review、Sampler、Process 和 Agent

### Score

输出继续是现有字段，复用字符串、数值、模糊、语义与 Python 匹配规则，以及 Precision/Recall/F1。

图片作为输入上下文显示缩略图。规则编辑器不允许把图片对象交给字符串/数值匹配；输入配对使用显式样本标识或其他文本键。图片像素相似度不属于第一版评分功能。

自定义 Python match 的输入上下文传图片引用对象，需要同步修改请求类型和显示逻辑。结果保存为 Dataset 时保留输入图片列及类型；Run 输出和标准答案仍按现有文本列处理。

### Review

在 `ReviewComparisonRow` 增加样本标识和图片引用，来源为 Run 快照。现有逐输入样本分组逻辑可用于避免同一个样本多条输出重复附图。

- 逐样本诊断：发送该样本实际运行图片、输入文字、模型输出和标准答案。
- 修改建议：使用已产生的诊断；需要视觉证据时按目标样本附图并保留标签，避免将所有 Dataset 图片无差别放进每次请求。
- UI：诊断详情显示图片及输出/标准答案，便于人工核对。
- Verify：用修改后的 Prompt 和冻结输入调用公共 Run 模块；评分规则与对应实验一致。
- Optimize：候选提示词使用同样图片、顺序及处理配置；接受建议后创建的新 Prompt 保留输入类型。
- Review 模型需支持它实际接收的图片。不支持时明确要求换模型，不能把图片文件名当成看过图片的证据。
- 对 `gt_only` 记录尽可能通过样本键定位原始输入；无法定位时标为缺少图像证据，不猜测对应图片。

### Sampler

复用采样算法，抽取整个 typed row 并复制引用对象与列类型。多图仍作为一个样本一起抽取；有放回采样生成独立行 ID、共享不可变图片资源。

### Process

第一版支持图片引用随文字数据过滤、重排、复制和派生，不自动把图片加载成像素数组。

- `process(row)` 中图片单元格是引用 dict；`process(df)` 中对应列为保存引用 dict 的列。
- 前后端请求模型、结果转换和导出都保留图片引用；输出引用必须指向项目已登记资产。
- 通过公共模块恢复列类型，不能继续对所有返回值做 `String(...)`。
- 实际裁剪、缩放和生成新图片的辅助 API 后续实现，输出必须登记成新资产以保持历史可复现。

### Agent

第一版需要兼容：识别列类型，配置图片变量和映射，通过共用运行模块启动图文 Run，调用已适配的 Review/Verify。

默认画布快照只包含图片数量、文件名、asset ID 和尺寸，不自动附加全数据集图片。Agent 仅凭这些元数据不能描述图片内容；直接「查看某行图片」工具可在后续按需附图，并检查 Agent 模型能力。

同步更新创建 Prompt、Run、Sampler、Score 及 inspect_node 的参数和结果，保留当前文字类 skill 的兼容性。

## 7. 数据集导出和旧项目兼容

### 导出

- **只导出表格**：图片列转换为可读文件引用；界面标注导出不包含图片。
- **导出数据及图片**：输出 CSV + `images/` + `dataset.schema.json`。多图单元格使用 JSON 路径数组，schema 保存列类型；这套文件可重新导入并恢复图片列。
- Run、Score、Process 保存到 workspace 时直接保留内部引用，不做路径字符串化。

### 兼容

项目顶层新增格式版本。无版本的项目作为 v1：加载时补齐 Text 类型和行 ID，读取 `datasetContent` 或旧 `subsetContent`，旧 Prompt 输入默认为 Text。

新项目规范化后只写 `datasetContent`；修改所有读取入口和 Agent 的字段优先级。加载过程中不立即覆盖原文件；下一次保存完成格式升级。

向后兼容表示新程序可以读取旧项目；旧程序不保证可以读取 v2 图片项目。首次升级保存时保留一次原 JSON 备份。

## 8. 实施顺序与文件落点

| 阶段 | 主要改动 | 完成标准 |
|---|---|---|
| A. 数据与资源基础 | 新增 dataset 内容公共模块、Electron 资源管理模块、后端 `asset_store.py`；修改 `main.js`、`preload.js`、项目加载保存 | 图片可导入、预览、保存、重开、另存为；旧项目可读取 |
| B. 图文 Run | 新增 `runInputBuilder.js`、`runClient.js`；修改 Prompt/Run 窗口、运行 runtime、`backend/main.py`、`llm.py` | 手动和 Agent Run 都能发送真实图片并返回结构化结果；取消、续跑和错误行为可用 |
| C. 完整评测闭环 | 修改 Score、Review comparison 构建、`review_pipeline.py`、验证与优化模块；适配 Sampler、Process、Agent | 原图能进入 Review，Verify/Optimize 使用同一输入，采样/处理/导出不会丢引用 |
| D. 体验扩展 | 项目打包、剪贴板粘贴、Agent 按需看图、图片处理辅助函数；按任务需求加入其他格式 | 在闭环稳定后扩展入口和操作范围 |

A–C 构成第一版完成范围。阶段之间可以内部验证，但不能把只显示缩略图称作已经完成图片支持。

代码改动还要覆盖 `workflowNodeFactories.js` 的节点构造/内容复制、`runResumeUtils.js` 的输入快照，以及所有保存 Run/Score 结果为 Dataset 的入口。

## 9. 验收场景

1. 老的纯文本项目打开、运行、评分、Review 行为保持一致；Text 变量的替换结果和原逻辑一致。
2. 使用两张视觉内容不同的测试图，适配器捕获到的输入具有正确图片内容和顺序；单/多图、多个图片变量均覆盖。
3. JSON fallback 保留图片，且不支持图片的模型不会收到丢图后的请求。
4. 导入后移动外部原文件，项目仍能运行；另存为到包含空格/中文的路径并重新打开仍能预览和运行。
5. 删除源 Dataset、保留 Run 历史后，Review 仍能解析历史图片；原图丢失时明确失败。
6. 采样、复制 Dataset、创建版本、Process 过滤和 Run/Score 导出保留图片类型、多图顺序和来源关系。
7. 中途停止后续跑，一对多结果仍关联正确原始行；修改 Dataset 后续跑仍使用原快照，无双重索引偏移。
8. 手动 Run、Agent Run、Verify、Optimize 在相同 Prompt/输入配置下编译出相同内容块与图像哈希。
9. Score 不把图片引用对象当字符串评分；正常 Run 不会自动发送未映射的标准答案列。
10. 大表格按可见行加载缩略图，自动保存文件不含重复图片编码；资源根目录以外的路径不能通过 asset ID 解析。

验证采用纯文本回归、资源与编译模块测试、适配器请求捕获，以及所选模型的少量真实图文闭环验证。真实调用按配置单独记录，不能仅凭消息格式符合文档就宣称供应商组合全部可用。
