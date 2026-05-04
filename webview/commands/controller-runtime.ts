import type { StoreApi } from "zustand/vanilla";
import i18n from "../shared/misc/i18n";
import { stringifyJson } from "../shared/misc/stringify";
import { generateUuid } from "../shared/stable-id";
import type { AppHooksStore } from "../shared/misc/hooks";
import type {
    DocumentState,
    EditNode,
    EditNodeDef,
    GraphHighlightState,
    GraphSearchState,
    HostAdapter,
    NodeCheckDiagnostic,
    NodeCheckValidationNode,
    NodeDef,
    NodeInstanceRef,
    PersistedNodeModel,
    PersistedTreeModel,
    ResolvedDocumentGraph,
    ResolvedNodeModel,
    SelectionState,
    WorkspaceState,
} from "../shared/contracts";
import type { GraphAdapter } from "../shared/graph-contracts";
import { parseWorkdirRelativeJsonPath } from "../shared/protocol";
import {
    cloneJsonValue,
    clonePersistedNode,
    findPersistedNodeByStableId,
    parsePersistedTreeContent,
    serializePersistedTree,
    walkPersistedNodes,
} from "../shared/tree";
import { loadSubtreeSourceCache } from "../shared/subtree-source-cache";
import {
    buildResolvedGraphModel,
    buildSearchState,
    computeVariableHighlights,
} from "../domain/graph-selectors";
import { resolveDocumentGraph } from "../domain/resolve-graph";
import { patchSelectionSearchState } from "../stores/selection-store";

/**
 * Shared controller runtime for the webview editor.
 * It keeps the resolved graph snapshot, coordinates store updates, and exposes
 * the few mutation/rebuild helpers that command modules are allowed to call.
 */
export interface ControllerDeps {
    documentStore: StoreApi<DocumentState>;
    workspaceStore: StoreApi<WorkspaceState>;
    selectionStore: StoreApi<SelectionState>;
    hostAdapter: HostAdapter;
    graphAdapter: GraphAdapter;
    appHooks: AppHooksStore;
}

export type TreeSelectedMode = "debounced" | "immediate" | "skip";
export type SelectionPatch = Partial<
    Pick<
        SelectionState,
        | "selectedTree"
        | "selectedNodeKey"
        | "selectedNodeRef"
        | "selectedNodeSnapshot"
        | "selectedNodeDef"
        | "activeVariableNames"
    >
>;

export interface ControllerApplyTreeOptions {
    savedSnapshot?: string | null;
    syncSubtreeSources?: boolean;
    rebuildGraph?: boolean;
    preserveSelection?: boolean;
    applyVisualState?: boolean;
}

export interface ControllerCommitTreeOptions extends ControllerApplyTreeOptions {
    prepareSelection?: () => void;
    pushHistory?: boolean;
    treeSelectedMode?: TreeSelectedMode;
}

export interface ControllerRuntime {
    readonly deps: ControllerDeps;
    getResolvedGraph(): ResolvedDocumentGraph | null;
    notifyError(text: string): void;
    notifySuccess(text: string): void;
    scheduleTreeSelected(immediate?: boolean): void;
    getNodeDef(name: string): NodeDef | null;
    selectTreeState(opts?: { clearVariableFocus?: boolean }): boolean;
    selectResolvedNodeState(instanceKey: string, opts?: { clearVariableFocus?: boolean }): boolean;
    selectPendingNodeState(stableId: string): void;
    clearActiveVariableFocus(): boolean;
    getSelectedResolvedNode(): ResolvedNodeModel | null;
    isSubtreeStructureLocked(node: ResolvedNodeModel | null): boolean;
    readClipboardNode(): Promise<PersistedNodeModel | null>;
    assignFreshStableIds(node: PersistedNodeModel): void;
    findPersistedNodeLocationByStableId(
        root: PersistedNodeModel,
        stableId: string
    ): { node: PersistedNodeModel; parent: PersistedNodeModel | null } | null;
    isDescendantInstance(ancestorKey: string, targetKey: string): boolean;
    buildPersistedNodeFromResolved(
        instanceKey: string,
        opts?: { clearPathOnRoot?: boolean }
    ): PersistedNodeModel | null;
    overwritePersistedNode(target: PersistedNodeModel, source: PersistedNodeModel): void;
    applyHistoryIndex(nextIndex: number): Promise<void>;
    applyVisualState(): Promise<void>;
    rebuildGraph(opts?: { preserveSelection?: boolean }): Promise<void>;
    syncReachableSubtreeSources(): Promise<void>;
    getSerializedCurrentTree(): string | null;
    matchesCurrentDocumentSnapshot(content: string): boolean;
    resetDocumentHistory(): void;
    applyDocumentTree(tree: PersistedTreeModel, opts?: ControllerApplyTreeOptions): Promise<void>;
    commitTreeMutation(tree: PersistedTreeModel, opts?: ControllerCommitTreeOptions): Promise<void>;
}

