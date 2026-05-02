import {
    CanvasEvent as G6CanvasEvent,
    Graph as G6Graph,
    GraphEvent as G6GraphEvent,
    type IEvent as G6Event,
    type IPointerEvent as G6PointerEvent,
    NodeEvent as G6NodeEvent,
    treeToGraphData,
    type GraphData as G6GraphData,
    type NodeData as G6NodeData,
} from "@antv/g6";
import type {
    DropIntent,
    GraphAdapter,
    GraphEventHandlers,
    GraphHighlightState,
    GraphNodeVM,
    GraphSearchState,
    GraphSelectionState,
    GraphViewport,
    ResolvedGraphModel,
} from "../../shared/contracts";
import {
    G6_VECTOR_NODE_H_GAP,
    G6_VECTOR_NODE_MIN_HEIGHT,
    G6_VECTOR_NODE_V_GAP,
    G6_VECTOR_NODE_WIDTH,
    G6_VECTOR_TREE_NODE_TYPE,
    getGraphThemeColor,
    getVectorTreeNodeStateStyle,
    type VectorTreeNodeDatum,
    type VectorTreeNodeState,
    measureVectorTreeNode,
    registerVectorTreeNode,
} from "./g6-vector-tree-node";

const DEFAULT_VIEWPORT: GraphViewport = { zoom: 1, x: 0, y: 0 };
const DEFAULT_PORTS = [
    { key: "right", placement: "right" as const },
    { key: "left", placement: "left" as const },
];

const createNodeOptions = () => ({
    type: G6_VECTOR_TREE_NODE_TYPE,
    style: {
        ports: DEFAULT_PORTS,
    },
    state: getVectorTreeNodeStateStyle() as any,
});

const createEdgeOptions = () => ({
    type: "cubic-horizontal",
    style: {
        lineWidth: 2,
        stroke: getGraphThemeColor("--b3-graph-edge", "#A3B1BF"),
    },
});

type DragIntentState = {
    sourceKey: string | null;
    targetKey: string | null;
    position: DropIntent["position"] | null;
};

type TreeDatum = {
    id: string;
    nodeData: G6NodeData;
    children: TreeDatum[];
};

const isDefaultViewport = (viewport: GraphViewport) =>
    viewport.zoom === DEFAULT_VIEWPORT.zoom &&
    viewport.x === DEFAULT_VIEWPORT.x &&
    viewport.y === DEFAULT_VIEWPORT.y;

const toDragState = (position: DropIntent["position"] | null): VectorTreeNodeState | null => {
    if (position === "before") {
        return "dragup";
    }
    if (position === "after") {
        return "dragdown";
    }
    if (position === "child") {
        return "dragright";
    }
    return null;
};

const getLayoutOrder = (node: G6NodeData): number => {
    const displayId = (node.data as VectorTreeNodeDatum | undefined)?.vm?.ref.displayId;
    const order = Number(displayId ?? node.id);
    return Number.isFinite(order) ? order : Number.MAX_SAFE_INTEGER;
};

const compareLayoutOrder = (nodeA: G6NodeData, nodeB: G6NodeData): number => {
    const diff = getLayoutOrder(nodeA) - getLayoutOrder(nodeB);
    if (diff !== 0) {
        return diff;
    }
    return String(nodeA.id).localeCompare(String(nodeB.id));
};

const getEventTargetId = (event: G6Event): string | null => {
    const target = (event as { target?: { id?: unknown } }).target;
    const id = target?.id;
    return typeof id === "string" || typeof id === "number" ? String(id) : null;
};

const getOriginalShapeClassName = (event: G6Event): string | null => {
    const originalTarget = (event as { originalTarget?: { className?: unknown } }).originalTarget;
    if (typeof originalTarget?.className === "string") {
        return originalTarget.className;
    }

    const target = (event as { target?: { className?: unknown } }).target;
    return typeof target?.className === "string" ? target.className : null;
};

export class G6GraphAdapter implements GraphAdapter {
    private container: HTMLElement | null = null;
    private handlers: GraphEventHandlers | null = null;
    private graph: G6Graph | null = null;
    private resizeObserver: ResizeObserver | null = null;
    private resizeRestoreFrame: number | null = null;
    private model: ResolvedGraphModel | null = null;
    private selection: GraphSelectionState = { selectedNodeKey: null };
    private highlights: GraphHighlightState = { activeVariableNames: [], variableHits: {} };
    private search: GraphSearchState = {
        query: "",
        mode: "content",
        caseSensitive: false,
        focusOnly: true,
        resultKeys: [],
        activeResultIndex: 0,
    };
    private focusedNodeKey: string | null = null;
    private viewport: GraphViewport = { ...DEFAULT_VIEWPORT };
    private dragIntent: DragIntentState = {
        sourceKey: null,
        targetKey: null,
        position: null,
    };
    private suppressTransformSync = false;

