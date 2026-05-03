import type {
    GraphEventHandlers,
    GraphHighlightState,
    GraphSearchState,
    GraphSelectionState,
    GraphViewport,
    ResolvedGraphModel,
} from "./contracts";

export interface GraphAdapter {
    mount(container: HTMLElement, handlers: GraphEventHandlers): Promise<void>;
    unmount(): void;
    render(model: ResolvedGraphModel): Promise<void>;
    applySelection(selection: GraphSelectionState): Promise<void>;
    applyHighlights(highlights: GraphHighlightState): Promise<void>;
    applySearch(search: GraphSearchState): Promise<void>;
    focusNode(nodeKey: string): Promise<void>;
    restoreViewport(viewport: GraphViewport): Promise<void>;
    getViewport(): GraphViewport;
}
