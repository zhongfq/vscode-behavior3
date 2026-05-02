# Document Model

## 目标

本文件定义 V2 的文档真源、resolved graph 依赖数据、override 与 history/save 语义。

核心原则：

- persisted tree 是唯一可保存真源
- resolved graph 是图层消费的派生结果
- 图层不能把自己的内部状态反向写回 persisted tree

## 三层模型

### 1. PersistedTreeModel

`PersistedTreeModel` 表示磁盘上的主文档结构。

它包含：

- 树级元数据：`version`、`name`、`prefix`、`desc`、`export`
- 依赖数据：`group`、`import`、`vars`
- 扩展字段：`custom`
- 根节点：`root`
- subtree override：`$override`

### 2. PersistedNodeModel

每个 persisted node 至少包含：

- `$id`
    - 稳定 identity，用于 override、selection restore、diff
- `id`
    - 原始存档里的节点 id，保留用于 round-trip
- `name`
- `desc`
- `args`
- `input`
- `output`
- `children`
- `debug`
- `disabled`
- `path`
- `$status`

说明：

- `id` 保留在文档模型里，但图层搜索与实例定位使用 resolved graph 的 `displayId`
- `path` 表示该节点是 subtree link

### 3. DocumentState

`DocumentState` 是当前打开主文档的编辑态：

- `persistedTree`
- `dirty`
- `alertReload`
- `history`
- `historyIndex`
- `lastSavedSnapshot`

### 4. ResolvedDocumentGraph

`ResolvedDocumentGraph` 是根据当前 persisted tree、subtree sources、node defs 解析出的运行时图。

它包含：

- `rootKey`
- `nodesByInstanceKey`
- `nodeOrder`

图层永远只消费这个派生结构，而不是直接消费 persisted tree。

## Workspace-Side Subtree Cache

`workspaceStore.subtreeSources` 是主树外部依赖的缓存层。

规则：

1. key 为规范化后的 `WorkdirRelativeJsonPath`
2. value 为：
    - `PersistedTreeModel`
    - `null`，表示读取失败、文件缺失或解析失败
3. subtree cache 的刷新由 controller 驱动，不由图层驱动

## Identity Model

V2 同时维护三类 identity：

- `structuralStableId`
    - 当前实例在主文档结构里的锚点
- `sourceStableId`
    - 来源 persisted node 的 `$id`
- `displayId`
    - resolved graph 内面向用户的逻辑图节点编号
- `instanceKey`
    - resolved graph 内唯一实例标识

当前推荐规则：

- `structuralStableId` 用于定位当前主文档结构中的可编辑锚点
- `sourceStableId` 跨文档刷新尽量稳定
- `displayId` 由 resolved graph 生成，可随结构变化
- `instanceKey` 唯一定位当前实例，不要求跨结构修改稳定

## Override Model

### 存储位置

subtree internal node 的编辑结果写入主树的 `$override`。

key：

- `sourceStableId`

value：

- `desc`
- `input`
- `output`
- `args`
- `debug`
- `disabled`

### 规则

1. override 只描述“相对来源节点基线的差异”。
2. 若差异为空，应删除该 override 项。
3. override 不直接回写 subtree source 文件。
4. 主树节点编辑不使用 `$override`。

## History Model

### Snapshot Shape

history 存储主文档的序列化文本快照。

### Push Rules

以下操作应推进 history：

- tree meta 修改
- node 修改
- 结构拖放
- copy/paste/insert/replace/delete
- subtree save-as 造成的主文档变化

以下操作不推进 history：

- selection 变化
- search / highlight 变化
- viewport 变化
- graph 纯视觉重绘
- host vars / nodeDefs 的外部刷新

### Undo / Redo Rules

- `undo()` / `redo()` 通过恢复快照重建 persisted tree
- 恢复后必须重新 resolve graph、恢复 selection、重放 visual state

### Dirty Rules

- dirty 由当前 persisted tree 快照与 `lastSavedSnapshot` 比较得出
- 不依赖手工 `true/false` 切换

## Save Model

### 保存输入

- 当前 `persistedTree`
- 当前树级元数据与 `$override`

### 保存输出

- 序列化后的主文档文本
- 成功后更新 `lastSavedSnapshot`
- 不改变 selection / search / viewport

### Save-As-Subtree

`saveSelectedAsSubtree()` 的结果应包括：

1. 生成一个新的 subtree 文件内容
2. 调用宿主保存该文件
3. 将当前选中节点替换为 subtree link
4. 必要时清理本地 children，转而依赖 subtree resolve

## Declare and Vars View

declare 相关数据分为两层：

- 持久化层
    - `group`、`import`、`vars`
- 宿主补充层
    - `usingVars`、`importDecls`、`subtreeDecls`

Inspector 看到的是两层合成后的派生视图。

## 不变量

1. 主文档任何时刻只有一份可写 persisted tree。
2. subtree cache 不是可写真源，只是外部依赖快照。
3. resolved graph 随时可丢弃并重建。
4. graph adapter 不能成为 save / history 的参与者。
5. override 永远属于主文档，而不属于 subtree source 本身。