    private syncThemeOptions() {
        if (!this.graph) {
            return;
        }

        this.graph.setNode(createNodeOptions() as any);
        this.graph.setEdge(createEdgeOptions() as any);
    }

    private readonly handleGraphTransform = () => {
        if (this.suppressTransformSync || !this.graph) {
            return;
        }
        this.syncViewportFromGraph();
    };

    private isGraphRendered() {
        const graph = this.graph as unknown as
            | { rendered?: boolean; destroyed?: boolean }
            | null;
        return Boolean(graph?.rendered && !graph?.destroyed);
    }

    private readViewportFromGraph(): GraphViewport | null {
        const graph = this.graph as unknown as
            | {
                  rendered?: boolean;
                  destroyed?: boolean;
                  context?: { viewport?: unknown };
                  getPosition?: () => [number, number];
                  getZoom?: () => number;
              }
            | null;

        if (
            !graph?.rendered ||
            graph.destroyed ||
            !graph.context?.viewport ||
            !graph.getPosition ||
            !graph.getZoom
        ) {
            return null;
        }

        try {
            const [x, y] = graph.getPosition();
            const zoom = graph.getZoom();
            if (![x, y, zoom].every((value) => Number.isFinite(value))) {
                return null;
            }
            return { zoom, x, y };
        } catch {
            return null;
        }
    }

    private captureViewportFromGraph(): GraphViewport | null {
        return this.readViewportFromGraph();
    }

    private getNodeVM(nodeKey: string): GraphNodeVM | null {
        return this.model?.nodes.find((node) => node.ref.instanceKey === nodeKey) ?? null;
    }

    private getNodeDatum(node: GraphNodeVM): VectorTreeNodeDatum {
        const size = measureVectorTreeNode(node);
        return {
            vm: node,
            width: size.width,
            height: size.height,
        };
    }

    private getNodeStates(node: GraphNodeVM): VectorTreeNodeState[] {
        const states: VectorTreeNodeState[] = [];
        const nodeKey = node.ref.instanceKey;
        const variableHits = this.highlights.variableHits[nodeKey] ?? [];
        const shouldGrayForVariableHighlight =
            this.highlights.activeVariableNames.length > 0 && variableHits.length === 0;
        const shouldGrayForSearch =
            this.search.focusOnly &&
            this.search.query.length > 0 &&
            !this.search.resultKeys.includes(nodeKey);

        if (this.selection.selectedNodeKey === nodeKey) {
            states.push("selected");
        }
        if (this.focusedNodeKey === nodeKey) {
            states.push("focused");
        }
        if (shouldGrayForVariableHighlight || shouldGrayForSearch) {
            states.push("highlightgray");
        }

        if (variableHits.includes("args")) {
            states.push("highlightargs");
        }
        if (variableHits.includes("input")) {
            states.push("highlightinput");
        }
        if (variableHits.includes("output")) {
            states.push("highlightoutput");
        }

        if (this.dragIntent.sourceKey === nodeKey) {
            states.push("dragsrc");
        }
        if (this.dragIntent.targetKey === nodeKey) {
            const dragState = toDragState(this.dragIntent.position);
            if (dragState) {
                states.push(dragState);
            }
        }

        return states;
    }

    private refreshNodeStates() {
        if (!this.graph || !this.model || !this.isGraphRendered()) {
            return;
        }

        for (const node of this.model.nodes) {
            if (!this.graph.hasNode(node.ref.instanceKey)) {
                continue;
            }
            this.graph.setElementState(node.ref.instanceKey, this.getNodeStates(node));
        }
    }

    private buildTreeDatum(nodeKey: string): TreeDatum | null {
        const node = this.getNodeVM(nodeKey);
        if (!node) {
            return null;
        }

        const datum = this.getNodeDatum(node);
        return {
            id: nodeKey,
            nodeData: {
                id: node.ref.instanceKey,
                type: G6_VECTOR_TREE_NODE_TYPE,
                data: datum as unknown as Record<string, unknown>,
                style: {
                    size: [datum.width, datum.height],
                    cursor: "pointer",
                    draggable: !node.subtreeNode,
                    ports: DEFAULT_PORTS,
                },
                children: node.childKeys,
                depth: node.depth,
            },
            children: node.childKeys
                .map((childKey) => this.buildTreeDatum(childKey))
                .filter((child): child is TreeDatum => Boolean(child)),
        };
    }

