# Graph Contract

## 目标

本文件定义 V2 图层与业务层之间的稳定契约。

本轮固定前提：

- 图层实现统一使用 `G6`
- 图层是 adapter，不是业务核心
- 图层不拥有 persisted tree 真源

## Core Rule

graph adapter 只做两类事：

1. 接收 controller 下发的 graph view model 与 visual state
2. 把用户在图上的操作翻译成标准 graph events 回给 controller

graph adapter 不能：

- 修改 document store
- 直接读取任意 Zustand store
- 直接调用 host adapter

## Inbound Contract

controller 调 graph adapter 只允许使用这些入口：

```ts
export interface GraphViewport {
    zoom: number;
    x: number;
    y: number;
}

export interface GraphAdapter {
    mount(container: HTMLElement, handlers: GraphEventHandlers): Promise<void>;
    unmount(): void;

    render(model: ResolvedGraphModel): Promise<void>;
    applySelection(selection: GraphSelectionState): Promise<void>;
    applyHighlights(highlights: GraphHighlightState): Promise<void>;
    applySearch(search: GraphSearchState): Promise<void>;

    focusNode(instanceKey: string): Promise<void>;
    restoreViewport(viewport: GraphViewport): Promise<void>;
    getViewport(): GraphViewport;
}
```

### Render Boundary

`render(model)` 只接收 resolved graph view model，不接收 persisted tree。

这保证：

- subtree 展开逻辑在 domain/controller
- override 规则不写进 G6
- graph 层只关心“画什么”和“用户点到了哪个实例”

## G6 Implementation Boundary

`GraphPane` 只负责：

- 提供容器 DOM
- 连接 runtime 中的 `graphAdapter`
- 放置图层外的 Search / Toolbar / 状态 UI

`G6GraphAdapter` 负责：

- 创建与销毁 G6 graph
- 注册节点、边、behaviors
- 数据映射与 visual repaint
- 视口恢复与聚焦

## Geometry Contract

### 基线

第一版几何规则固定为：

- 树方向：`LR`
- 主浏览：`pan + zoom`
- 保留父子连接线
- 节点间距与层间距由 adapter 统一控制

### 排布所有权

几何结果属于 graph adapter 内部实现，但必须满足：

- 节点坐标只依赖 `ResolvedGraphModel`、节点尺寸和排布约束
- selection/search/highlight 变化不触发排布重算
- 结构变化、节点尺寸变化、显式重置视口时才允许重新排布

### 节点尺寸

节点尺寸可以来自：

- G6 自定义节点内部测量
- graph adapter 预估尺寸
- 显式几何约束

但不得再依赖“先渲染 DOM，再由 React 外层反算整图排布”的主路径。

## Outbound Contract

graph adapter 只允许向 controller 发这些事件：

```ts
export interface GraphEventHandlers {
    onCanvasSelected(): void;
    onNodeSelected(
        node: NodeInstanceRef,
        opts?: { force?: boolean; via?: "click" | "contextMenu" | "restore" }
    ): void;
    onNodeDoubleClicked(node: NodeInstanceRef): void;
    onVariableHotspotClicked(node: NodeInstanceRef, payload: VariableHotspotClick): void;
    onDropCommitted(intent: DropIntent): Promise<void>;
}
```

graph adapter 不应把 G6 原生 event、pointer 坐标、shape id 直接上抛。

## View Model Shapes

### ResolvedGraphModel

```ts
export interface ResolvedGraphModel {
    rootKey: string;
    nodes: GraphNodeVM[];
    edges: GraphEdgeVM[];
}
```

### GraphNodeVM

```ts
export interface GraphNodeVM {
    ref: NodeInstanceRef;
    parentKey: string | null;
    childKeys: string[];
    depth: number;
    renderedIdLabel: string;
    title: string;
    subtitle?: string;
    typeLabel: string;
    icon?: string;
    nodeStyleKind: "Composite" | "Decorator" | "Condition" | "Action" | "Other" | "Error";
    disabled: boolean;
    subtreeNode: boolean;
    subtreePath?: WorkdirRelativeJsonPath;
    statusBits: number;
    inputs: Array<{ label: string; variable?: string }>;
    outputs: Array<{ label: string; variable?: string }>;
    argsText?: string;
}
```

### Node Visual Structure

节点视觉骨架固定为信息卡片，但实现交给 G6 自定义节点：

- 左侧图标 / 状态栏
- 逻辑 id 标签
- 标题区
- 备注区
- 参数区
- 输入 / 输出区
- 子树路径或错误信息区

要求：

- `input/output` 文本区域必须可点击并回传变量热点事件
- 图标优先使用 `GraphNodeVM.icon`
- 错误态、灰显态、选中态、拖放态必须可组合

### GraphEdgeVM

```ts
export interface GraphEdgeVM {
    key: string;
    sourceKey: string;
    targetKey: string;
}
```

## Selection Contract

```ts
export interface GraphSelectionState {
    selectedNodeKey: string | null;
}
```

规则：

1. `selectedNodeKey` 使用 `instanceKey`
2. graph rebuild 后 adapter 必须允许恢复选中
3. restore 选中不应重复触发 `onNodeSelected`，除非 controller 明确要求

## Search Contract

```ts
export interface GraphSearchState {
    query: string;
    mode: "content" | "id";
    caseSensitive: boolean;
    focusOnly: boolean;
    resultKeys: string[];
    activeResultIndex: number;
}
```

规则：

1. 搜索结果使用 `instanceKey`
2. `mode === "id"` 时使用 `ref.displayId`
3. `focusOnly === true` 且 query 非空时，未命中节点应灰显
4. 聚焦结果通过视口移动完成，不依赖浏览器滚动

## Highlight Contract

```ts
export interface GraphHighlightState {
    activeVariableNames: string[];
    variableHits: Record<string, Array<"input" | "output" | "args">>;
}
```

规则：

- `variableHits` key 为 `instanceKey`
- active variable 为空时应清空所有变量高亮

### Visual Precedence

同一节点可同时具有多种视觉状态，推荐优先级：

1. drop target / drag source
2. selected
3. focused search result
4. variable hit
5. gray search fade
6. disabled / error baseline

## Drag-and-Drop Contract

### Drop Intent Detection

graph adapter 负责根据 G6 节点命中关系推导：

- `before`
- `after`
- `child`

### Reject Rules

是否合法由 controller 判断，图层只负责候选意图。

### Commit Responsibility

drop 一旦提交，就通过 `onDropCommitted(intent)` 进入 controller；图层不直接改图数据。

## Double Click / Open Subtree

- 双击节点时，graph adapter 只回传 `onNodeDoubleClicked(node)`
- 是否打开 subtree、如何打开、失败如何提示，由 controller 决定

## Graph Refresh Contract

### Full Render

以下场景应触发 full render：

- 文档结构变化
- subtree source 变化
- 节点内容变化影响节点尺寸
- settings 变化影响布局或节点外观

### Visual Repaint

以下场景应优先走轻量重绘：

- selection 变化
- search 变化
- variable highlight 变化
- focus node
- viewport restore

### Selection Keep-Alive

controller 在 full render 后负责恢复 selection；adapter 负责接受恢复结果并更新图层表现。
