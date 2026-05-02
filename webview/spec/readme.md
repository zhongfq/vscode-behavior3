# V2 Spec README

## 开发方式

`webview` 继续采用 SDD（Spec-Driven Development）开发，但本轮重构的基线已经改变：

- V2 以 `G6` 作为唯一图引擎
- V2 不再以 V1 行为一致性作为目标
- V2 允许重写图排布、交互语义和宿主适配边界

从现在开始，V2 的文档不是“给现有实现找解释”，而是后续重构的实现蓝图。

一句话规则：

- 先改 spec
- 再改 contracts / adapter / controller
- 最后做实现与回归

## Source of Truth

本目录是 V2 的唯一设计真源。

若发生冲突，优先级如下：

1. `webview/spec/*`
2. `webview/shared/contracts.ts`
3. 当前运行时代码
4. 历史实现经验，包括 V1 与本轮重构前的 V2 自绘图层

说明：

- V1 仍可作为灵感或反例来源
- V1 不是本轮重构的行为约束
- 当前自绘图层也不是保留对象

## 文档职责

- `overview.md`
    - 描述 V2 的目标、技术路线、非目标、完成标准
- `behavior-parity.md`
    - 文件名保留，但内容改为“行为基线”；用于定义当前版本必须具备的核心体验与验收案例
- `architecture.md`
    - 定义分层、职责边界、G6 adapter 的角色
- `stores-and-commands.md`
    - 定义 store 归属、command catalog、adapter 接口
- `protocol-and-dtos.md`
    - 定义 host/raw message 与 V2 内部 DTO 的规范
- `document-model.md`
    - 定义 persisted tree、resolved graph、override、history/save 的模型
- `resolved-graph-algorithm.md`
    - 定义从文档树到图节点实例的解析规则
- `graph-contract.md`
    - 定义 G6 图层的输入、输出、几何排布、视觉和交互契约
- `inspector-contract.md`
    - 定义 Tree / Node Inspector 的结构、提交节奏与 override 交互
- `editor-semantics.md`
    - 定义 command 语义、图刷新、selection/search/highlight、宿主往返流程
- `migration-plan.md`
    - 定义本轮文档重置到实现落地的阶段顺序

## 本轮重构的固定方向

这轮 spec 刷新之后，以下前提视为固定：

- 图层实现统一走 `G6`
- `GraphPane` 只负责容器挂载与外围 UI，不再承担自绘排布与命中计算
- 图排布可以重写，不保留 `d3-hierarchy` 路线
- 拖放、搜索、高亮、聚焦等图交互可以重写，只要求语义清晰、可维护
- 文档真源仍留在 store / domain / controller 侧，不能回流到图引擎实例

## 什么改动必须先改文档

以下改动必须先更新本目录文档，再开始编码：

- 图引擎接入方式变化
- graph adapter 输入输出变化
- controller 命令语义变化
- store 字段归属变化
- search / highlight / drag-drop 规则变化
- Inspector 结构或提交节奏变化
- subtree / override / save / history 语义变化
- host message 或 DTO shape 变化

以下内容可先改实现，但若影响长期维护，仍建议补文档：

- 纯视觉微调
- 文案修正
- 不改变语义的重命名
- 局部性能优化

## 实现前检查清单

开始编码前，至少要能回答：

- 这次改动对应哪几份 spec？
- 它是否改变了 `contracts.ts` 中的稳定接口？
- 它是文档模型问题、图层问题，还是 command 语义问题？
- 它是否会新增 host message、修改 DTO 或影响存档格式？
- 它是否会改变 selection / search / highlight / drag-drop 中任一条可观察语义？

如果答不出来，说明 spec 还没写够。

## 验收方式

实现完成后，要能反向用 spec 验收：

- 目标与边界符合 `overview.md`
- 图层职责符合 `architecture.md` 与 `graph-contract.md`
- store / command 归属符合 `stores-and-commands.md`
- 宿主协议与 DTO 符合 `protocol-and-dtos.md`
- 文档保存、override、history 语义符合 `document-model.md`
- resolved graph 解析与 selection restore 符合 `resolved-graph-algorithm.md`
- Inspector 结构与提交节奏符合 `inspector-contract.md`
- 命令流程与交互语义符合 `editor-semantics.md`
- 实施顺序符合 `migration-plan.md`

## 关于历史实现

本轮重构对历史实现的态度是：

- 可以参考，但不继承其结构债务
- 可以复盘其交互优缺点，但不要求兼容
- 可以沿用成熟的数据字段，但不为旧图层实现保留额外抽象

V1 和当前自绘 V2 都不是“必须保持一致”的对象。

## 执行约定

后续我会默认按以下顺序工作：

1. 先更新 spec
2. 再收敛 `contracts.ts`
3. 再替换 graph adapter / graph pane / node geometry
4. 再联调 controller、inspector、host adapter
5. 最后做验证与清理