    private buildGraphData(model: ResolvedGraphModel): G6GraphData | null {
        const root = this.buildTreeDatum(model.rootKey);
        if (!root) {
            return null;
        }

        return treeToGraphData(root, {
            getNodeData: (entry) => entry.nodeData,
            getEdgeData: (source, target) => ({
                id: `${source.id}->${target.id}`,
                source: source.id,
                sourcePort: "right",
                target: target.id,
                targetPort: "left",
            }),
            getChildren: (entry) => entry.children ?? [],
        });
    }

    private async rerenderWithStableViewport(viewport: GraphViewport | null): Promise<void> {
        if (!this.graph) {
            return;
        }

        if (!viewport) {
            await this.graph.render();
            return;
        }

        this.suppressTransformSync = true;
        try {
            if (!this.isGraphRendered()) {
                await this.graph.render();
            }
            await this.graph.zoomTo(1, false);
            await this.graph.translateTo([0, 0], false);
            await this.graph.render();
            await this.applyViewportSnapshot(viewport);
        } finally {
            this.suppressTransformSync = false;
        }
    }

    private async renderGraphData(): Promise<void> {
        if (!this.graph) {
            return;
        }

        this.cancelPendingResizeRestore();

        if (!this.model || this.model.nodes.length === 0) {
            await this.graph.clear();
            return;
        }

        const data = this.buildGraphData(this.model);
        if (!data) {
            await this.graph.clear();
            return;
        }

        const viewport = this.captureViewportFromGraph();
        await this.graph.clear();
        this.graph.setData(data);
        await this.rerenderWithStableViewport(viewport);
        if (isDefaultViewport(this.viewport)) {
            this.syncViewportFromGraph();
        }
        this.refreshNodeStates();
    }

    private async applyViewportSnapshot(viewport: GraphViewport): Promise<void> {
        if (!this.graph || !this.isGraphRendered()) {
            this.viewport = { ...viewport };
            return;
        }

        await this.graph.zoomTo(viewport.zoom, false);
        await this.graph.translateTo([viewport.x, viewport.y], false);
        this.viewport = { ...viewport };
    }

    private async applyViewport(viewport: GraphViewport): Promise<void> {
        if (!this.graph) {
            return;
        }

        if (!this.isGraphRendered()) {
            this.viewport = { ...viewport };
            return;
        }

        this.suppressTransformSync = true;
        try {
            await this.applyViewportSnapshot(viewport);
        } finally {
            this.suppressTransformSync = false;
        }
    }

    private scheduleResizeViewportRestore(viewport: GraphViewport) {
        this.cancelPendingResizeRestore();
        this.resizeRestoreFrame = window.requestAnimationFrame(() => {
            this.resizeRestoreFrame = null;
            void this.applyViewport(viewport);
        });
    }

    private cancelPendingResizeRestore() {
        if (this.resizeRestoreFrame == null) {
            return;
        }
        window.cancelAnimationFrame(this.resizeRestoreFrame);
        this.resizeRestoreFrame = null;
    }

    private syncViewportFromGraph() {
        const viewport = this.readViewportFromGraph();
        if (viewport) {
            this.viewport = viewport;
        }
    }

    private updateDragIntent(targetKey: string | null, position: DropIntent["position"] | null) {
        if (this.dragIntent.targetKey === targetKey && this.dragIntent.position === position) {
            return;
        }

        this.dragIntent = {
            ...this.dragIntent,
            targetKey,
            position,
        };
        this.refreshNodeStates();
    }

    private clearDragIntent() {
        const hadDragIntent =
            this.dragIntent.sourceKey !== null ||
            this.dragIntent.targetKey !== null ||
            this.dragIntent.position !== null;

        this.dragIntent = {
            sourceKey: null,
            targetKey: null,
            position: null,
        };

        if (hadDragIntent) {
            this.refreshNodeStates();
        }
    }

    private readonly handleCanvasClick = () => {
        this.handlers?.onCanvasSelected();
    };

