# Stores and Commands

## 设计约束

V2 的运行时必须满足以下约束：

1. 文档真源只有一个：`documentStore.persistedTree`。
2. 图层、Inspector、宿主通信都不能各自持有第二份可写文档。
3. `selectionStore` 只保存 UI / Inspector 状态，不保存完整树副本。
4. `workspaceStore` 只保存环境态、宿主态和依赖态，不保存可提交文档。
5. 所有用户动作与宿主动作都必须经过 `EditorCommand`。

## 稳定内部接口

内部接口以 [`contracts.ts`](/Users/codetypess/Desktop/Github/vscode-behavior3/webview/shared/contracts.ts) 为准。

当前稳定关注点：

- `DocumentState`
- `WorkspaceState`
- `SelectionState`
- `GraphAdapter`
- `HostAdapter`
- `EditorCommand`

其中：

- `GraphAdapter` 代表 G6 图层边界
- `HostAdapter` 代表 extension host 边界
- `EditorCommand` 代表唯一命令入口

## 状态归属表

| 状态                                                 | 归属                                   |
| ---------------------------------------------------- | -------------------------------------- |
| 当前 persisted tree                                  | `documentStore`                        |
| dirty / alertReload                                  | `documentStore`                        |
| history / historyIndex / lastSavedSnapshot           | `documentStore`                        |
| filePath / workdir / settings                        | `workspaceStore`                       |
| nodeDefs / allFiles / importDecls / subtreeDecls     | `workspaceStore`                       |
| subtreeSources / subtreeSourceRevision               | `workspaceStore`                       |
| selectedTree / selectedNodeKey / selectedNodeRef     | `selectionStore`                       |
| selectedNodeSnapshot / selectedNodeDef               | `selectionStore`                       |
| activeVariableNames / search / inspector panel state | `selectionStore`                       |
| resolved graph                                       | controller / domain 派生，不常驻 store |
| 图节点坐标、视口、G6 内部实例态                      | `graphAdapter`                         |

## Command Catalog

### 启动与宿主同步

- `initFromHost(payload)`
    - 初始化 workspace、document、selection，并触发首次图渲染
- `reloadDocumentFromHost(content)`
    - 在允许覆盖当前文档时重载 persisted tree
- `applyNodeDefs(defs)`
    - 更新节点定义并重建必要的派生状态
    - 与 `workspaceStore.settings` 的热更新配合使用，但只负责 node defs 本身
- `applyHostVars(payload)`
    - 更新宿主计算出的 vars/import/subtree declare 视图
- `markSubtreeChanged()`
    - 标记 subtree 依赖失效，并在下一次刷新时重载

### 选中与可视状态

- `selectTree()`
- `selectNode(nodeKey, opts?)`
- `focusVariable(names)`
- `openSearch(mode)`
- `updateSearch(query)`
- `nextSearchResult()`
- `prevSearchResult()`
- `refreshGraph(opts?)`

这些命令只在必要时重建图；纯视觉变化优先走 graph adapter 的 visual repaint。

### 文档修改

- `updateTreeMeta(payload)`
- `updateNode(payload)`
- `performDrop(intent)`
- `copyNode()`
- `pasteNode()`
- `insertNode()`
- `replaceNode()`
- `deleteNode()`
- `undo()`
- `redo()`

这些命令是唯一允许修改 persisted tree 或 `$override` 的入口。

### 文件与构建

- `saveDocument()`
- `buildDocument()`
- `openSelectedSubtree()`
- `saveSelectedAsSubtree()`

## Host Message Mapping

V2 当前建议保留以下宿主消息职责，不把这些细节泄露到组件层。

### Webview -> Host

- `ready`
    - 通知 webview 可接收初始数据
- `update`
    - 发送当前主文档内容
- `treeSelected`
    - 发送当前树级状态，供宿主刷新相关信息
- `requestSetting`
    - 请求宿主重新解析当前会话相关设置（node defs / 校验开关 / subtree 编辑开关 / 语言 / nodeColors）
    - 请求宿主推送最新 settings / nodeDefs
- `build`
    - 触发宿主构建
- `readFile`
    - 读取 subtree 文件
- `saveSubtree`
    - 保存 subtree 文件
- `saveSubtreeAs`
    - 另存 subtree

### Host -> Webview

- `init`
- `fileChanged`
- `subtreeFileChanged`
- `settingLoaded`
    - 默认用于承载 node defs 与当前会话设置切片的热更新
- `varDeclLoaded`
- `buildResult`

这些 raw messages 由 `HostAdapter` 吸收，再转换成 V2 DTO 与 command 调用。

补充约束：

- `workspaceStore.settings` 在初始化后仍允许被宿主增量刷新
- 组件层不直接读取 VS Code 配置；一律消费 `workspaceStore.settings`
- `.b3-setting`、`.b3-workspace`、`behavior3.*` 配置变化进入 V2 后，统一表现为 `settingLoaded`

## Derived Data

以下数据不作为主 store 真源长期保存：

- `ResolvedDocumentGraph`
- `ResolvedGraphModel`
- variable hit map
- search result keys
- selected node snapshot
- selected node def snapshot
- graph node/edge data for G6

它们应该由 controller / domain / adapter 按需生成、刷新和销毁。

## 验收标准

- 任何 persisted tree 的写入都能指出唯一 command
- 任何图状态写入都能指出唯一 graph adapter 方法
- 任何宿主消息都能指出唯一 host adapter 入口
- 任一字段只出现在一个“可写真源”里
