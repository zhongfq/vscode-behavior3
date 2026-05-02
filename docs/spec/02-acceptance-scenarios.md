# Acceptance Scenarios

## 使用方式

本文件定义当前版本必须满足的行为基线。

它用于：

- 做实现前的行为对齐
- 做手工回归清单
- 限定哪些体验属于“必须成立”，哪些只是可选实现细节

## Case List

### BB-01 启动与初始化

要求：

- 收到 `init` 后，编辑器必须建立完整的 document/workspace/selection 初始状态。
- resolved graph 与 Inspector 初始态必须来自同一份文档快照。
- 图层首次渲染后应处于可浏览状态，不能出现空白容器或需要用户手动触发的二次布局。

### BB-02 外部文件变化处理

要求：

- 文档未脏时，`fileChanged` 应自动替换当前文档并刷新图层。
- 文档已脏时，不得静默覆盖当前编辑内容；应只更新 `alertReload` 一类冲突提示状态。
- 子树文件变化触发后，应刷新相关 subtree source cache，并在下一次 graph rebuild 中生效。

### BB-03 画布与节点选中

要求：

- 点击空白画布进入 tree 级选中态。
- 点击节点进入 node 级选中态，并同步刷新 Inspector。
- 图层刷新后，若目标节点仍存在，应尽量保留选中；若节点消失，退回到最近可解释的选中态。

### BB-04 视口与浏览

要求：

- 主浏览语义是 `pan + zoom`，不是依赖容器滚动浏览整棵树。
- 图层首次渲染时应给出合理的默认视口。
- 调用 `focusNode(instanceKey)` 后，目标节点应进入用户可见区域。
- selection、search、highlight 的视觉变化不应触发整图重新布局。

### BB-05 搜索与跳转

要求：

- search 支持 `content` 与 `id` 两种模式。
- `focusOnly === true` 且 query 非空时，未命中节点应进入灰显。
- 切换搜索结果时，应同步更新选中节点并聚焦目标。
- 清空 query 后，灰显与搜索高亮应被完整清除。

### BB-06 变量高亮

要求：

- 点击图中 `input` / `output` 变量热点后，必须更新 active variable 并重绘高亮。
- 变量高亮至少区分 `input`、`output`、`args` 三类命中来源。
- active variable 为空时，所有变量相关高亮应清除，同时保留当前 search 状态。

### BB-07 拖放与重排

要求：

- 图层必须支持 `before`、`after`、`child` 三种 drop intent。
- 拖动过程中应有明确的目标反馈，而不是只在 drop 后报错。
- drop 通过统一的 `DropIntent` 回交给 controller，由 controller 决定是否提交。

### BB-08 拖放拒绝规则

要求：

- 根节点不能被移动。
- 节点不能拖入自己的后代。
- subtree internal node 不能作为结构编辑目标。
- 不允许把节点投放到违反文档树结构约束的位置。

具体拒绝规则的业务判断归 `commandController`，图层只负责命中与意图翻译。

### BB-09 子树展开与显示

要求：

- subtree link 在 resolved graph 中可以展开为 materialized subtree。
- 子树文件缺失、非法或循环引用时，图层仍应显示降级节点，而不是整图失败。
- 主树节点、subtree root link、subtree internal node 在 Inspector 和图层中必须有可区分的语义。

### BB-10 Tree Inspector 编辑

要求：

- Tree Inspector 修改元数据后，文档、resolved graph、宿主同步状态要一起更新。
- 树级字段更新后，应尽量保持当前 node selection。
- 导入、变量、group 等树级配置修改必须进入 history。

### BB-11 Node Inspector 编辑与 Override

要求：

- 主树节点编辑直接修改 persisted tree。
- subtree internal node 编辑不直接改 subtree source，而是写入当前主树的 `$override`。
- 当 subtree override 恢复为与基线一致时，应自动删除对应 override 记录。

### BB-12 Undo / Redo / Dirty

要求：

- 只有语义性文档修改才进入 history。
- visual state、选中态、搜索态、视口变化不进入 history。
- dirty 基于当前文档快照与最后保存快照比较得出，而不是人工加减标记。

### BB-13 保存、构建与子树文件操作

要求：

- `saveDocument()` 保存主文档当前 persisted tree。
- `buildDocument()` 不修改文档真源，只触发宿主构建并接收结果。
- `openSelectedSubtree()` 只对 subtree link 有效。
- `saveSelectedAsSubtree()` 应生成新 subtree 文件，并把当前节点改造成 subtree link。

### BB-14 图刷新与状态保持

要求：

- full resolve 只在结构、外部依赖或文档内容变化时发生。
- selection/highlight/search/view state 的纯视觉重绘应走轻量路径。
- graph rebuild 后应先恢复 selection，再重算 visual state。

### BB-15 异常与降级显示

要求：

- unknown node def、missing subtree、invalid subtree、cyclic subtree 都必须有明确的降级节点表现。
- 降级节点仍可被选中、搜索、聚焦和查看上下文。
- 错误节点不会阻断其他正常节点的渲染与交互。

## 最低回归样例

每轮重要改动后，至少人工验证以下路径：

1. 打开一个含主树、子树、变量和 import 的文档，确认初始化、默认视口、Inspector 基础状态正常。
2. 点击节点、点击空白、搜索跳转、变量高亮，确认 selection/search/highlight 互不污染。
3. 拖动一个普通节点做 `before` / `after` / `child`，确认允许与拒绝规则都正确。
4. 修改主树节点与 subtree internal node，确认 persisted tree 与 `$override` 的行为不同。
5. 执行 undo/redo、保存、外部文件变更、子树文件变更，确认图层和 Inspector 状态能回到可解释结果。
