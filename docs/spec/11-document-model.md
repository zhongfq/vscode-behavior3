# Document Model

## 目标

本文件描述当前实现中的文档真源、宿主文档镜像、subtree 缓存、override 语义与 history/save/reload 模型。

核心原则：

- webview 内可写的结构化树只有一份：`documentStore.persistedTree`
- extension-host 内可写的序列化文本只有一份：`TreeEditorDocument.content`
- extension-host 的 `TreeEditorDocument.sessionState` 是 dirty、save、history 与 reload conflict 的权威会话元数据
- resolved graph、图视图模型、变量高亮和搜索结果都属于派生数据

## 主文档持久化模型

### PersistedTreeModel

`PersistedTreeModel` 是当前主文档的结构化表示，字段以 [`contracts.ts`](../../webview/shared/contracts.ts) 为准。

基础 tree/model TypeScript 形状由 [`b3type.ts`](../../webview/shared/b3type.ts) 直接持有，`contracts.ts` 在此基础上定义 host/webview 稳定 DTO。

- `version`
- `name`
- `prefix`
- `desc`
- `export`
- `group`
- `variables.imports`
- `variables.locals`
- `custom`
- `root`
- `overrides`

说明：

- `version` 是持久化模型的规范字段；若 legacy tree 文件缺少该字段，读取时会先归一化为当前 `DOCUMENT_VERSION`，后续写回再显式落盘。

### PersistedNodeModel

当前实现中每个 persisted node 至少可能包含：

- `uuid`
- `id`
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

其中：

- `uuid` 是稳定结构锚点
- `id` 是面向展示或兼容旧数据的字段，不再被视为唯一运行时主键
- `path` 表示该节点引用了外部 subtree 文件
- `$status` 是物化后按 nodeDefs 和子节点状态计算出的位标记

## Webview 文档态

### DocumentState

`documentStore` 当前持有：

- `persistedTree`
- `dirty`
- `alertReload`
- `pendingExternalContent`

语义：

- `dirty`
  - 宿主权威 document session 回推的脏状态 projection，不在 webview 本地独立计算
- `alertReload`
  - 表示检测到了外部文件变化，但当前文档仍有未保存修改
- `pendingExternalContent`
  - 保存冲突时宿主带回的磁盘内容快照
- webview 不再镜像 `history`、`historyIndex`、`lastSavedSnapshot` 或 host history 游标
  - 这些 save/history 元数据只保留在宿主 `sessionState` 与 host protocol payload 中

## Extension-host 文档态

### TreeEditorDocument

宿主侧的 `TreeEditorDocument` 维护：

- `content`
- `isDirty`
- `sessionState`
- 自身写盘抑制队列 `_ownFileWrites`

语义：

- `content` 是 VS Code custom editor 生命周期看到的文档文本
- `sessionState` 维护当前主文档的 `dirty`、`lastSavedSnapshot`、`historyIndex/historyLength`、reload conflict 元数据
- webview 发来的 `saveDocument` / `undo` / `redo` 只表达 intent，由宿主 session 自己执行并回推结果
- `mutateDocument` 发来的主文档 mutation 先由宿主尝试提交；其中 `updateTreeMeta/updateNode/performDrop/pasteNode/insertNode/replaceNode/deleteNode` 优先走 shared reducer，`saveSelectedAsSubtree` 也已由宿主直接处理保存副作用与主树 link 回写
- `updateNode` intent 现在显式携带 `currentNodeSnapshot`，必要时再携带 `detachedSubtreeRoot`，让 host reducer 不再依赖宿主侧“当前选中节点”瞬时状态
- 宿主监听到文件变化时，会用 `_ownFileWrites` 区分“自己刚写出的变更”和“真正的外部变化”

这意味着：

- webview 内以 `persistedTree` 作为 host snapshot 的结构化 projection，用于 graph/Inspector 渲染与 intent payload context
- 宿主侧以 `content` 为磁盘写入真源
- 宿主 session 负责 save/undo/redo/dirty，以及已迁入 host 的 sidebar/canvas mutation intent 的权威提交状态
- 二者必须通过规范化序列化保持同步

## Workspace 依赖态

`workspaceStore` 当前包含这些与文档相关但非主文档真源的数据：

- `nodeDefs`
- `groupDefs`
- `allFiles`
- `settings`
- `usingVars`
- `usingGroups`
- `importDecls`
- `subtreeDecls`
- `subtreeSources`
- `nodeCheckDiagnostics`

### subtreeSources

`subtreeSources` 是主树可达 subtree 的缓存快照：

- key：`WorkdirRelativeJsonPath`
- value：
  - `PersistedTreeModel`
  - `null`：文件缺失或不可读
  - `{ error: "invalid-subtree" }`：文件存在但不可解析

该缓存由 controller 通过 host `readFile` 递归加载，不由图层主动维护。加载缓存是读路径；若 legacy subtree 需要稳定 id 或字段迁移，写回会被延后到主文档保存流程。缺失 `uuid` 的 legacy 节点按文件路径与节点位置确定性生成，保证多个父树引用同一 subtree 时收敛到同一组稳定 id。

## Selection 与 Inspector 投影视图

`selectionStore` 持有：