    private readonly handleNodeContextMenu = (event: G6PointerEvent<any>) => {
        const nodeKey = getEventTargetId(event);
        if (!nodeKey) {
            return;
        }

        const node = this.getNodeVM(nodeKey);
        if (node) {
            this.handlers?.onNodeSelected(node.ref, { via: "contextMenu" });
        }
    };

    private readonly handleNodeClick = (event: G6PointerEvent<any>) => {
        const nodeKey = getEventTargetId(event);
        if (!nodeKey) {
            return;
        }

        const node = this.getNodeVM(nodeKey);
        if (!node) {
            return;
        }

        const shapeClassName = getOriginalShapeClassName(event);
        let keepVariableFocus = false;
        if (shapeClassName === "input-text") {
            const variableNames = node.inputs
                .map((entry) => entry.variable)
                .filter((value): value is string => Boolean(value));
            if (variableNames.length > 0) {
                keepVariableFocus = true;
                this.handlers?.onVariableHotspotClicked(node.ref, {
                    kind: "input",
                    variableNames,
                });
            }
        } else if (shapeClassName === "output-text") {
            const variableNames = node.outputs
                .map((entry) => entry.variable)
                .filter((value): value is string => Boolean(value));
            if (variableNames.length > 0) {
                keepVariableFocus = true;
                this.handlers?.onVariableHotspotClicked(node.ref, {
                    kind: "output",
                    variableNames,
                });
            }
        }

        this.handlers?.onNodeSelected(node.ref, {
            via: "click",
            clearVariableFocus: !keepVariableFocus,
        });
    };

    private readonly handleNodeDoubleClick = (event: G6PointerEvent<any>) => {
        const nodeKey = getEventTargetId(event);
        if (!nodeKey) {
            return;
        }

        const node = this.getNodeVM(nodeKey);
        if (node) {
            this.handlers?.onNodeDoubleClicked(node.ref);
        }
    };

    private readonly handleNodeDragStart = (event: G6PointerEvent<any>) => {
        const nodeKey = getEventTargetId(event);
        if (!nodeKey) {
            return;
        }

        const node = this.getNodeVM(nodeKey);
        if (!node || node.subtreeNode) {
            return;
        }

        this.dragIntent = {
            sourceKey: nodeKey,
            targetKey: null,
            position: null,
        };
        this.refreshNodeStates();
    };

    private readonly handleNodeDragEnd = () => {
        this.clearDragIntent();
    };

    private readonly handleNodeDragEnter = (event: G6PointerEvent<any>) => {
        if (!this.dragIntent.sourceKey) {
            return;
        }

        const nodeKey = getEventTargetId(event);
        if (!nodeKey || nodeKey === this.dragIntent.sourceKey) {
            return;
        }

        this.updateDragIntent(nodeKey, this.dragIntent.position);
    };

    private readonly handleNodeDragLeave = (event: G6PointerEvent<any>) => {
        const nodeKey = getEventTargetId(event);
        if (!nodeKey || nodeKey === this.dragIntent.sourceKey) {
            return;
        }

        if (this.dragIntent.targetKey === nodeKey) {
            this.updateDragIntent(null, null);
        }
    };

    private readonly handleNodeDrag = (event: G6PointerEvent<any>) => {
        if (!this.graph || !this.dragIntent.sourceKey || !this.dragIntent.targetKey) {
            return;
        }

        const targetKey = this.dragIntent.targetKey;
        const targetDatum = this.graph.getNodeData(targetKey);
        const data = targetDatum?.data as VectorTreeNodeDatum | undefined;
        if (!data) {
            return;
        }

        const position = this.graph.getElementPosition(targetKey);
        const canvas = (event as { canvas?: { x: number; y: number } }).canvas;
        if (!position || !canvas) {
            return;
        }

        const x = canvas.x - position[0];
        const y = canvas.y - position[1];
        const nextPosition: DropIntent["position"] =
            x > data.width / 2 ? "child" : y > data.height / 2 ? "after" : "before";

        this.updateDragIntent(targetKey, nextPosition);
    };

    private readonly handleNodeDrop = async (event: G6PointerEvent<any>) => {
        if (!this.dragIntent.sourceKey || !this.dragIntent.position) {
            return;
        }

        const targetKey = this.dragIntent.targetKey ?? getEventTargetId(event);
        const sourceKey = this.dragIntent.sourceKey;
        const position = this.dragIntent.position;

        this.clearDragIntent();

        if (!targetKey || sourceKey === targetKey) {
            return;
        }

        const source = this.getNodeVM(sourceKey);
        const target = this.getNodeVM(targetKey);
        if (!source || !target) {
            return;
        }

        await this.handlers?.onDropCommitted({
            source: source.ref,
            target: target.ref,
            position,
        });
    };

