# Resolved Graph

## 目的

本文件定义如何把：

- `PersistedTreeModel`
- `workspaceStore.subtreeSources`
- `workspaceStore.nodeDefs`
- `workspaceStore.settings`

解析为：

- `ResolvedDocumentGraph`
- `ResolvedGraphModel`
- Inspector 所需的节点实例引用与快照

resolved graph 是图层唯一可信输入。

## 输入与输出

### 输入

- 主文档 `persistedTree`
- subtree source cache
- node defs
- `subtreeEditable`

### 输出

- `ResolveGraphResult.graph`
- `ResolveGraphResult.mainTreeDisplayIdsByStableId`

说明：

- `graph` 是长期稳定输出
- `mainTreeDisplayIdsByStableId` 目前可作为辅助映射保留，但不应再驱动 persisted node `id` 回写

## 术语

### Structural Node

当前主文档里真实存在、可被结构编辑的 persisted node。

### Materialized Subtree Root

一个带 `path` 的 structural node 在 resolved graph 中对应出的图节点实例。它占据主树结构位置，但内容来自引用 subtree 的 root。

### Subtree Internal Node

materialized subtree root 向下展开出的外部节点实例。它存在于 resolved graph 中，但不直接存在于主文档结构里。

### Source Stable Id

提供当前实例内容的 persisted node `$id`。

### Structural Stable Id

当前实例在主文档结构中的锚点 `$id`。

规则：

- 普通主树节点：`structuralStableId === sourceStableId`
- materialized subtree root：`structuralStableId` 来自主树 link node，`sourceStableId` 来自 subtree root
- subtree internal node：`structuralStableId === sourceStableId`

### Display Id

resolved graph 内面向用户的逻辑编号。

当前建议格式：

- root: `1`
- 第一个孩子: `1.1`
- 第二个孩子: `1.2`

### Instance Key

resolved graph 内唯一实例 key。

当前建议：

- 直接使用 `displayId`

如果后续改成别的编码方式，必须仍满足“单图内唯一、可用于 selection/search/focus”的要求。

## 前提

1. 所有 persisted node 在进入 resolve 前都应具备 `$id`。
2. subtree source cache 中的树也应经过相同的默认值与 `$id` 规范化。
3. 路径已统一为 `WorkdirRelativeJsonPath`。

## 不变量

1. resolved graph 不修改 persisted tree。
2. 同一次 resolve 里，每个实例只有一个 `instanceKey`。
3. 同一次 resolve 里，每个实例只有一个父节点。
4. resolve 失败的 subtree 只降级当前分支，不拖垮整图。

## Context Model

递归解析时，至少维护以下上下文：

- `displayPath`
    - 当前逻辑编号路径
- `parentKey`
    - 父实例 key
- `sourceTreePath`
    - 当前内容来源树文件；主树为 `null`
- `subtreeStack`
    - 走到当前节点经历的 subtree path 栈
- `structuralStableId`
    - 当前结构锚点

## 节点数据来源规则

### A. 普通主树节点

条件：

- 当前 persisted node 无 `path`

规则：

- `sourceStableId = node.$id`
- `structuralStableId = node.$id`
- `sourceTreePath = null`
- children 来自 `node.children`

### B. Materialized Subtree Root

条件：

- 当前 persisted node 有 `path`
- subtree source 存在且合法

规则：

- `sourceStableId = subtree.root.$id`
- `structuralStableId = linkNode.$id`
- `sourceTreePath = linkNode.path`
- `subtreeStack = parentStack + [linkNode.path]`
- 节点可视内容来自 `subtree.root`
- 节点结构位置来自当前主树 link node

override 规则：

- 若允许编辑 subtree 节点属性，则当前主文档 `$override[sourceStableId]` 可覆盖该 root 的可编辑字段
- `path` 始终来自 structural link node，而不是 subtree root

### C. Subtree Internal Node

条件：