- `selectedTree`
- `selectedNodeKey`
- `selectedNodeRef`
- `selectedNodeSnapshot`

说明：

- `selectedTree` / `selectedNodeRef` 是宿主共享 selection 在当前 webview 的本地 projection
- 普通 editor 选中 intent 不会直接改写这些 authority 字段；它们只随宿主 `selection` snapshot 收敛
- `selectedNodeSnapshot` 是给 Inspector 使用的编辑投影
- 当前节点对应的 nodeDef 由 Inspector 按 `selectedNodeSnapshot.data.name` 从 `workspaceStore.nodeDefs` 派生，不作为 selection state 单独存储
- 这些都不是主文档真源，只是当前 resolved graph 的投影视图

`graphUiStore` 持有：

- `activeVariableNames`
- `search`
- `selectionVisualHint`

说明：

- 它们都是 webview-local graph UI state，不属于 host 共享 authority
- `activeVariableNames` 驱动变量高亮
- `search` 驱动 search overlay、结果列表与当前结果 index
- `selectionVisualHint` 是 host snapshot 收敛前的 graph-only transient selection hint
- 这些状态可以在 reload/reset 时整体清空，而不影响 committed host selection projection

## Override Model

当前实现中，subtree 内部节点的可编辑结果存放在主树 `overrides` 上。

### key

- `sourceStableId`

### value

- `desc`
- `input`
- `output`
- `args`
- `debug`
- `disabled`

### 规则

1. override 只用于 subtree 内部节点，不用于主树节点。
2. override 表达的是“相对 subtree 原始节点的差异”。
3. 对 `debug` / `disabled` 这类 boolean 字段，override 比较按有效布尔状态进行；当源值为 `true` 且当前值显式关闭时，主文档 override 必须保留 `false`。
4. 若差异为空，应删除对应 override 条目。
5. override 不会直接回写 subtree 源文件。
6. 若某个 override 对应的 subtree 源节点已不再从当前主树可达，则宿主在可完整解析当前 reachable subtree graph 时应清理该条目。

## History 与 Dirty

### 推进 history 的操作

- `updateTreeMeta`
- `updateNode`
- `performDrop`
- `copyNode`
- `pasteNode`
- `insertNode`
- `replaceNode`
- `deleteNode`
- `saveSelectedAsSubtree` 造成的主树变化

### 不推进 history 的操作

- selection 变化
- search 条件变化
- variable focus 变化
- graph-only selection hint 变化
- 视口变化
- 图纯视觉刷新
- 宿主推送的主题、变量声明、nodeDefs 热更新

### Dirty 规则

- 宿主 session 的 dirty 由“当前宿主快照是否等于 lastSavedSnapshot”决定
- webview `documentStore.dirty` 只通过 `documentSnapshotChanged.documentSession` 镜像宿主 dirty
- dirty 不是独立于快照的第二份手工业务真源

## Save / Revert / Reload

### Save

保存路径：

1. webview 发送 `saveDocument` intent
2. 宿主在写盘前按当前主树解析结果回写主树节点 `id`
3. 宿主收集当前可达 legacy subtree 的规范化写回，并在同一次保存动作内显式写回这些 subtree 文件
4. 宿主保存当前规范化后的 `TreeEditorDocument.content`
5. 成功后更新宿主 `sessionState.lastSavedSnapshot` 与当前 history 游标快照
6. 宿主广播带当前 `selection` 的 `documentSnapshotChanged(syncKind: "reload")`

### Undo / Redo

1. webview 发送 `undo` 或 `redo` intent
2. 宿主在 `sessionState.history` 上推进 history 游标
3. 宿主更新 `TreeEditorDocument.content` / `isDirty`
4. 宿主广播带当前 `selection` 的 `documentSnapshotChanged(syncKind: "update")`

### Revert

- 宿主重新读取磁盘内容
- webview 通过带当前 `selection` 的 `documentSnapshotChanged(syncKind: "reload")` 强制应用宿主快照
- history 以磁盘快照重置

### External Reload Conflict

- 外部文件变化到达且当前无未保存修改：静默 reload
- 外部文件变化到达且当前 dirty：仅设置 `alertReload` 与 `pendingExternalContent`

## 文档规范化

写回磁盘前会做当前实现要求的规范化：

1. 尝试按行为树模型重新解析/序列化
2. legacy tree 若缺少 `version`，内存模型会先补成当前文档版本，并在后续写回时显式落盘
3. 主文档 `name` 与目标文件名保持一致
4. subtree 文件在加载时若缺少稳定 id，会在内存模型中按确定性规则补齐；磁盘回写只在主文档保存时发生
5. 写回主文档前，若当前 reachable subtree graph 可完整解析，应清理已不可达的 stale `overrides`
6. persisted node 若没有任何内联子节点，写回结果应省略空 `children` 字段

## 不变量

1. 任意时刻，webview 里只有一份可写 `persistedTree`。
2. 任意时刻，宿主里只有一份代表当前 custom editor 内容的 `TreeEditorDocument.content`。
3. `subtreeSources`、resolved graph、Inspector snapshot、graph model 都可以丢弃并重建。
4. 图层和侧栏都不能绕过 controller 或宿主会话直接写磁盘。
5. save、undo、redo 必须先进入宿主 document session。
