# Editor Semantics

## 目的

本文件定义编辑器 command 的精确语义，以及它们如何驱动：

- 文档修改
- resolved graph 重建
- 纯视觉重绘
- 宿主同步

## 总规则

### Rule 1. 所有跨层动作都走 commandController

组件、graph adapter、host adapter 都不直接改 persisted tree。

### Rule 2. 区分 full resolve 与 visual repaint

- full resolve
    - 重建 `ResolvedDocumentGraph` 与图数据
- visual repaint
    - 只更新 selection/search/highlight/viewport 等可视状态

### Rule 3. dirty 由快照比较决定

dirty 只由 persisted tree 当前快照与最后保存快照比较得出。

### Rule 4. 图层不是命令所有者

G6 只翻译事件，不拥有业务规则。

## 共享内部流程

### `syncReachableSubtreeSources(reason)`

职责：

- 遍历当前主文档中可达的 subtree link
- 通过 `HostAdapter.readFile(...)` 刷新 subtree source cache
- 记录缺失、非法和循环引用相关结果

### `rebuildResolvedGraph(reason, opts?)`

职责：

- 从当前 persisted tree + subtree cache 解析 resolved graph
- 推导 `ResolvedGraphModel`
- 触发 graph adapter `render(...)`
- 按需恢复 selection
- 重放 visual state

### `applyGraphVisualState()`

职责：

- 下发 selection
- 下发 variable highlight
- 下发 search state
- 必要时聚焦目标节点

### `commitDocumentMutation(mutator, opts?)`

职责：

- 克隆当前 persisted tree
- 执行 mutation
- 写回 document store
- 处理 history / dirty / host sync / graph rebuild

## Selection 语义

### `selectTree()`

- 清空 selected node
- 进入 tree Inspector 上下文
- graph adapter 取消节点选中态

### `selectNode(nodeKey, opts?)`

- 选中 resolved graph 中对应实例
- 刷新 selected node snapshot 与 node def snapshot
- 默认不移动视口；需要时由 `focusNode(...)` 单独触发

### `focusVariable(names)`

- 更新 active variable names
- 重算 highlight state
- 不修改 persisted tree

## Search 语义

### `openSearch(mode)`

- 打开搜索 UI
- 切换 `content` / `id` 模式
- 不自动修改当前 query

### `updateSearch(query)`

- 更新 query
- 重算结果列表
- 若存在结果，默认激活第一个结果并触发 `focusNode`

### `nextSearchResult()` / `prevSearchResult()`

- 只在现有结果内循环切换
- 切换后更新选中节点并聚焦目标

### 视口稳定性

- 非导航型交互应尽量保持当前视口
  例如字段提交、selection 变化、变量高亮、宿主 variables/import/subtree decl 回流
- full render 与 graph 容器 resize 后都应恢复原视口
- 显式导航型交互允许移动视口
  例如搜索结果聚焦、用户拖动画布、用户缩放画布

## Host 驱动命令

### `initFromHost(payload)`

职责：

1. 初始化 workspace state
2. 解析主文档内容为 persisted tree
3. 刷新 subtree cache
4. 构建首个 resolved graph
5. 默认进入 tree 或首节点选中态

### `reloadDocumentFromHost(content)`

- 仅在允许覆盖当前文档时执行
- 重新解析 persisted tree
- 重建 resolved graph
- 尽量恢复 selection

### `applyNodeDefs(defs)`

- 更新 workspace nodeDefs
- 若影响节点样式、类型判断或字段渲染，则重建 resolved graph

### `applyHostVars(payload)`

- 更新 variables/import/subtree declare 相关派生数据
- 默认不推进 history

### `markSubtreeChanged()`

- 标记 subtree cache 失效
- 下次刷新或当前可安全刷新时重载 subtree sources

## 文档变更命令

### `updateTreeMeta(payload)`

- 修改主文档树级字段
- 推进 history
- 重建 resolved graph
- 尽量保留当前节点选中

### `updateNode(payload)`

按节点类型分三类处理：

#### A. 普通主树节点

- 直接修改 persisted node
- 推进 history
- 重建 resolved graph

#### B. Materialized Subtree Root

- `path` 相关修改落到 structural link node
- subtree 内容字段修改落到 `overrides[sourceStableId]`
- 不直接改 subtree source 文件

#### C. Subtree Internal Node

- 仅允许写 `overrides[sourceStableId]`
- 不允许直接改结构

### `performDrop(intent)`

- 先校验 drop 是否合法
- 合法时修改主文档结构
- 非法时抛出用户可见错误
- drop 永远不直接改 subtree source 结构

### `copyNode()`

- 复制当前选中实例对应的“可脱离主树保存”的 persisted snapshot
- 若源自 subtree internal node，复制的是已物化的本地快照，而不是外部文件引用

### `pasteNode()`

- 将 clipboard snapshot 粘贴回主文档结构
- 默认优先作为 child，其次作为 sibling
- 粘贴节点必须生成新的稳定 `uuid`

### `insertNode()`

- 在当前选中位置插入新节点
- 具体默认节点类型由 UI 或 node def picker 决定

### `replaceNode()`

- 用新节点定义替换当前节点
- 是否保留 children 由新旧节点的结构能力决定

### `deleteNode()`

- 删除当前主树结构节点
- 根节点不可删除
- 删除后 selection 回到最近有效父节点或 tree

### `undo()` / `redo()`

- 恢复 history 快照
- 重新 resolve graph
- 恢复 selection 与 visual state

## 图与宿主命令

### `refreshGraph(opts?)`

- 强制刷新图层
- 默认保留 selection
- 必要时同步 subtree cache 后再 resolve

### `saveDocument()`

- 序列化当前 persisted tree
- 调用 `HostAdapter.sendUpdate(content)`
- 成功后更新 `lastSavedSnapshot`

### `buildDocument()`

- 调用 `HostAdapter.sendBuild()`
- 不修改文档真源

### `openSelectedSubtree()`

- 仅对带 `path` 的节点有效
- 无 path 时为 no-op 或用户可见提示

### `saveSelectedAsSubtree()`

- 读取当前选中节点内容
- 生成 subtree 文件
- 调用 `HostAdapter.saveSubtreeAs(...)`
- 成功后把当前节点替换为 subtree link

## alertReload 语义

- 外部主文件变化且当前文档已脏时，设置 `alertReload = true`
- 用户显式重载或保存成功后，清除 `alertReload`

## 验收清单

- 每个 command 都能说清楚它改的是 persisted tree、visual state 还是 host state
- 每次文档 mutation 都能说清楚是否推进 history
- 每次 graph 刷新都能说清楚是 full resolve 还是 visual repaint
- subtree 相关节点的编辑能区分 structural mutation 与 override mutation
