# Architecture

## 总体结构

当前架构的目标不是“把图画出来”，而是把编辑器拆成可替换、可验证的层。

推荐分层如下：

```text
React Components
  ├─ EditorShell
  ├─ GraphPane
  ├─ InspectorPane
  └─ Search / Toolbar / Status UI

Command Controller
  ├─ UI intent -> domain mutation
  ├─ graph event -> command
  └─ host event -> store updates

Stores
  ├─ documentStore
  ├─ workspaceStore
  └─ selectionStore

Adapters
  ├─ G6GraphAdapter
  └─ HostAdapter

Domain
  ├─ resolve graph
  ├─ override diff
  ├─ search/highlight selectors
  └─ tree mutation helpers
```

## 层职责

### Components

组件层只做三件事：

- 读取 store selector
- 触发 `commandController`
- 挂载 graph / inspector / search 等 UI

组件层禁止：

- 直接调用宿主 `postMessage`
- 直接调用 G6 实例
- 直接修改 persisted tree

### Command Controller

`commandController` 是编辑器唯一动作入口。

它负责：

- 接收 UI、图层、宿主三类事件
- 调用 domain mutation 与 selector
- 决定何时 full resolve、何时仅视觉重绘
- 协调 stores、graph adapter、host adapter

它不负责：

- 直接渲染图节点
- 直接生成 DOM 或 G6 shape
- 保存额外的图层内部真源

### documentStore

只保存可持久化或与持久化直接相关的状态：

- 当前 persisted tree
- dirty
- alertReload
- history / historyIndex
- lastSavedSnapshot

### workspaceStore

保存宿主和环境态：

- filePath / workdir
- nodeDefs / allFiles / settings
- usingVars / usingGroups / importDecls / subtreeDecls
- subtreeSources
- 宿主刷新序列号

### selectionStore

保存纯 UI / Inspector 状态：

- 当前选中 tree / node / nodeDef
- active variable names
- search state
- Inspector panel state

### G6GraphAdapter

`G6GraphAdapter` 是图层桥接器，不是业务核心。

它负责：

- 管理 G6 graph 实例生命周期
- 把 `ResolvedGraphModel` 转成 G6 data
- 注册自定义节点、边、behaviors
- 应用 selection / search / highlight / viewport visual state
- 将 G6 事件翻译为标准 graph events

它禁止：

- 直接读写 stores
- 私自调用 host adapter
- 自己决定文档结构是否合法

### HostAdapter

`HostAdapter` 负责：

- webview 与 extension host 的消息协议
- 文件读取、子树保存、构建请求、日志
- 将 wire messages 归一化成内部 DTO
- 把宿主配置源变化统一折叠成 `settingLoaded`

## G6 方向约束

图层实现统一按以下规则设计：

- React 不负责节点坐标计算和拖放命中
- 节点视觉由 G6 自定义节点承担
- 布局优先使用 G6 树布局或其定制版本
- 视口状态由 graph adapter 维护并暴露标准接口
- 业务层永远不接触 G6 原生事件对象

## 关键事件流

### 启动

1. `hostAdapter` 收到 `init`
2. `commandController.initFromHost(...)`
3. 初始化 `workspaceStore` 与 `documentStore`
4. resolve 当前文档得到 `ResolvedDocumentGraph`
5. `graphAdapter.render(...)`
6. `graphAdapter.applySelection/applySearch/applyHighlights(...)`

### 设置热更新

1. 宿主监听 `.b3-setting`、`.b3-workspace` 与 `behavior3.*` 配置变化
2. 宿主重新解析 node defs 与当前会话相关设置切片
3. 通过 `settingLoaded` 推送给 webview
4. webview 更新 `workspaceStore.settings`
5. 必要时重建 resolved graph，并让依赖该设置的 UI 重新读取 store

### 文档修改

1. Inspector 或图交互触发 command
2. controller 修改 persisted tree 或 `overrides`
3. 必要时同步 subtree source cache
4. rebuild resolved graph
5. graph adapter full render
6. 恢复 selection 并重放 visual state
7. 向 host 发出必要同步

### 纯视觉状态修改

1. 用户切换搜索、变量高亮或 focus
2. controller 只更新 `selectionStore`
3. graph adapter 执行 visual repaint
4. 不触发 history，也不重建 persisted tree

### 拖放

1. G6 节点拖动产生候选落点
2. graph adapter 翻译为标准 `DropIntent`
3. controller 验证是否合法
4. 合法则提交文档 mutation，非法则报错并保持原图

## 推荐目录结构

```text
webview/
  app/
  adapters/
    graph/
    host/
  commands/
  domain/
  features/
    graph/
    inspector/
    search/
  shared/
  spec/
  stores/
```

## 架构验收标准

- 图层替换不要求改 store schema
- search/highlight/selection 的业务规则不写在 G6 事件里
- subtree resolve 与 override diff 不依赖图引擎
- 任一跨层行为都能指出唯一责任层
- 宿主配置变化不会要求组件直接触碰 wire message 或 VS Code API
