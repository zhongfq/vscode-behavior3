# Inspector Contract

## 目的

当前 Inspector 用于展示并编辑当前 Behavior3 编辑器的树与节点上下文。

它支持两种展示模式：

- `sidebar`
- `embedded`

它与主编辑器共享同一套业务语义，但不直接拥有主文档真源。

## 总体原则

### Principle 1. Inspector 只启用一个展示入口

当前产品通过配置在两种模式中二选一：

- `sidebar`：Tree Inspector 与 Node Inspector 运行在独立 sidebar 中
- `embedded`：Tree Inspector 与 Node Inspector 运行在主编辑器内嵌面板中

不支持两处同时作为活跃编辑入口。

### Principle 2. Inspector 通过宿主代理修改主文档

`sidebar` 模式下的树/节点编辑不会直接改 `persistedTree`，而是通过：

1. `mutateDocument`
2. 宿主定位当前激活主编辑器对应的 extension-host session
3. host session 执行真实 mutation 并提交权威文档状态
4. 宿主再把结果与最新上下文回传侧栏

`embedded` 模式下的 Inspector 运行在当前 editor webview 内，直接复用当前 runtime/controller，但最终 mutation 仍走相同的 host-first 提交流程。

### Principle 3. Inspector 既展示结构，也展示校验与降级信息

Inspector 不只是字段表单，还需要表达：

- subtree resolution error
- 节点参数校验错误
- subtree override 差异
- 当前无激活文档时的空状态

## Inspector Title Actions

Inspector 暴露同一组 project/document quick actions，但承载位置随模式不同：

- `sidebar` 模式：通过 Behavior3 Inspector view title 暴露 VS Code 原生 toolbar 按钮
- `embedded` 模式：通过 Inspector pane 顶部内嵌 header toolbar 暴露同组按钮

两种模式下都包含以下 command：

- `behavior3.build`
- `behavior3.toggleEditorMode`
- `behavior3.toggleInspectorNodeJson`
- `behavior3.createProject`

这些按钮只复用既有 extension-host command。`embedded` 模式允许 Inspector webview 通过受限 allowlist host message 转发这几个命令，但不直接修改文档真源，也不引入任意命令执行面。若当前没有合适的 active editor、workspace 或目标路径，仍由对应 command 自己给出提示。

## 外层状态

### No Active Document

- 显示空状态文案
- 不保留上一份文档的陈旧字段

### Embedded Mode Notice

- 当当前入口不是启用的 Inspector 模式时，显示提示态而不是第二个可编辑入口

### Tree Selected

- 显示 Tree Inspector
- `sidebar` 模式下，即使当前共享选中仍然是同一棵 tree，重复的显式 tree 选中手势也应重新激活 Inspector Sidebar，而不是要求用户先切到别的选中目标

### Node Selected

- 显示 Node Inspector
- `sidebar` 模式下，即使当前共享选中仍然是同一逻辑节点，重复的显式节点选中手势也应重新激活 Inspector Sidebar，而不是要求用户先切到别的节点
- 若 host 已确认当前为 node selection，但新文档 graph 仍在重建、`selectedNodeSnapshot` 尚未恢复，Inspector 仍停留在 node 通道，并显示 pending/loading 态，而不是闪回 Tree Inspector
- 若当前文档此前已经成功渲染过同一逻辑节点，两种模式下的 Inspector 都应先复用该文档缓存的 node snapshot，待真实 snapshot 恢复后再覆盖，从而避免重复 loading 动画
- 对同一逻辑节点的 field blur 提交，Inspector 不应因为 committed snapshot 往返而把 pane 降级成 skeleton 或 remount 整个表单；字段间切换应尽量保持当前滚动位置与下一目标输入的聚焦机会

### Reload Conflict

- 顶部显示 warning banner
- 提供 reload 与 dismiss 操作

## Tree Inspector Contract

当前 Tree Inspector 结构为：

### Section Order

1. `name`
2. `desc`
3. `prefix`
4. `export`
5. `group`（仅在存在 groupDefs 时显示）
6. local vars
7. subtree declarations
8. import refs
9. custom metadata

### Tree Meta

- `name` 只读
- `desc` / `prefix` 可编辑
- `export` 用 `Switch`
- `group` 用多选 `Select`

### Local Vars

- 支持新增、删除
- `name` 必须是合法变量名
- `desc` 必填
- 提交后进入 `updateTreeMeta` intent，由 host session 决定是否提交

### Subtree Decls

- 由宿主 `subtreeDecls` 驱动
- 只读展示每个 subtree 的变量列表
- 可通过 inline action 打开对应 subtree 文件

### Import Refs

- 由 `document.variables.imports` 驱动
- 使用工作目录 `allFiles` 作为自动补全来源
- 每个 import path 下展示宿主解析出的变量声明

### Variable Usage Badges

