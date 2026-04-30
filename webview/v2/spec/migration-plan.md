# Migration Plan

## 目标

从“当前混合了自绘图层与旧假设的 V2 骨架”走到“以 G6 为核心、边界清晰、文档与实现一致的 V2 编辑器”。

## 阶段 0：重置文档基线

交付物：

- 刷新后的 `webview/v2/spec/*`
- 明确的 G6 技术路线
- 去除 V1 parity / React Flow / 自绘图层前提

完成标准：

- 各文档术语一致
- 图层、宿主、文档模型的边界已经固定
- 后续实现不再需要回头追问“是不是要兼容旧图层”

## 阶段 1：收敛稳定接口

先收敛这些文件：

- `webview/v2/shared/contracts.ts`
- graph / host adapter 接口
- command catalog

完成标准：

- 图层输入输出契约稳定
- DTO 命名与文档一致
- 不再为旧自绘图层保留多余状态

## 阶段 2：建立 G6GraphAdapter 骨架

实现目标：

- 新建 G6 graph adapter
- 让 `GraphPane` 只保留容器挂载职责
- 跑通 mount / render / selection / viewport 基础链路

完成标准：

- G6 成为唯一图层运行时
- 旧自绘布局不再是必须路径

## 阶段 3：重建布局与节点视觉

实现目标：

- 基于 G6 树布局完成横向树布局
- 注册自定义节点和边
- 统一节点尺寸、状态图标、备注、IO、拖放态等视觉规则

完成标准：

- 图层已能独立完成合理布局与浏览
- 不再依赖 DOM 测量驱动整体布局

## 阶段 4：重建图交互

实现目标：

- selection
- focus node
- search gray/highlight
- variable highlight
- drag/drop intent
- subtree 相关双击与降级显示

完成标准：

- 图交互全部通过 G6 adapter 出入
- commandController 不再依赖旧自绘事件模型

## 阶段 5：回接业务语义

实现目标：

- 让 controller、stores、Inspector 与新图层重新对齐
- 清理为旧图层兜底的 controller 逻辑
- 对齐 override、history、save、reload、selection restore

完成标准：

- 文档修改命令与图层交互命令边界清晰
- 主树节点与 subtree internal node 的编辑语义都已跑通

## 阶段 6：清理与验证

实现目标：

- 移除废弃自绘代码
- 跑类型检查、构建和关键手工回归
- 修正文档与实现的最后偏差

完成标准：

- `webview/v2/spec` 与实现一致
- 旧图层代码不再承担主路径职责

## 实现期间强约束

1. 不把 G6 graph instance 当成文档真源。
2. 不把 host message 处理散落回组件和图事件。
3. 不为了赶进度保留两套长期并存的图层实现。
4. 不让 selection/search/highlight 直接修改 persisted tree。
5. 不在 contracts 未定时并行扩写实现细节。

## 最低交付顺序

推荐顺序：

1. spec
2. `contracts.ts`
3. graph adapter skeleton
4. node geometry + node visuals
5. graph interactions
6. controller / inspector / host 联调
7. 清理与验证

这样做的原因是：先把边界和契约钉死，再让 G6 图层挂上去，可以避免新实现重新长成“图层、命令、宿主互相穿透”的形状。
