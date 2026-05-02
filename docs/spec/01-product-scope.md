# Product Scope

## 目标

当前这套编辑器设计以 `G6` 为核心。

本轮固定目标：

- 用清晰的 store / controller / adapter 边界重建编辑器
- 用 `G6` 承担图渲染、布局和图交互
- 保持文档模型、子树模型、Inspector 和宿主通信彼此解耦
- 让后续功能迭代优先建立在可维护性和可验证语义上

## 固定技术路线

- UI 框架：`React`
- 外围 UI：`Ant Design`
- 图引擎：`@antv/g6`
- 状态层：独立 stores + command controller
- 图层接入方式：`GraphAdapter`
- 宿主通信：`HostAdapter`

## 非目标

当前阶段明确不做：

- 不让 G6 直接读写 store 或 host
- 不把业务规则塞回节点组件或图事件回调里

## 设计原则

1. 文档真源只有一个：`documentStore`。
2. 图引擎不拥有业务真源，只消费 view model 与 visual state。
3. 所有跨层修改都必须经过 `commandController`。
4. resolved graph 是图层唯一可信输入，不直接把 persisted tree 喂给 G6。
5. 视口、选中态、搜索态、变量高亮属于图层可视状态，不写回持久化文档。
6. 子树展开、override 计算、selection restore 属于 domain/controller，不属于 G6。
7. Inspector 是高频编辑侧栏，不退化成“配置页式表单”。

## 当前交付边界

当前设计的实现目标包含：

- 一套清晰的 `contracts.ts` 图层与命令接口
- 一套基于 G6 的 graph adapter
- 一套稳定的 resolved graph 解析规则
- 一套可预测的 selection / search / highlight / drop 语义
- 一套与图层解耦的 Inspector 与宿主通信流程

## 顶层模块

- `documentStore`
    - 当前文档、dirty、history、reload 提示
- `workspaceStore`
    - filePath、workdir、nodeDefs、allFiles、settings、host vars、subtree source cache
- `selectionStore`
    - selected node/tree、search、active variable、Inspector UI state
- `commandController`
    - 唯一动作入口，负责文档变更、图刷新、宿主消息处理
- `graphAdapter`
    - G6 实例生命周期、视口、节点/边渲染、图事件回传
- `hostAdapter`
    - webview 与 extension host 间的消息桥
- `domain`
    - resolve graph、override diff、search/highlight selector、校验与辅助算法

## 完成标准

当前设计落地时，至少要满足：

- 图层已经完全切到 G6
- 布局、渲染与交互命中逻辑已经统一收敛到图层方案
- selection、search、highlight、drag-drop、focus 都有明确归属和文档化语义
- 任何图行为都可以从 spec 追溯到对应 contract 与 command
- 新同事只看 `docs/spec` 就能理解系统边界并继续实现