- 当前节点来自某个已 materialize 的 subtree 内容

规则：

- `sourceStableId = sourceNode.$id`
- `structuralStableId = sourceNode.$id`
- `sourceTreePath = 当前 subtree 文件路径`
- `subtreeNode = true`
- 若允许编辑 subtree 节点属性，则可通过当前主文档 `$override[sourceStableId]` 覆盖字段

### D. Missing / Invalid / Cyclic Subtree

条件：

- path 指向的 subtree 文件不存在、解析失败或形成循环引用

规则：

- 仍产出一个 resolved node
- `resolutionError` 标记为：
    - `missing-subtree`
    - `invalid-subtree`
    - `cyclic-subtree`
- 该节点不继续展开 children

## Display Id 分配

分配规则对齐原编辑器的 `refreshNodeData(...)`：

1. 从 root 开始做深度优先遍历
2. 每访问一个 resolved node，就分配当前顺序号字符串：`"1"`, `"2"`, `"3"` ...
3. subtree link 被 materialize 时，当前实例直接占用该顺序号
4. materialize 出来的 subtree children 继续沿用同一个 DFS 计数器往后编号

说明：

- `displayId` 是当前图实例编号，不回写 persisted tree
- `renderedIdLabel = persistedTree.prefix + displayId`
- persisted node 自带的 `id` 字段只保留用于文档 round-trip

## NodeInstanceRef 生成

每个 resolved node 必须生成一个 `NodeInstanceRef`，至少包含：

- `instanceKey`
- `displayId`
- `structuralStableId`
- `sourceStableId`
- `sourceTreePath`
- `subtreeStack`

其中：

- `instanceKey` 供选中、聚焦、搜索结果和图层内部映射使用
- `structuralStableId` 供主树结构命令定位锚点使用
- `sourceStableId` 供 override、只读来源说明和 subtree 节点编辑使用

## 解析流程

### Step 1. 入口

从主文档 root 开始，以 DFS 顺序号 `1` 递归解析。

### Step 2. 识别节点类型

根据当前 persisted node 是否带 `path`、subtree source 是否可用，判定为：

- 普通主树节点
- materialized subtree root
- 降级 subtree 节点

### Step 3. 生成 base snapshot

对当前实例生成基础字段：

- `name`
- `desc`
- `args`
- `input`
- `output`
- `debug`
- `disabled`
- `path`
- `$status`

字段来源遵循上一节的数据来源规则。

### Step 4. 应用 override

当 `subtreeEditable === true` 且当前实例来自 subtree source 时：

- 查找当前主文档 `$override[sourceStableId]`
- 覆盖允许编辑的字段

### Step 5. 注入解析元数据

补充：

- `parentKey`
- `childKeys`
- `depth`
- `subtreeNode`
- `subtreeEditable`
- `subtreeOriginal`
- `resolutionError`

### Step 6. 递归 children

- 普通主树节点：递归其 persisted children
- materialized subtree root：递归 subtree root 的 source children
- 降级 subtree 节点：无 children

## Selection Restore 规则

恢复选中时按以下顺序尝试：

1. 精确命中 `instanceKey`
2. 命中 `(sourceStableId, sourceTreePath)`
3. 命中 `structuralStableId`
4. 回退到最近仍存在的祖先
5. 全部失败则回退到 tree 级选中

## 降级显示规则

- missing subtree
    - 节点正常显示，但带错误态与路径信息
- invalid subtree
    - 节点正常显示，但提示文件不可解析
- cyclic subtree
    - 节点正常显示，但提示循环引用并停止展开
- unknown node def
    - 节点类型标记为错误或未知，不阻断渲染

## 验收清单

- resolved graph 中每个实例都有唯一 `instanceKey`
- materialized subtree root 能区分 structural identity 与 source identity
- subtree override 能覆盖 root 与 internal node
- 结构变化后 selection restore 有明确退化顺序
