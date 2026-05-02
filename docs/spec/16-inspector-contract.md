# Inspector Contract

## 目的

本文件定义 Inspector 的结构、提交流程和 override 语义。

它服务的是“高频编辑侧栏”，不是独立详情页。

## 总体原则

### Principle 1. Inspector 是编辑侧栏

要求：

- 保持窄栏、高密度、快速浏览与编辑
- tree/node 两种上下文切换要清晰
- 不把节点编辑拆成多个全屏步骤

### Principle 2. 提交按字段节奏进行

要求：

- 单字段修改应尽快进入 command
- 不依赖整表 `Apply`
- 校验失败要留在当前字段上下文，不把整份表单锁死

### Principle 3. 结构先于装饰

Inspector 的主要职责是让用户快速理解：

- 当前选中的是 tree、普通节点、subtree root 还是 subtree internal node
- 哪些字段可编辑
- 哪些值来自 subtree source
- 哪些字段当前是 override

## 外层布局契约

### Inspector Pane

- 固定在编辑器一侧
- 与图层并排，而不是盖在图上
- 允许滚动，但不改变图层视口

### Header

header 至少应表达：

- 当前上下文类型
- 当前节点标题
- 关键只读标识，如 `displayId`、节点类型、subtree 来源

### Form Structure

要求：

- label 宽度稳定
- 高度紧凑
- 长文本可折行
- 错误提示就地显示
- 字段级校验错误以 Inspector 为唯一展示入口，不同步回 graph 节点卡片

## Tree Inspector Contract

### Section Order

建议顺序：

1. Tree Meta
2. Group
3. Local Vars
4. Subtree Vars
5. Import Vars

### Tree Meta

至少包含：

- `name`
- `prefix`
- `desc`
- `export`

### Group

- 支持树级 group 编辑
- 变更进入 history

### Local Vars

- 显示主文档本地 vars
- 支持新增、编辑、删除

### Subtree Vars / Import Vars

- 主要用于查看和理解依赖来源
- 若存在冲突或缺失，应有清晰提示

## Node Inspector Contract

### Section Order

建议顺序：

1. Node Summary
2. Readonly Meta
3. Editable Core Fields
4. Subtree Source / Path
5. Doc / Description
6. Input / Output
7. Args

### Readonly Meta

至少展示：

- `displayId`
- `typeLabel`
- `sourceStableId`
- `structuralStableId`
- `sourceTreePath`
- `subtreeStack` 摘要

### Editable Core Fields

普通主树节点可编辑：

- `name`
- `desc`
- `debug`
- `disabled`
- `path`

subtree internal node：

- 只允许编辑 override 范围内的字段
- 不允许直接改结构字段

materialized subtree root：

- subtree 内容字段按 override 处理
- subtree link 路径字段单独编辑

### Subtree Source / Path

当节点与 subtree 相关时，应明确显示：

- link path
- 来源 subtree 文件
- 当前节点是结构锚点还是仅来源节点

### Input / Output Variables

要求：

- 使用列表或行编辑模型
- 支持点击变量名触发高亮
- 空值与非法值要有就地提示

### Args

要求：

- 按 node def 动态渲染
- 支持表达式与基础类型校验
- 表达式相关错误不应污染无关字段

### Unknown Fallback

若 node def 缺失：

- 仍显示基础字段与原始值
- 禁止因未知节点而导致 Inspector 崩溃

## Override Contract

### 字段级 override 是主交互

override 必须精确到字段级，而不是只给“整节点已覆写”的模糊提示。

### Override Bar

建议表现：

- 在字段或区块旁显示轻量 override 标记
- 能看出该值来自当前文档而非 subtree source

### Reset

要求：

- 支持将单字段恢复到来源值
- 恢复后若整个 override 为空，应删除 `$override[sourceStableId]`

## Variable Highlight Contract

Inspector 里的变量名点击与图层变量点击语义一致：

- 点击后更新 active variable
- 图层重绘高亮
- 不改变当前 tree/node 选中上下文

## 验收要点

- 用户能一眼分辨自己在编辑主树节点还是 subtree 派生节点
- 字段修改后，图层与文档状态会同步更新
- override 的来源、存在与重置语义清晰
- 未知节点、缺失 node def、异常 subtree 不会让 Inspector 失效