export const cloneVars = <T extends { name: string; desc: string }>(entries: T[]): T[] =>
    entries.map((entry) => ({ ...entry }));

export const isJsonEqual = (left: unknown, right: unknown): boolean =>
    JSON.stringify(left) === JSON.stringify(right);

const computeDirty = (
    tree: PersistedTreeModel | null,
    lastSavedSnapshot: string | null
): boolean => {
    if (!tree || lastSavedSnapshot == null) {
        return false;
    }
    return serializePersistedTree(tree) !== lastSavedSnapshot;
};

export const buildUsingGroups = (groupNames: string[]): Record<string, boolean> | null => {
    if (groupNames.length === 0) {
        return null;
    }
    const record: Record<string, boolean> = {};
    for (const group of groupNames) {
        record[group] = true;
    }
    return record;
};

export const createControllerRuntime = (deps: ControllerDeps): ControllerRuntime => {
    let resolvedGraph: ResolvedDocumentGraph | null = null;
    let treeSelectedTimer: number | null = null;
    let nodeCheckRequestSeq = 0;

    const notifyError = (text: string) => {
        deps.appHooks.getMessage().error(text);
    };

    const notifySuccess = (text: string) => {
        deps.appHooks.getMessage().success(text);
    };

    /**
     * Keep host `treeSelected` notifications debounced by default so variable
     * refresh in the extension host does not run on every small mutation.
     */
    const scheduleTreeSelected = (immediate = false) => {
        const tree = deps.documentStore.getState().persistedTree;
        if (!tree) {
            return;
        }
        if (treeSelectedTimer != null) {
            window.clearTimeout(treeSelectedTimer);
            treeSelectedTimer = null;
        }
        if (immediate) {
            deps.hostAdapter.sendTreeSelected(tree);
            return;
        }
        treeSelectedTimer = window.setTimeout(() => {
            treeSelectedTimer = null;
            const nextTree = deps.documentStore.getState().persistedTree;
            if (nextTree) {
                deps.hostAdapter.sendTreeSelected(nextTree);
            }
        }, 300);
    };

    const getNodeDef = (name: string): NodeDef | null => {
        return deps.workspaceStore.getState().nodeDefs.find((def) => def.name === name) ?? null;
    };

    const buildPendingSelectionRef = (stableId: string): NodeInstanceRef => ({
        instanceKey: stableId,
        displayId: "",
        structuralStableId: stableId,
        sourceStableId: stableId,
        sourceTreePath: null,
        subtreeStack: [],
    });

    const updateSelectionState = (buildPatch: (state: SelectionState) => SelectionPatch) => {
        deps.selectionStore.setState((state) => ({
            ...state,
            ...buildPatch(state),
        }));
    };

    const buildTreeSelectionPatch = (): SelectionPatch => {
        const filePath = deps.workspaceStore.getState().filePath;
        return {
            selectedTree: filePath ? { filePath } : null,
            selectedNodeKey: null,
            selectedNodeRef: null,
            selectedNodeSnapshot: null,
            selectedNodeDef: null,
        };
    };

    const buildSelectedNodeSnapshot = (instanceKey: string): EditNode | null => {
        const tree = deps.documentStore.getState().persistedTree;
        if (!tree || !resolvedGraph) {
            return null;
        }
        const node = resolvedGraph.nodesByInstanceKey[instanceKey];
        if (!node) {
            return null;
        }
        return {
            ref: node.ref,
            data: {
                uuid: node.ref.sourceStableId,
                id: node.ref.displayId,
                name: node.name,
                desc: node.desc,
                args: node.args,
                input: node.input,
                output: node.output,
                debug: node.debug,
                disabled: node.disabled,
                path: node.path,
            },
            prefix: tree.prefix,
            activeChildCount: node.childKeys.reduce((count, childKey) => {
                const child = resolvedGraph?.nodesByInstanceKey[childKey];
                return count + (child && !child.disabled ? 1 : 0);
            }, 0),
            disabled: !node.subtreeEditable,
            subtreeNode: node.subtreeNode,
            subtreeEditable: node.subtreeEditable,
            subtreeOriginal: node.subtreeOriginal,
            resolutionError: node.resolutionError,
        };
    };

    const buildSelectedNodeDef = (instanceKey: string): EditNodeDef | null => {
        if (!resolvedGraph) {
            return null;
        }
        const node = resolvedGraph.nodesByInstanceKey[instanceKey];
        if (!node) {
            return null;
        }
        return {
            data: getNodeDef(node.name),
            path: node.path,
        };
    };

    const buildResolvedNodeSelectionPatch = (instanceKey: string): SelectionPatch | null => {
        if (!resolvedGraph) {
            return null;
        }

        const node = resolvedGraph.nodesByInstanceKey[instanceKey];
        if (!node) {
            return null;
        }

        return {
            selectedTree: null,
            selectedNodeKey: node.ref.instanceKey,
            selectedNodeRef: node.ref,
            selectedNodeSnapshot: buildSelectedNodeSnapshot(node.ref.instanceKey),
            selectedNodeDef: buildSelectedNodeDef(node.ref.instanceKey),
        };
    };

    const buildPendingNodeSelectionPatch = (stableId: string): SelectionPatch => ({
        selectedTree: null,
        selectedNodeKey: stableId,
        selectedNodeRef: buildPendingSelectionRef(stableId),
        selectedNodeSnapshot: null,
        selectedNodeDef: null,
    });

    const clearActiveVariableFocus = (): boolean => {
        if (deps.selectionStore.getState().activeVariableNames.length === 0) {
            return false;
        }

        updateSelectionState(() => ({
            activeVariableNames: [],
        }));
        return true;
    };

    const selectTreeState = (opts?: { clearVariableFocus?: boolean }): boolean => {
        const shouldClearVariableFocus =
            Boolean(opts?.clearVariableFocus) &&
            deps.selectionStore.getState().activeVariableNames.length > 0;
        updateSelectionState((state) => ({
            ...buildTreeSelectionPatch(),
            activeVariableNames: shouldClearVariableFocus ? [] : state.activeVariableNames,
        }));
        return shouldClearVariableFocus;
    };

    const selectResolvedNodeState = (
        instanceKey: string,
        opts?: { clearVariableFocus?: boolean }
    ): boolean => {
        const patch = buildResolvedNodeSelectionPatch(instanceKey);
        if (!patch) {
            return false;
        }

        const shouldClearVariableFocus =
            Boolean(opts?.clearVariableFocus) &&
            deps.selectionStore.getState().activeVariableNames.length > 0;
        updateSelectionState((state) => ({
            ...patch,
            activeVariableNames: shouldClearVariableFocus ? [] : state.activeVariableNames,
        }));
        return shouldClearVariableFocus;
    };

    const selectPendingNodeState = (stableId: string) => {
        updateSelectionState(() => buildPendingNodeSelectionPatch(stableId));
    };

    const getSelectedResolvedNode = (): ResolvedNodeModel | null => {
        const ref = deps.selectionStore.getState().selectedNodeRef;
        if (!ref || !resolvedGraph) {
            return null;
        }
        return resolvedGraph.nodesByInstanceKey[ref.instanceKey] ?? null;
    };

    const isSubtreeStructureLocked = (node: ResolvedNodeModel | null) =>
        Boolean(node?.subtreeNode || node?.path);

    /**
     * Accept only the persisted node shape we know how to paste.
     * Subtree links own their contents via `path`, so pasted roots must drop
     * inline `children` when a subtree reference is present.
     */
    const normalizeClipboardNode = (value: unknown): PersistedNodeModel => {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
            throw new Error("invalid clipboard node");
        }

        const candidate = value as Partial<PersistedNodeModel> & { $id?: unknown };
        if (typeof candidate.name !== "string" || !candidate.name.trim()) {
            throw new Error("invalid clipboard node");
        }

        const normalized: PersistedNodeModel = {
            uuid:
                typeof candidate.uuid === "string" && candidate.uuid
                    ? candidate.uuid
                    : typeof candidate.$id === "string" && candidate.$id
                      ? candidate.$id
                      : generateUuid(),
            id: typeof candidate.id === "string" ? candidate.id : "",
            name: candidate.name,
            desc: typeof candidate.desc === "string" ? candidate.desc : undefined,
            args:
                candidate.args &&
                typeof candidate.args === "object" &&
                !Array.isArray(candidate.args)
                    ? cloneJsonValue(candidate.args)
                    : undefined,
            input: Array.isArray(candidate.input)
                ? candidate.input.map((entry) => String(entry ?? ""))
                : undefined,
            output: Array.isArray(candidate.output)
                ? candidate.output.map((entry) => String(entry ?? ""))
                : undefined,
            children: Array.isArray(candidate.children)
                ? candidate.children.map((child) => normalizeClipboardNode(child))
                : undefined,
            debug: typeof candidate.debug === "boolean" ? candidate.debug : undefined,
            disabled: typeof candidate.disabled === "boolean" ? candidate.disabled : undefined,
            path:
                typeof candidate.path === "string" && candidate.path.trim()
                    ? (parseWorkdirRelativeJsonPath(candidate.path) ?? undefined)
                    : undefined,
        };

        if (normalized.path) {
            normalized.children = undefined;
        }

        return normalized;
    };

    const readClipboardNode = async (): Promise<PersistedNodeModel | null> => {
        try {
            const text = await navigator.clipboard.readText();
            if (!text.trim()) {
                return null;
            }
            return normalizeClipboardNode(JSON.parse(text) as unknown);
        } catch (error) {
            deps.hostAdapter.log("warn", `[v2] clipboard read failed: ${String(error)}`);
            notifyError(i18n.t("node.pasteDataError"));
            return null;
        }
    };

    const assignFreshStableIds = (node: PersistedNodeModel) => {
        node.uuid = generateUuid();
        for (const child of node.children ?? []) {
            assignFreshStableIds(child);
        }
    };

    const findPersistedNodeLocationByStableId = (
        root: PersistedNodeModel,
        stableId: string
    ): { node: PersistedNodeModel; parent: PersistedNodeModel | null } | null => {
        let found: { node: PersistedNodeModel; parent: PersistedNodeModel | null } | null = null;

        walkPersistedNodes(root, (node, parent) => {
            if (!found && node.uuid === stableId) {
                found = { node, parent };
            }
        });

        return found;
    };

    const isDescendantInstance = (ancestorKey: string, targetKey: string): boolean => {
        if (!resolvedGraph) {
            return false;
        }

        let current = resolvedGraph.nodesByInstanceKey[targetKey];
        while (current?.parentKey) {
            if (current.parentKey === ancestorKey) {
                return true;
            }
            current = resolvedGraph.nodesByInstanceKey[current.parentKey];
        }

        return false;
    };

    const buildPersistedNodeFromResolved = (
        instanceKey: string,
        opts?: { clearPathOnRoot?: boolean }
    ): PersistedNodeModel | null => {
        /**
         * Convert the resolved/materialized graph back into persisted node data.
         * The root keeps its structural id so replace-in-place mutations still
         * target the current node, while descendants keep source ids so subtree
         * edits preserve their original ownership.
         */
        const buildNode = (currentKey: string, isRoot: boolean): PersistedNodeModel | null => {
            if (!resolvedGraph) {
                return null;
            }
            const resolvedNode = resolvedGraph.nodesByInstanceKey[currentKey];
            if (!resolvedNode) {
                return null;
            }

            const node: PersistedNodeModel = {
                uuid: isRoot
                    ? resolvedNode.ref.structuralStableId
                    : resolvedNode.ref.sourceStableId,
                id: resolvedNode.ref.displayId,
                name: resolvedNode.name,
                desc: resolvedNode.desc,
                args: resolvedNode.args ? cloneJsonValue(resolvedNode.args) : undefined,
                input: resolvedNode.input ? [...resolvedNode.input] : undefined,
                output: resolvedNode.output ? [...resolvedNode.output] : undefined,
                debug: resolvedNode.debug,
                disabled: resolvedNode.disabled,
                path: isRoot && opts?.clearPathOnRoot ? undefined : resolvedNode.path,
                children: undefined,
            };

            if (resolvedNode.childKeys.length > 0) {
                node.children = resolvedNode.childKeys
                    .map((childKey) => buildNode(childKey, false))
                    .filter((child): child is PersistedNodeModel => Boolean(child));
            }

            return node;
        };

        return buildNode(instanceKey, true);
    };

    const overwritePersistedNode = (target: PersistedNodeModel, source: PersistedNodeModel) => {
        for (const key of Object.keys(target) as Array<keyof PersistedNodeModel>) {
            delete target[key];
        }
        Object.assign(target, source);
    };

    const pushHistorySnapshot = (snapshot: string) => {
        deps.documentStore.setState((state) => {
            if (state.history[state.historyIndex] === snapshot) {
                return {
                    ...state,
                    dirty: computeDirty(state.persistedTree, state.lastSavedSnapshot),
                };
            }
            const nextHistory = [...state.history.slice(0, state.historyIndex + 1), snapshot];
            return {
                ...state,
                history: nextHistory,
                historyIndex: nextHistory.length - 1,
                dirty: computeDirty(state.persistedTree, state.lastSavedSnapshot),
            };
        });
        deps.hostAdapter.sendUpdate(snapshot);
    };

    const getSerializedCurrentTree = (): string | null => {
        const tree = deps.documentStore.getState().persistedTree;
        return tree ? serializePersistedTree(tree) : null;
    };

    const cloneNodeArgs = (args: Record<string, unknown> | undefined) =>
        args ? (cloneJsonValue(args) as Record<string, unknown>) : undefined;

    const collectNodeCheckValidationNodes = (
        graph: ResolvedDocumentGraph,
        nodeDefs: NodeDef[]
    ): NodeCheckValidationNode[] => {
        const defsByName = new Map(nodeDefs.map((def) => [def.name, def] as const));
        const nodes: NodeCheckValidationNode[] = [];
        for (const key of graph.nodeOrder) {
            const node = graph.nodesByInstanceKey[key];
            const def = defsByName.get(node.name);
            if (!def?.args?.some((arg) => arg.checker?.trim())) {
                continue;
            }
            nodes.push({
                instanceKey: node.ref.instanceKey,
                treePath: node.ref.sourceTreePath,
                node: {
                    uuid: node.ref.sourceStableId,
                    id: node.renderedIdLabel,
                    name: node.name,
                    desc: node.desc,
                    args: cloneNodeArgs(node.args),
                    input: node.input ? [...node.input] : undefined,
                    output: node.output ? [...node.output] : undefined,
                    debug: node.debug,
                    disabled: node.disabled,
                    path: node.path,
                    children: [],
                },
            });
        }
        return nodes;
    };

    const requestNodeCheckDiagnostics = async (
        graph: ResolvedDocumentGraph,
        workspace: WorkspaceState
    ): Promise<Record<string, NodeCheckDiagnostic[]>> => {
        const content = getSerializedCurrentTree();
        const treePath = workspace.filePath;
        const nodes = collectNodeCheckValidationNodes(graph, workspace.nodeDefs);
        const requestSeq = ++nodeCheckRequestSeq;
        if (!content || !treePath || nodes.length === 0) {
            deps.workspaceStore.setState((state) => ({
                ...state,
                nodeCheckDiagnostics: {},
            }));
            return {};
        }

        const response = await deps.hostAdapter.validateNodeChecks(content, treePath, nodes);
        if (requestSeq !== nodeCheckRequestSeq) {
            return deps.workspaceStore.getState().nodeCheckDiagnostics;
        }
        if (response.error) {
            deps.hostAdapter.log("warn", `[v2] node check validation failed: ${response.error}`);
        }

        const nextDiagnostics: Record<string, NodeCheckDiagnostic[]> = {};
        for (const diagnostic of response.diagnostics) {
            (nextDiagnostics[diagnostic.instanceKey] ||= []).push(diagnostic);
        }
        deps.workspaceStore.setState((state) => ({
            ...state,
            nodeCheckDiagnostics: nextDiagnostics,
        }));
        return nextDiagnostics;
    };

    const normalizeHostDocumentSnapshot = (content: string): string | null => {
        const filePath = deps.workspaceStore.getState().filePath || undefined;
        try {
            return serializePersistedTree(parsePersistedTreeContent(content, filePath));
        } catch {
            return null;
        }
    };

    const matchesCurrentDocumentSnapshot = (content: string): boolean => {
        const currentSnapshot = getSerializedCurrentTree();
        if (!currentSnapshot) {
            return false;
        }
        return normalizeHostDocumentSnapshot(content) === currentSnapshot;
    };

    /**
     * Centralized graph-side refresh after selection/search/variable-focus
     * changes. Commands update stores first, then let this recompute all
     * derived visual state from the cached resolved graph.
     */
    const applyVisualState = async () => {
        if (!resolvedGraph) {
            return;
        }
        const selection = deps.selectionStore.getState();
        const workspace = deps.workspaceStore.getState();

        await deps.graphAdapter.applySelection({
            selectedNodeKey: selection.selectedNodeKey,
        });

        const highlights: GraphHighlightState = computeVariableHighlights(
            resolvedGraph,
            workspace.nodeDefs,
            selection.activeVariableNames
        );
        await deps.graphAdapter.applyHighlights(highlights);

        const graphSearch: GraphSearchState = buildSearchState({
            graph: resolvedGraph,
            query: selection.search.query,
            mode: selection.search.mode,
            caseSensitive: selection.search.caseSensitive,
            focusOnly: selection.search.focusOnly,
            activeResultIndex: selection.search.index,
            tree: deps.documentStore.getState().persistedTree,
        });

        patchSelectionSearchState(deps.selectionStore, {
            results: graphSearch.resultKeys,
            index: graphSearch.activeResultIndex,
        });

        await deps.graphAdapter.applySearch(graphSearch);
    };

    /**
     * Selection survives rebuilds by rebinding to the best matching node.
     * Instance keys are preferred, then we progressively fall back to stable
     * source identities because subtree expansion can reallocate instance keys.
     */
    const restoreSelection = async () => {
        const selection = deps.selectionStore.getState();
        if (!resolvedGraph || !selection.selectedNodeRef) {
            await deps.graphAdapter.applySelection({ selectedNodeKey: null });
            return;
        }

        const direct = resolvedGraph.nodesByInstanceKey[selection.selectedNodeRef.instanceKey];
        const fallback =
            direct ??
            Object.values(resolvedGraph.nodesByInstanceKey).find(
                (node) =>
                    node.ref.structuralStableId === selection.selectedNodeRef?.structuralStableId &&
                    node.ref.sourceStableId === selection.selectedNodeRef?.sourceStableId &&
                    node.ref.sourceTreePath === selection.selectedNodeRef?.sourceTreePath
            ) ??
            Object.values(resolvedGraph.nodesByInstanceKey).find(
                (node) =>
                    node.ref.sourceStableId === selection.selectedNodeRef?.sourceStableId &&
                    node.ref.sourceTreePath === selection.selectedNodeRef?.sourceTreePath
            ) ??
            Object.values(resolvedGraph.nodesByInstanceKey).find(
                (node) =>
                    node.ref.structuralStableId === selection.selectedNodeRef?.structuralStableId
            );

        if (!fallback) {
            updateSelectionState(() => buildTreeSelectionPatch());
            await deps.graphAdapter.applySelection({ selectedNodeKey: null });
            return;
        }

        updateSelectionState(() => buildResolvedNodeSelectionPatch(fallback.ref.instanceKey) ?? {});
        await deps.graphAdapter.applySelection({ selectedNodeKey: fallback.ref.instanceKey });
    };

    /**
     * The only place that replaces the cached resolved graph snapshot.
     * All command modules depend on this after any tree/subtree/settings change.
     */
    const rebuildGraph = async (opts?: { preserveSelection?: boolean }) => {
        const tree = deps.documentStore.getState().persistedTree;
        const workspace = deps.workspaceStore.getState();
        if (!tree) {
            return;
        }

        const result = resolveDocumentGraph({
            persistedTree: tree,
            subtreeSources: workspace.subtreeSources,
            nodeDefs: workspace.nodeDefs,
            subtreeEditable: workspace.settings.subtreeEditable,
        });

        resolvedGraph = result.graph;
        const nodeCheckDiagnostics = await requestNodeCheckDiagnostics(result.graph, workspace);

        await deps.graphAdapter.render(
            buildResolvedGraphModel(
                result.graph,
                workspace.nodeDefs,
                workspace.settings.nodeColors,
                {
                    usingVars: workspace.usingVars,
                    usingGroups: workspace.usingGroups,
                    checkExpr: workspace.settings.checkExpr,
                    nodeCheckDiagnostics,
                }
            )
        );
        if (opts?.preserveSelection) {
            await restoreSelection();
        } else {
            await deps.graphAdapter.applySelection({
                selectedNodeKey: deps.selectionStore.getState().selectedNodeKey,
            });
        }
        await applyVisualState();
    };

    /**
     * Refresh the subtree cache for files that are currently reachable from the
     * main tree only. Any write-back here is for normalization such as filling
     * missing ids/defaults discovered while loading subtree content.
     */
    const syncReachableSubtreeSources = async () => {
        const tree = deps.documentStore.getState().persistedTree;
        if (!tree) {
            return;
        }

        const nextSources = await loadSubtreeSourceCache({
            root: tree.root,
            readContent: async (path) => {
                const response = await deps.hostAdapter.readFile(path);
                return response.content;
            },
            onTreeLoaded: ({ path, tree: subtree, needsWriteback }) => {
                if (needsWriteback) {
                    void deps.hostAdapter.saveSubtree(path, serializePersistedTree(subtree));
                }
            },
        });

        deps.workspaceStore.setState((state) => ({
            ...state,
            subtreeSources: nextSources,
            subtreeSourceRevision: state.subtreeSourceRevision + 1,
        }));
    };

    const setDocumentTree = (
        tree: PersistedTreeModel,
        opts?: { savedSnapshot?: string | null }
    ) => {
        deps.documentStore.setState((state) => {
            const nextSavedSnapshot = opts?.savedSnapshot ?? state.lastSavedSnapshot;
            return {
                ...state,
                persistedTree: tree,
                dirty: computeDirty(tree, nextSavedSnapshot),
                lastSavedSnapshot: nextSavedSnapshot,
            };
        });
        deps.workspaceStore.setState((state) => ({
            ...state,
            usingGroups: buildUsingGroups(tree.group),
        }));
    };

    const pushCurrentHistorySnapshot = () => {
        const snapshot = getSerializedCurrentTree();
        if (snapshot) {
            pushHistorySnapshot(snapshot);
        }
    };

    const resetDocumentHistory = () => {
        const snapshot = getSerializedCurrentTree();
        if (!snapshot) {
            return;
        }

        deps.documentStore.setState((state) => ({
            ...state,
            history: [snapshot],
            historyIndex: 0,
            lastSavedSnapshot: snapshot,
            dirty: false,
            alertReload: false,
            pendingExternalContent: null,
        }));
    };

    /**
     * Canonical "apply tree into editor state" path shared by open/reload,
     * history replay, and local mutations so graph rebuild + subtree syncing
     * stay consistent across every entry point.
     */
    const applyDocumentTree = async (
        tree: PersistedTreeModel,
        opts?: ControllerApplyTreeOptions
    ) => {
        setDocumentTree(tree, { savedSnapshot: opts?.savedSnapshot });

        if (opts?.syncSubtreeSources !== false) {
            await syncReachableSubtreeSources();
        }

        if (opts?.rebuildGraph !== false) {
            await rebuildGraph({ preserveSelection: opts?.preserveSelection ?? true });
            return;
        }

        if (opts?.applyVisualState) {
            await applyVisualState();
        }
    };

    /**
     * Wrap a structural mutation in the full editor commit pipeline:
     * optional selection prep, document state update, graph rebuild, history,
     * and host notification.
     */
    const commitTreeMutation = async (
        tree: PersistedTreeModel,
        opts?: ControllerCommitTreeOptions
    ) => {
        opts?.prepareSelection?.();
        await applyDocumentTree(tree, {
            syncSubtreeSources: opts?.syncSubtreeSources,
            rebuildGraph: opts?.rebuildGraph,
            preserveSelection: opts?.preserveSelection,
            applyVisualState: opts?.applyVisualState,
            savedSnapshot: opts?.savedSnapshot,
        });

        if (opts?.pushHistory !== false) {
            pushCurrentHistorySnapshot();
        }

        const treeSelectedMode = opts?.treeSelectedMode ?? "debounced";
        if (treeSelectedMode !== "skip") {
            scheduleTreeSelected(treeSelectedMode === "immediate");
        }
    };

    /**
     * Undo/redo replays the serialized tree snapshot, then restores viewport so
     * navigation history feels stable even though the whole resolved graph was
     * rebuilt underneath.
     */
    const applyHistoryIndex = async (nextIndex: number) => {
        const viewport = deps.graphAdapter.getViewport();
        const documentState = deps.documentStore.getState();
        const snapshot = documentState.history[nextIndex];
        if (!snapshot) {
            return;
        }
        const filePath = deps.workspaceStore.getState().filePath || undefined;
        const tree = parsePersistedTreeContent(snapshot, filePath);
        await applyDocumentTree(tree, {
            preserveSelection: true,
        });
        await deps.graphAdapter.restoreViewport(viewport);
        deps.documentStore.setState((state) => ({
            ...state,
            historyIndex: nextIndex,
            dirty: computeDirty(state.persistedTree, state.lastSavedSnapshot),
        }));
        deps.hostAdapter.sendUpdate(snapshot);
        scheduleTreeSelected();
    };

    return {
        deps,
        getResolvedGraph: () => resolvedGraph,
        notifyError,
        notifySuccess,
        scheduleTreeSelected,
        getNodeDef,
        selectTreeState,
        selectResolvedNodeState,
        selectPendingNodeState,
        clearActiveVariableFocus,
        getSelectedResolvedNode,
        isSubtreeStructureLocked,
        readClipboardNode,
        assignFreshStableIds,
        findPersistedNodeLocationByStableId,
        isDescendantInstance,
        buildPersistedNodeFromResolved,
        overwritePersistedNode,
        applyHistoryIndex,
        applyVisualState,
        rebuildGraph,
        syncReachableSubtreeSources,
        getSerializedCurrentTree,
        matchesCurrentDocumentSnapshot,
        resetDocumentHistory,
        applyDocumentTree,
        commitTreeMutation,
    };
};
