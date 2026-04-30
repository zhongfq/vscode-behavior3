import type { NodeDef, VarDecl, ImportDecl } from "../../shared/misc/b3type";

export type { NodeDef, VarDecl, ImportDecl };

export type AbsoluteFsPath = string;
export type WorkdirRelativeJsonPath = string;

export interface PersistedNodeModel {
    $id: string;
    id: string;
    name: string;
    desc?: string;
    args?: Record<string, unknown>;
    input?: string[];
    output?: string[];
    children?: PersistedNodeModel[];
    debug?: boolean;
    disabled?: boolean;
    path?: WorkdirRelativeJsonPath;
    $status?: number;
}

export interface PersistedTreeModel {
    version: string;
    name: string;
    prefix: string;
    desc?: string;
    export?: boolean;
    group: string[];
    import: WorkdirRelativeJsonPath[];
    vars: VarDecl[];
    custom: Record<string, string | number | boolean | object>;
    root: PersistedNodeModel;
    $override: Record<
        string,
        Pick<PersistedNodeModel, "desc" | "input" | "output" | "args" | "debug" | "disabled">
    >;
}

export interface Settings {
    checkExpr: boolean;
    editSubtreeNodeProps: boolean;
    language: "zh" | "en";
    theme: "dark" | "light";
    nodeColors?: Record<string, string>;
}

export interface HostInitPayload {
    filePath: string;
    workdir: string;
    content: string;
    nodeDefs: NodeDef[];
    allFiles: WorkdirRelativeJsonPath[];
    settings: Settings;
}

export interface HostVarsPayload {
    usingVars: Record<string, VarDecl>;
    allFiles?: WorkdirRelativeJsonPath[];
    importDecls: ImportDecl[];
    subtreeDecls: ImportDecl[];
}

export interface NodeInstanceRef {
    instanceKey: string;
    displayId: string;
    structuralStableId: string;
    sourceStableId: string;
    sourceTreePath: WorkdirRelativeJsonPath | null;
    subtreeStack: WorkdirRelativeJsonPath[];
}

export interface EditNode {
    ref: NodeInstanceRef;
    data: PersistedNodeModel;
    prefix: string;
    disabled: boolean;
    subtreeNode: boolean;
    subtreeEditable: boolean;
    subtreeOriginal?: PersistedNodeModel;
}

export interface EditNodeDef {
    data: NodeDef | null;
    path?: WorkdirRelativeJsonPath;
}

export interface DocumentState {
    persistedTree: PersistedTreeModel | null;
    dirty: boolean;
    alertReload: boolean;
    pendingExternalContent: string | null;
    history: string[];
    historyIndex: number;
    lastSavedSnapshot: string | null;
}

export interface WorkspaceState {
    filePath: string;
    workdir: string;
    nodeDefs: NodeDef[];
    groupDefs: string[];
    allFiles: WorkdirRelativeJsonPath[];
    settings: Settings;
    usingVars: Record<string, VarDecl> | null;
    usingGroups: Record<string, boolean> | null;
    importDecls: ImportDecl[];
    subtreeDecls: ImportDecl[];
    subtreeSources: Record<WorkdirRelativeJsonPath, PersistedTreeModel | null>;
    subtreeSourceRevision: number;
    hostSubtreeRefreshSeq: number;
}

export interface SelectionState {
    selectedTree: { filePath: string } | null;
    selectedNodeKey: string | null;
    selectedNodeRef: NodeInstanceRef | null;
    selectedNodeSnapshot: EditNode | null;
    selectedNodeDef: EditNodeDef | null;
    activeVariableNames: string[];
    search: {
        open: boolean;
        mode: "content" | "id";
        query: string;
        caseSensitive: boolean;
        focusOnly: boolean;
        results: string[];
        index: number;
    };
    inspector: {
        panelWidth: number;
    };
}

export interface UpdateTreeMetaInput {
    desc?: string;
    prefix?: string;
    export?: boolean;
    group: string[];
    vars: VarDecl[];
    importRefs: WorkdirRelativeJsonPath[];
}

export interface UpdateNodeInput {
    target: NodeInstanceRef;
    data: {
        name: string;
        desc?: string;
        args?: Record<string, unknown>;
        input?: string[];
        output?: string[];
        debug?: boolean;
        disabled?: boolean;
        path?: WorkdirRelativeJsonPath;
    };
}

export interface DropIntent {
    source: NodeInstanceRef;
    target: NodeInstanceRef;
    position: "before" | "after" | "child";
}

export interface ReadFileResponse {
    content: string | null;
}

export interface SaveSubtreeResponse {
    success: boolean;
    error?: string;
}

export interface SaveSubtreeAsResponse {
    savedPath: WorkdirRelativeJsonPath | null;
    error?: string;
}

export type HostEvent =
    | { type: "init"; payload: HostInitPayload }
    | { type: "fileChanged"; content: string }
    | { type: "themeChanged"; theme: Settings["theme"] }
    | { type: "subtreeFileChanged" }
    | { type: "settingLoaded"; nodeDefs: NodeDef[]; settings?: Partial<Settings> }
    | { type: "varDeclLoaded"; payload: HostVarsPayload }
    | { type: "buildResult"; success: boolean; message: string };

