# Spec README

## 目的

`docs/spec` 是 Behavior3 Webview 编辑器的 SDD（Spec-Driven Development）设计真源。

这组文档服务于三件事：

- 先定义产品边界与可观察行为
- 再固定设计、模型与跨层契约
- 最后按文档驱动实现、回归与交付

一句话规则：

- 先改 spec
- 再改 contracts / adapter / controller
- 最后做实现与回归

## Source of Truth

若发生冲突，优先级如下：

1. `docs/spec/*`
2. `webview/shared/contracts.ts`
3. 当前运行时代码

## SDD 阅读顺序

### 1. 范围与验收

- `01-product-scope.md`
    - 目标、技术路线、非目标、完成标准
- `02-acceptance-scenarios.md`
    - 当前版本必须满足的行为基线与回归场景

### 2. 设计与契约

- `10-architecture.md`
    - 分层、职责边界、关键事件流、推荐目录结构
- `11-document-model.md`
    - persisted tree、resolved graph、override、history/save 模型
- `12-runtime-and-commands.md`
    - store 归属、command catalog、稳定内部接口、宿主消息映射
- `13-host-protocol.md`
    - host wire protocol、normalized DTO、路径与跨层对象语义
- `14-resolved-graph.md`
    - 从文档树到 resolved graph 的解析规则与 identity 生成规则
- `15-graph-contract.md`
    - 图层输入输出、geometry、selection/search/highlight/drop 契约
- `16-inspector-contract.md`
    - Inspector 结构、提交节奏、override 交互、变量高亮契约
- `17-editor-semantics.md`
    - command 语义、图刷新、selection/search/highlight、宿主往返流程

### 3. 实施与回归

- `90-implementation-plan.md`
    - 从文档落到实现的阶段顺序、约束和最低交付路径

## SDD 工作流

开始一项改动时，默认按以下顺序推进：

1. 在 `01-product-scope.md` 和 `02-acceptance-scenarios.md` 确认为什么要改、改完用户能观察到什么。
2. 在相关设计文档中固定模型、边界、命令语义与契约。
3. 收敛 [`contracts.ts`](/Users/codetypess/Desktop/Github/vscode-behavior3/webview/shared/contracts.ts) 与 adapter/controller/store 接口。
4. 再进入实现、联调和回归。

如果实现过程中无法指出“这次改动对应哪份 spec”，通常意味着文档还没写够。

## 变更路由

以下改动必须先更新对应 spec，再开始编码：

- 产品目标、技术路线、非目标、完成标准变化：`01-product-scope.md`
- 用户可观察行为、验收路径、手工回归案例变化：`02-acceptance-scenarios.md`
- 分层、模块职责、关键事件流变化：`10-architecture.md`
- persisted tree、override、history/save 语义变化：`11-document-model.md`
- store 字段归属、command catalog、宿主消息映射变化：`12-runtime-and-commands.md`
- host message、DTO shape、路径规则、drop intent 变化：`13-host-protocol.md`
- resolved graph 解析、instance key、selection restore 变化：`14-resolved-graph.md`
- 图层输入输出、布局、节点 geometry、视觉状态契约变化：`15-graph-contract.md`
- Inspector 结构、提交流程、override 交互变化：`16-inspector-contract.md`
- command 执行顺序、刷新策略、交互语义变化：`17-editor-semantics.md`
- 实施阶段、交付顺序、强约束变化：`90-implementation-plan.md`

以下改动可先改实现，但若会影响长期维护，仍建议补文档：

- 纯视觉微调
- 文案修正
- 不改变语义的重命名
- 局部性能优化

## 新增文档建议

后续新增 spec 时，尽量让文档至少回答以下问题：

- 背景与目标是什么
- 不变量与边界是什么
- 输入、输出、状态或流程是什么
- 如何验收这份设计已经成立

能复用现有文档就不要再开平行文档，避免同一规则出现两个真源。

## 实现前检查清单

开始编码前，至少要能回答：

- 这次改动对应哪几份 spec
- 它是否改变 [`contracts.ts`](/Users/codetypess/Desktop/Github/vscode-behavior3/webview/shared/contracts.ts) 中的稳定接口
- 它是文档模型问题、图层问题，还是 command 语义问题
- 它是否会新增 host message、修改 DTO 或影响存档格式
- 它是否会改变 selection / search / highlight / drag-drop 中任一条可观察语义

## 验收方式

实现完成后，要能反向用 spec 验收：

- 目标与边界符合 `01-product-scope.md`
- 行为基线符合 `02-acceptance-scenarios.md`
- 图层职责符合 `10-architecture.md` 与 `15-graph-contract.md`
- store / command 归属符合 `12-runtime-and-commands.md`
- 宿主协议与 DTO 符合 `13-host-protocol.md`
- 文档保存、override、history 语义符合 `11-document-model.md`
- resolved graph 解析与 selection restore 符合 `14-resolved-graph.md`
- Inspector 结构与提交节奏符合 `16-inspector-contract.md`
- 命令流程与交互语义符合 `17-editor-semantics.md`
- 实施顺序符合 `90-implementation-plan.md`