- Tree Inspector 中每个变量行左侧显示 usage badge
- 计数按当前 resolved graph 统计，而不是只看主文档 persisted root
- 统计范围包含主树以及当前可达的 materialized subtree 实例
- `input`、`output` 与表达式型参数中的变量引用都计入统计
- 同一个 subtree file 被引用多次时，各 materialized 实例分别计数

### Custom Metadata

- 由 `document.custom` 驱动
- 使用可增删的 `key:value` 行编辑
- 每行左侧显示一个根据当前输入推断出的类型徽章
- `key` 必填且不能重复
- `value` 仅支持 `string`、`number`、`boolean`
- 裸文本默认按字符串处理；布尔字面量、数字字面量和带引号字符串按值解析
- 对象、数组或非法结构化输入拒绝提交

## Node Inspector Contract

当前 Node Inspector 至少包含以下区域：

### Section Order

1. identity
2. `type`
3. `group`（若 nodeDef 声明）
4. `children`
5. `name`
6. `desc`
7. `debug`
8. `disabled`
9. `path`
10. nodeDef markdown doc（若存在，且当前不在 JSON 视图）
11. input slots（若当前不在 JSON 视图）
12. output slots（若当前不在 JSON 视图）
13. structured args（若当前不在 JSON 视图）
14. raw node JSON view
15. edit subtree action（仅可打开 subtree 的节点）

### Readonly Meta

- identity 区只读，同时展示：
    - `displayId`
    - `uuid`
- 其中 `displayId` 来自 `selectedNode.ref.displayId`
- `uuid` 来自当前 `selectedNode.data.uuid`
- `displayId` 采用内容自适应宽度展示，`uuid` 占据 identity 行剩余空间
- `type` 只读，来自 nodeDef.type 或 unknown fallback
- `children` 只读，展示当前 children 约束结果

### Editable Core Fields

- `name` 可通过 nodeDefs 自动补全切换节点类型
- Inspector 发起任意节点更新时，若当前目标 `nodeDef` 不再声明旧 `input`、`output` 或 `args`，该次提交必须裁剪这些陈旧字段，且不得顺带补齐新的默认字段或空槽位
- `desc`、`debug`、`disabled` 可编辑
- `path` 可编辑 subtree link；subtree 内部节点自身不允许再改 path
- 切换节点时，Inspector 先丢弃上一节点的局部表单缓存，再根据当前节点快照重建字段值
- `name` 引发的 nodeDef 预览切换，也必须先丢弃上一节点留下的依赖字段缓存，再显示新的输入槽/参数预览
- 对当前没有 committed 值的 required arg，Inspector 预览态应表现为“缺值”，而不是把 `undefined` 写进嵌套表单对象

### Inputs / Outputs

- 按 nodeDef 的 slot 声明渲染
- variadic 槽位使用数组式列表
- required / optional / oneof 约束即时校验
- 若 slot 定义了 `visible`，其值可以是 host-side hook 名称或 inline expression；只有可见性结果显式为 `false` 时才隐藏，隐藏后必须清除该 slot 的 committed 值与本地表单缓存
- 若 slot 的 `visible` 无法解析、被 capability setting 禁用、编译失败或运行时报错，该 slot 仍保持渲染，但对应 input/output 字段必须显示错误提示
- 若 slot 定义了 `checker`，以及 `visible` 执行链路产出的字段错误，都会映射到对应 input/output 字段校验提示

### Args

- 按 arg 类型渲染为 `Select` / `Switch` / `InputNumber` / `TextArea` 等
- 若 arg 定义了 `visible`，其值可以是 host-side 可见性 hook 名称或 inline expression；只有返回显式 `false` 时隐藏
- 若 arg 的 `visible` 无法解析、被 capability setting 禁用、编译失败或运行时报错，该 structured arg 仍保持渲染，但对应 arg 字段必须显示错误提示
- args / input / output 共用一份 host-side field visibility 状态；raw JSON 视图不参与该可见性裁剪
- args / input / output 共用一套 host-side field diagnostics 通道；`checker` 与 `visible` 失败都按字段种类映射到对应表单错误
- 带 `options` 的参数渲染为可搜索 `Select`，搜索按显示 label 匹配 option name/value 文本
- 可选且带 `options` 的标量参数在当前没有 committed/effective 值时，Select 显示为空选中态，不向用户暴露内部 unset 哨兵文案
- `bool` / `bool?` 标量参数统一渲染为 `Switch`；项目内 bool 参数不通过 `options` 配置枚举值
- 表达式型参数校验变量引用与表达式合法性
- 自定义 field check 结果与 `visible` 执行失败都会按字段种类映射到对应 arg 校验提示
- hidden arg 会退出 structured 视图，并清除该字段的 committed 值与本地表单缓存；raw JSON 视图仍展示节点当前剩余数据
- 新切入的 required arg 若当前还没有 committed 值，初始态保持 unset；在用户显式输入前不得静默序列化成 `""`、`false` 或其他占位值
- 若 arg 定义了 nodeDef 默认值，则该字段右侧显示独立 reset action；点击后先二次确认，再清除当前显式值并回退到默认值语义