export interface ResolvedNodeModel {
    ref: NodeInstanceRef;
    parentKey: string | null;
    childKeys: string[];
    depth: number;
    renderedIdLabel: string;
    name: string;
    desc?: string;
    args?: Record<string, unknown>;
    input?: string[];
    output?: string[];
    debug?: boolean;
    disabled?: boolean;
    path?: WorkdirRelativeJsonPath;
    $status?: number;
    subtreeNode: boolean;
    subtreeEditable: boolean;
    subtreeOriginal?: PersistedNodeModel;
    resolutionError?: "missing-subtree" | "invalid-subtree" | "cyclic-subtree";
}

export interface ResolvedDocumentGraph {
    rootKey: string;
    nodesByInstanceKey: Record<string, ResolvedNodeModel>;
    nodeOrder: string[];
}

export interface ResolveGraphResult {
    graph: ResolvedDocumentGraph;
    mainTreeDisplayIdsByStableId: Record<string, string>;
}

export interface GraphEdgeVM {
    key: string;
    sourceKey: string;
    targetKey: string;
}

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
    accentColor?: string;
    disabled: boolean;
    subtreeNode: boolean;
    subtreePath?: WorkdirRelativeJsonPath;
    statusBits: number;
    inputs: Array<{ label: string; variable?: string }>;
    outputs: Array<{ label: string; variable?: string }>;
    argsText?: string;
}

export interface ResolvedGraphModel {
    rootKey: string;
    nodes: GraphNodeVM[];
    edges: GraphEdgeVM[];
}

export interface GraphSelectionState {
    selectedNodeKey: string | null;
}

export interface GraphHighlightState {
    activeVariableNames: string[];
    variableHits: Record<string, Array<"input" | "output" | "args">>;
}

export interface GraphSearchState {
    query: string;
    mode: "content" | "id";
    caseSensitive: boolean;
    focusOnly: boolean;
    resultKeys: string[];
    activeResultIndex: number;
}

export interface GraphViewport {
    zoom: number;
    x: number;
    y: number;
}

export interface VariableHotspotClick {
    kind: "input" | "output";
    variableNames: string[];
}

export interface GraphEventHandlers {
    onCanvasSelected(): void;
    onNodeSelected(
        node: NodeInstanceRef,
        opts?: {
            force?: boolean;
            via?: "click" | "contextMenu" | "restore";
            clearVariableFocus?: boolean;
        }
    ): void;
    onNodeDoubleClicked(node: NodeInstanceRef): void;
    onVariableHotspotClicked(node: NodeInstanceRef, payload: VariableHotspotClick): void;
    onDropCommitted(intent: DropIntent): Promise<void>;
}

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

export interface HostAdapter {
    connect(onMessage: (msg: HostEvent) => void): () => void;
    sendReady(): void;
    sendUpdate(content: string): void;
    sendTreeSelected(tree: PersistedTreeModel): void;
    sendRequestSetting(): void;
    sendBuild(): void;
    readFile(
        path: WorkdirRelativeJsonPath,
        opts?: { openIfSubtree?: boolean }
    ): Promise<ReadFileResponse>;
    saveSubtree(path: WorkdirRelativeJsonPath, content: string): Promise<SaveSubtreeResponse>;
    saveSubtreeAs(content: string, suggestedBaseName: string): Promise<SaveSubtreeAsResponse>;
    log(level: "log" | "info" | "warn" | "error" | "debug", message: string): void;
}

export interface EditorCommand {
    initFromHost(payload: HostInitPayload): Promise<void>;
    reloadDocumentFromHost(content: string, opts?: { force?: boolean }): Promise<void>;
    applyNodeDefs(defs: NodeDef[]): Promise<void>;
    applyHostVars(payload: HostVarsPayload): Promise<void>;
    markSubtreeChanged(): Promise<void>;
    selectTree(): Promise<void>;
    selectNode(
        nodeKey: string,
        opts?: { force?: boolean; clearVariableFocus?: boolean }
    ): Promise<void>;
    focusVariable(names: string[]): Promise<void>;
    updateTreeMeta(payload: UpdateTreeMetaInput): Promise<void>;
    updateNode(payload: UpdateNodeInput): Promise<void>;
    performDrop(intent: DropIntent): Promise<void>;
    openSearch(mode: "content" | "id"): Promise<void>;
    updateSearch(query: string): Promise<void>;
    nextSearchResult(): Promise<void>;
    prevSearchResult(): Promise<void>;
    copyNode(): Promise<void>;
    pasteNode(): Promise<void>;
    insertNode(): Promise<void>;
    replaceNode(): Promise<void>;
    deleteNode(): Promise<void>;
    undo(): Promise<void>;
    redo(): Promise<void>;
    refreshGraph(opts?: { preserveSelection?: boolean }): Promise<void>;
    saveDocument(): Promise<void>;
    buildDocument(): Promise<void>;
    openSelectedSubtree(): Promise<void>;
    saveSelectedAsSubtree(): Promise<void>;
}