    async mount(container: HTMLElement, handlers: GraphEventHandlers): Promise<void> {
        this.container = container;
        this.handlers = handlers;
        registerVectorTreeNode();

        const graph = new G6Graph({
            container,
            animation: false,
            zoomRange: [0.25, 2],
            behaviors: ["drag-canvas", "zoom-canvas"],
            node: createNodeOptions(),
            edge: createEdgeOptions(),
            layout: {
                type: "compact-box",
                direction: "LR",
                sortBy: compareLayoutOrder,
                getHeight: (datum: G6NodeData) =>
                    Number(
                        (datum.data as { height?: number } | undefined)?.height ??
                            G6_VECTOR_NODE_MIN_HEIGHT
                    ),
                getWidth: (datum: G6NodeData) =>
                    Number(
                        (datum.data as { width?: number } | undefined)?.width ??
                            G6_VECTOR_NODE_WIDTH
                    ),
                getVGap: () => G6_VECTOR_NODE_V_GAP,
                getHGap: () => G6_VECTOR_NODE_H_GAP,
            },
        });

        graph.on(G6CanvasEvent.CLICK, this.handleCanvasClick);
        graph.on(G6NodeEvent.CONTEXT_MENU, this.handleNodeContextMenu);
        graph.on(G6NodeEvent.CLICK, this.handleNodeClick);
        graph.on(G6NodeEvent.DBLCLICK, this.handleNodeDoubleClick);
        graph.on(G6NodeEvent.DRAG_START, this.handleNodeDragStart);
        graph.on(G6NodeEvent.DRAG_END, this.handleNodeDragEnd);
        graph.on(G6NodeEvent.DRAG_ENTER, this.handleNodeDragEnter);
        graph.on(G6NodeEvent.DRAG_LEAVE, this.handleNodeDragLeave);
        graph.on(G6NodeEvent.DRAG, this.handleNodeDrag);
        graph.on(G6NodeEvent.DROP, this.handleNodeDrop);
        graph.on(G6GraphEvent.AFTER_TRANSFORM, this.handleGraphTransform);

        this.graph = graph;

        this.resizeObserver = new ResizeObserver((entries) => {
            const entry = entries[0];
            if (!entry || !this.graph) {
                return;
            }

            const viewport = this.captureViewportFromGraph() ?? this.viewport;
            const width = Math.max(1, Math.round(entry.contentRect.width));
            const height = Math.max(1, Math.round(entry.contentRect.height));
            this.graph.resize(width, height);
            this.viewport = { ...viewport };
            this.scheduleResizeViewportRestore(viewport);
        });
        this.resizeObserver.observe(container);

        await this.renderGraphData();
    }

    unmount(): void {
        this.cancelPendingResizeRestore();
        this.resizeObserver?.disconnect();
        this.resizeObserver = null;
        this.graph?.destroy();
        this.graph = null;
        this.container = null;
        this.handlers = null;
        this.clearDragIntent();
    }

    async render(model: ResolvedGraphModel): Promise<void> {
        this.model = model;
        this.clearDragIntent();
        this.syncThemeOptions();
        await this.renderGraphData();
    }

    async applySelection(selection: GraphSelectionState): Promise<void> {
        this.selection = selection;
        this.refreshNodeStates();
    }

    async applyHighlights(highlights: GraphHighlightState): Promise<void> {
        this.highlights = highlights;
        this.refreshNodeStates();
    }

    async applySearch(search: GraphSearchState): Promise<void> {
        this.search = search;
        if (!search.query || search.resultKeys.length === 0) {
            this.focusedNodeKey = null;
        }
        this.refreshNodeStates();
    }

    async focusNode(nodeKey: string): Promise<void> {
        this.focusedNodeKey = nodeKey;
        this.refreshNodeStates();
        if (this.graph?.hasNode(nodeKey) && this.isGraphRendered()) {
            await this.graph.focusElement(nodeKey, false);
            this.syncViewportFromGraph();
        }
    }

    async restoreViewport(viewport: GraphViewport): Promise<void> {
        this.viewport = { ...viewport };
        await this.applyViewport(viewport);
    }

    getViewport(): GraphViewport {
        return { ...this.viewport };
    }
}

export const createG6GraphAdapter = () => new G6GraphAdapter();