### Raw JSON View

- `sidebar` 模式下，已知节点可通过 view title 上的 `behavior3.toggleInspectorNodeJson` 切到原始节点 JSON 只读视图
- raw JSON 内容来自当前 `selectedNode.data`
- raw JSON 视图使用可选中复制的只读控件，而不是 disabled 文本框
- 当前 nodeDef 不存在时，不渲染结构化 args
- 未知节点默认进入 raw JSON 视图

### Edit Subtree Action

- 若当前节点自身存在 `path`，或其 `ref.subtreeStack` 非空，则 Node Inspector 底部显示全宽“编辑子树”按钮
- 该按钮复用 `openSelectedSubtree()` 语义，不单独派生路径或目标节点 identity
- subtree link 节点与 materialized subtree 内部节点都可通过该入口打开对应 subtree

## Override Contract

当前 override 交互只用于 subtree 内部节点：

### 显示条件

- `selectedNode.subtreeNode === true`
- 且存在 `subtreeOriginal`

### Reset Scope

可逐字段 reset：

- `desc`
- `debug`
- `disabled`
- 输入槽
- 输出槽
- 结构化 args

### 语义

- 对 subtree 节点的 override 比较，`subtreeOriginal` 与当前 resolved node 使用同一套 arg 默认值归一化
- 对 subtree 节点的 `debug` / `disabled` 覆写，提交链路必须保留显式 `false`，以便把源节点的 `true` 关闭成主文档 override
- 因此 nodeDef 的默认参数补齐本身不会单独点亮 override UI
- 对 subtree 节点的 selected snapshot，`data.args` 必须保留当前 resolved/current args，不能回落成空对象或只保留主树 committed JSON，因为 Inspector 需要它来和 `subtreeOriginal` 做 override 比较
- 对主树普通节点，结构化参数区可以展示 resolved/effective arg 默认值；但只读 JSON 与提交基线仍以主文档实际持久化数据为准
- 对主树普通节点，若 arg 输入框当前只是展示默认值且用户未实际修改该字段，blur 不应把默认值写回主文档
- reset 后提交新的 node 数据
- host reducer 会重新计算 override diff
- 若 diff 为空，则从主文档 `overrides` 中删除

## 标签交互

Inspector 表单 label 只用于展示字段名、必填标记和冒号；点击 label 不应聚焦字段或进入编辑。字段只能通过直接点击输入框、选择器、开关等控件进入交互。

## 可编辑性规则

当前 Inspector 中有两类“不可编辑”：

### 1. 业务只读

- `name`、`id`、`type` 等元字段本就只读或半只读
- `path` 对 subtree 内部节点只读

### 2. subtree 结构锁

当节点来自外部 subtree 且 `subtreeEditable = false` 时：

- 字段编辑会被禁用
- 但仍可查看当前解析结果

注意：

- 节点自身的 `data.disabled` 是 persisted 字段
- `selectedNode.disabled` 在 Inspector snapshot 中表达的是“当前是否因 subtree 规则而不可编辑”

## 提交节奏

当前 Inspector 提交通常遵循：

- 文本输入：`onBlur`
- `Switch` / `Select`：立即排队提交
- 列表增删：立即排队提交
- Node Inspector 的 commit/reset 编排由 feature-local `useNodeInspectorCommitters` 持有；JSX 组件只接入字段渲染和回调

提交粒度规则：

- 每次只提交当前编辑字段，或该字段所属的最小局部列表单元
- 某个字段的校验错误不会阻断无关字段的提交
- 非法字段保留本地错误提示，不得静默写入主文档
- `oneof` 这类显式耦合字段允许继续按局部约束拒绝提交
- Inspector 局部 `oneof` 校验必须基于 arg 的解析后值执行；“未填写”不能因为内部表单占位值而被误判成已填写
- slot label、required、variadic 与 node arg type/options 校验使用 shared state-free validation helper；`oneof` 这类局部耦合校验同样复用 shared helper，并结合当前表单上下文决定提交错误与 resolved-node diagnostic，不能在 Inspector 局部再实现一套平行基础规则

`sidebar` 模式下，在执行保存、撤销、重做前，会先 flush 待提交的 Inspector 编辑。

## 变量聚焦契约

- `sidebar` 模式下点击变量行时，发送 raw `requestFocusVariable`，请求宿主把变量聚焦 relay 给当前主编辑器
- 主编辑器图层热点点击也会驱动相同变量聚焦语义
- 变量聚焦不直接修改文档，只影响 editor-local graph UI 视觉状态
- 变量聚焦不写入 `init` / `documentSnapshotChanged`，也不跨 reload/save/undo/redo 持久化

## 验收要点

- 当前启用的 Inspector 展示面永远展示当前激活 Behavior3 编辑器的上下文
- Tree Inspector 与 Node Inspector 的字段、校验和提交路径稳定
- subtree override 与 resolution error 能在 UI 中明确表达
