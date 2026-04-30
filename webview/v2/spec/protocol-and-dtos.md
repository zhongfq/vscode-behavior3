# Protocol and DTOs

## 目的

本文件定义：

- webview 与 extension host 之间的 raw wire messages
- V2 内部使用的 normalized DTO
- 路径、节点引用、drop intent 等跨层对象的统一语义

原则：

- raw wire message 可以面向宿主实现
- V2 内部一律使用 normalized DTO
- 历史遗留或宿主 quirks 必须停留在 `HostAdapter`

## Path Rules

V2 内部只承认两类路径：

- `AbsoluteFsPath`
    - 仅用于宿主返回的绝对文件路径
- `WorkdirRelativeJsonPath`
    - V2 文档、subtree link、import、selection、override 一律使用的相对路径

规则：

1. 进入 `commandController` 之前，路径必须已规范化。
2. graph adapter、Inspector、domain 不处理绝对路径拼接。
3. 子树与 import 路径比较时，统一使用规范化后的 `WorkdirRelativeJsonPath`。

## Raw Wire Protocol

### Webview -> Host

- `ready`
- `update`
    - payload: `{ content: string }`
- `treeSelected`
    - payload: `{ tree: PersistedTreeModel }`
- `requestSetting`
    - 请求宿主重新解析当前会话相关设置，并推送最新 `settingLoaded`
- `build`
- `readFile`
    - payload: `{ path: WorkdirRelativeJsonPath, openIfSubtree?: boolean }`
- `saveSubtree`
    - payload: `{ path: WorkdirRelativeJsonPath, content: string }`
- `saveSubtreeAs`
    - payload: `{ content: string, suggestedBaseName: string }`

### Host -> Webview

- `init`
    - payload: `HostInitPayload`
- `fileChanged`
    - payload: `{ content: string }`
- `subtreeFileChanged`
- `settingLoaded`
    - payload: `{ nodeDefs: NodeDef[]; settings?: Partial<Settings> }`
- `varDeclLoaded`
    - payload: `HostVarsPayload`
- `buildResult`
    - payload: `{ success: boolean, message: string }`

## Normalized DTOs

### HostInitPayload

字段职责：

- `filePath`
    - 当前主文档绝对路径
- `workdir`
    - 工作区根目录
- `content`
    - 当前主文档文本
- `nodeDefs`
    - 节点定义
- `allFiles`
    - 工作区内可见文件列表
- `settings`
    - 当前 editor settings
    - 作为首包完整设置快照；后续增量刷新走 `settingLoaded`

### HostVarsPayload

字段职责：

- `usingVars`
    - 宿主计算后的变量视图
- `allFiles`
    - 可选刷新后的文件列表
- `importDecls`
    - import 解析结果
- `subtreeDecls`
    - subtree 解析结果

### NodeInstanceRef

`NodeInstanceRef` 是图层与 Inspector 之间传递“当前节点实例”的稳定引用。

字段语义：

- `instanceKey`
    - resolved graph 内的唯一实例 key
- `displayId`
    - 用户可搜索的逻辑图节点 id
- `structuralStableId`
    - 当前实例在主文档结构里的锚点 `$id`
- `sourceStableId`
    - 来源 persisted node 的稳定 `$id`
- `sourceTreePath`
    - 来源树文件；主树为 `null`
- `subtreeStack`
    - 从主树走到当前实例时经过的 subtree 路径栈

### DropIntent

- `source`
    - 被拖动节点的 `NodeInstanceRef`
- `target`
    - 目标节点的 `NodeInstanceRef`
- `position`
    - `"before" | "after" | "child"`

`DropIntent` 只表达用户意图，不代表该 drop 一定合法。

### Host Request Results

- `ReadFileResponse`
    - `{ content: string | null }`
- `SaveSubtreeResponse`
    - `{ success: boolean; error?: string }`
- `SaveSubtreeAsResponse`
    - `{ savedPath: WorkdirRelativeJsonPath | null; error?: string }`

## HostAdapter Contract

`HostAdapter` 必须提供：

- `connect(onMessage)`
- `sendReady()`
- `sendUpdate(content)`
- `sendTreeSelected(tree)`
- `sendRequestSetting()`
- `sendBuild()`
- `readFile(path, opts?)`
- `saveSubtree(path, content)`
- `saveSubtreeAs(content, suggestedBaseName)`
- `log(level, message)`

约束：

- raw wire protocol 的奇怪字段、路径差异、时序差异，只能在这里被吸收
- `commandController` 只接收归一化后的 DTO

补充：

- `settingLoaded` 除了显式响应 `requestSetting`，宿主也可以在相关配置源变化时主动推送
- 当前优先用于热更新的设置切片包括：
    - `checkExpr`
    - `subtreeEditable`
    - `language`
    - `nodeColors`
- `.b3-setting`、`.b3-workspace` 与 `behavior3.*` 配置变化都属于允许触发 `settingLoaded` 的宿主事件源

## DTO 设计原则

1. DTO 要表达“业务意义”，而不是某个具体控件或图引擎对象。
2. DTO 必须可序列化、可记录、可测试。
3. DTO 不能混入 DOM event、G6 event、React state setter 之类实现细节。
4. DTO 命名以当前 V2 语义为准，不再以“兼容某旧实现”命名。

## 验收标准

- 任意 command 的输入参数都可以只靠本文件理解
- 任意 host message 都可以只靠本文件知道其 raw shape
- 任意路径值都能判断它属于绝对路径还是 workdir 相对路径
