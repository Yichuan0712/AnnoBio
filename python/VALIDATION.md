# 本次实现验证

- Python 3.12.10：在 `-S`（不加载 site packages）下，从源码运行 128 项 unittest，全通过；原路径分步示例通过。
- Python 3.14.6：在 `-S` 下，直接从构建的 wheel 导入并运行同样的 128 项测试，全通过；两个离线示例均通过。
- 以 Python 3.10 grammar 解析全部 11 个源码模块通过；本机没有 Python 3.10，未执行该版本的运行测试。
- setuptools 成功构建 `annobio_optimize-0.1.0-py3-none-any.whl`；metadata 声明 Python `>=3.10`，核心无第三方依赖，包含 `py.typed`；`original` extra 声明 `rapidfuzz>=3.0.0`。
- 多片段组合搜索在三个固定 seed 下验证；回归拒绝、候选去重、缓存开关、预算、取消、逐轮更新、JSON 导出恢复和回调数据隔离均有行为测试。
- 新增分步流程覆盖独立 Analyze/Verify/Search/Accept/Revert、保留原建议、追加独立候选、比较行 matched/total 累计、重复试验、统一先验、失败试验、原输入顺序、两条回归输入、旧文本处理，以及显式增强开关。
- 4 项测试读取并执行 live JS，比较原 Beta 采样器、回归输入选择、文本定位/段落上下文和完整搜索循环；相同 uniform stream 下，完整循环的 picks、passRate、bestText/bestRate 一致。需要 Node 与完整 repo，独立源码分发中自动跳过这些参考测试。
- 另有测试读取 live 后端 AST，比较原文本 span helpers 的 exactish、引号、换行、Markdown/前缀、截断延伸和唯一性行为。当前环境未安装 RapidFuzz，未执行真实 RapidFuzz 模糊分支；该可选分支保留原调用方式与阈值。
- 新增 46 项输入与错误处理测试：回调签名/同步约束、初始化前置检查、嵌套 JSON 路径/循环/深度、配置类型、重复 ID、Observation 覆盖、SDK 对象返回、评价返回契约、取消/事件返回、外部异常上下文、模型 JSON/字段错误、原回退策略，以及保存记录的字段/类型/版本/主要引用检查。原有 82 项流程和对照测试继续通过。

本次 wheel 位于仓库忽略目录 `.cache/annobio-optimize/wheels/`。常规 `pip wheel --no-index --no-deps --no-build-isolation` 在当前受限 Windows 环境创建私有临时目录后无法写入，Python 3.12/3.14 都遇到 `PermissionError`。因此通过 setuptools 直接执行 `bdist_wheel` 验证打包，再从 wheel 本身加载执行测试；常规 pip 构建/安装流程未能在本环境完成。

未使用 API key，未调用付费模型，未声称真实任务效果提升。离线示例和测试验证流程及数据契约；真实模型输出稳定性和真实任务效果仍需通过用户指定的模型、数据和指标验证。
