import type { StoreApi } from "zustand/vanilla";
import { VERSION } from "../shared/misc/b3type";
import { computeNodeOverride } from "../shared/misc/b3util";
import { message } from "../shared/misc/hooks";
import i18n from "../shared/misc/i18n";
import { stringifyJson } from "../shared/misc/stringify";
import { nanoid } from "../shared/misc/util";
import type {
    DocumentState,
    DropIntent,
    EditNode,
    EditNodeDef,
    EditorCommand,
    GraphAdapter,
    GraphHighlightState,
    GraphSearchState,
    HostAdapter,
    HostInitPayload,
    HostVarsPayload,
    NodeDef,
    NodeInstanceRef,
    PersistedNodeModel,
    PersistedTreeModel,
    ResolvedDocumentGraph,
    SelectionState,
    UpdateNodeInput,
    UpdateTreeMetaInput,
    WorkspaceState,
} from "../shared/contracts";
import { normalizeWorkdirRelativePath, deriveGroupDefs } from "../shared/protocol";
import {
    clonePersistedTree,
    collectReachableSubtreePaths,
    findPersistedNodeByStableId,
    hasMissingStableIds,
    parsePersistedTreeContent,
    serializePersistedTree,
    walkPersistedNodes,
} from "../shared/tree";
import {
    buildResolvedGraphModel,
    buildSearchState,
    computeVariableHighlights,
} from "../domain/graph-selectors";
import { resolveDocumentGraph } from "../domain/resolve-graph";
import { markDocumentSaved, showDocumentReloadConflict } from "../stores/document-store";
import { patchSelectionSearchState } from "../stores/selection-store";

interface ControllerDeps {
    documentStore: StoreApi<DocumentState>;
    workspaceStore: StoreApi<WorkspaceState>;
    selectionStore: StoreApi<SelectionState>;
    hostAdapter: HostAdapter;
    graphAdapter: GraphAdapter;
}

const computeDirty = (
    tree: PersistedTreeModel | null,
    lastSavedSnapshot: string | null
): boolean => {
    if (!tree || lastSavedSnapshot == null) {
        return false;
    }
    return serializePersistedTree(tree) !== lastSavedSnapshot;
};

const buildUsingGroups = (groupNames: string[]): Record<string, boolean> | null => {
    if (groupNames.length === 0) {
        return null;
    }
    const record: Record<string, boolean> = {};
    for (const group of groupNames) {
        record[group] = true;
    }
    return record;
};

const cloneVars = <T extends { name: string; desc: string }>(entries: T[]): T[] =>
    entries.map((entry) => ({ ...entry }));

const isJsonEqual = (left: unknown, right: unknown): boolean =>
    JSON.stringify(left) === JSON.stringify(right);

type TreeSelectedMode = "debounced" | "immediate" | "skip";
type SelectionPatch = Partial<
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

export const createEditorController = (deps: ControllerDeps): EditorCommand => {
    let resolvedGraph: ResolvedDocumentGraph | null = null;
    let treeSelectedTimer: number | null = null;

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

    const clonePersistedNodeDeep = (node: PersistedNodeModel): PersistedNodeModel =>
        JSON.parse(JSON.stringify(node)) as PersistedNodeModel;

    const assignFreshStableIds = (node: PersistedNodeModel) => {
        node.$id = nanoid();
        for (const child of node.children ?? []) {
            assignFreshStableIds(child);
        }
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

    const getSelectedResolvedNode = () => {
        const ref = deps.selectionStore.getState().selectedNodeRef;
        if (!ref || !resolvedGraph) {
            return null;
        }
        return resolvedGraph.nodesByInstanceKey[ref.instanceKey] ?? null;
    };

    const isSubtreeStructureLocked = (node: ReturnType<typeof getSelectedResolvedNode>) => {
        return Boolean(node?.subtreeNode || node?.path);
    };

    const normalizeClipboardNode = (value: unknown): PersistedNodeModel => {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
            throw new Error("invalid clipboard node");
        }

        const candidate = value as Partial<PersistedNodeModel>;
        if (typeof candidate.name !== "string" || !candidate.name.trim()) {
            throw new Error("invalid clipboard node");
        }

        const normalized: PersistedNodeModel = {
            $id: typeof candidate.$id === "string" && candidate.$id ? candidate.$id : nanoid(),
            id: typeof candidate.id === "string" ? candidate.id : "",
            name: candidate.name,
            desc: typeof candidate.desc === "string" ? candidate.desc : undefined,
            args:
                candidate.args &&
                typeof candidate.args === "object" &&
                !Array.isArray(candidate.args)
                    ? JSON.parse(JSON.stringify(candidate.args))
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
                    ? normalizeWorkdirRelativePath(candidate.path)
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
            message.error(i18n.t("node.pasteDataError"));
            return null;
        }
    };

    const findPersistedNodeLocationByStableId = (
        root: PersistedNodeModel,
        stableId: string
    ): { node: PersistedNodeModel; parent: PersistedNodeModel | null } | null => {
        let found: { node: PersistedNodeModel; parent: PersistedNodeModel | null } | null = null;

        walkPersistedNodes(root, (node, parent) => {
            if (!found && node.$id === stableId) {
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
                $id: node.ref.sourceStableId,
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

    const buildPersistedNodeFromResolved = (
        instanceKey: string,
        opts?: { clearPathOnRoot?: boolean }
    ): PersistedNodeModel | null => {
        const buildNode = (currentKey: string, isRoot: boolean): PersistedNodeModel | null => {
            if (!resolvedGraph) {
                return null;
            }
            const resolvedNode = resolvedGraph.nodesByInstanceKey[currentKey];
            if (!resolvedNode) {
                return null;
            }

            const node: PersistedNodeModel = {
                $id: isRoot ? resolvedNode.ref.structuralStableId : resolvedNode.ref.sourceStableId,
                id: resolvedNode.ref.displayId,
                name: resolvedNode.name,
                desc: resolvedNode.desc,
                args: resolvedNode.args ? JSON.parse(JSON.stringify(resolvedNode.args)) : undefined,
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
        await deps.graphAdapter.render(
            buildResolvedGraphModel(
                result.graph,
                workspace.nodeDefs,
                workspace.settings.nodeColors,
                {
                    usingVars: workspace.usingVars,
                    usingGroups: workspace.usingGroups,
                    checkExpr: workspace.settings.checkExpr,
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

    const syncReachableSubtreeSources = async () => {
        const tree = deps.documentStore.getState().persistedTree;
        if (!tree) {
            return;
        }

        const nextSources = {
            ...deps.workspaceStore.getState().subtreeSources,
        };
        const visited = new Set<string>();

        const loadPath = async (path: string) => {
            const normalized = normalizeWorkdirRelativePath(path);
            if (visited.has(normalized)) {
                return;
            }
            visited.add(normalized);

            const response = await deps.hostAdapter.readFile(normalized);
            if (response.content === null) {
                nextSources[normalized] = null;
                return;
            }

            try {
                const needsWriteback = hasMissingStableIds(response.content);
                const subtree = parsePersistedTreeContent(response.content, normalized);
                nextSources[normalized] = subtree;

                if (needsWriteback) {
                    void deps.hostAdapter.saveSubtree(normalized, serializePersistedTree(subtree));
                }

                for (const childPath of collectReachableSubtreePaths(subtree.root)) {
                    await loadPath(childPath);
                }
            } catch {
                nextSources[normalized] = {
                    error: "invalid-subtree",
                };
            }
        };

        for (const path of collectReachableSubtreePaths(tree.root)) {
            await loadPath(path);
        }

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

    const getSerializedCurrentTree = (): string | null => {
        const tree = deps.documentStore.getState().persistedTree;
        return tree ? serializePersistedTree(tree) : null;
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

    const applyDocumentTree = async (
        tree: PersistedTreeModel,
        opts?: {
            savedSnapshot?: string | null;
            syncSubtreeSources?: boolean;
            rebuildGraph?: boolean;
            preserveSelection?: boolean;
            applyVisualState?: boolean;
        }
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

    const commitTreeMutation = async (
        tree: PersistedTreeModel,
        opts?: {
            prepareSelection?: () => void;
            syncSubtreeSources?: boolean;
            rebuildGraph?: boolean;
            preserveSelection?: boolean;
            applyVisualState?: boolean;
            pushHistory?: boolean;
            treeSelectedMode?: TreeSelectedMode;
        }
    ) => {
        opts?.prepareSelection?.();
        await applyDocumentTree(tree, {
            syncSubtreeSources: opts?.syncSubtreeSources,
            rebuildGraph: opts?.rebuildGraph,
            preserveSelection: opts?.preserveSelection,
            applyVisualState: opts?.applyVisualState,
        });

        if (opts?.pushHistory !== false) {
            pushCurrentHistorySnapshot();
        }

        const treeSelectedMode = opts?.treeSelectedMode ?? "debounced";
        if (treeSelectedMode !== "skip") {
            scheduleTreeSelected(treeSelectedMode === "immediate");
        }
    };

    const controller: EditorCommand = {
        async initFromHost(payload: HostInitPayload) {
            const persistedTree = parsePersistedTreeContent(payload.content, payload.filePath);
            deps.workspaceStore.setState((state) => ({
                ...state,
                filePath: payload.filePath,
                workdir: payload.workdir,
                nodeDefs: payload.nodeDefs,
                groupDefs: deriveGroupDefs(payload.nodeDefs),
                allFiles: payload.allFiles,
                settings: payload.settings,
                usingGroups: buildUsingGroups(persistedTree.group),
            }));
            selectTreeState();

            await applyDocumentTree(persistedTree, {
                savedSnapshot: null,
                preserveSelection: false,
            });
            resetDocumentHistory();
        },

        async reloadDocumentFromHost(content: string, opts?: { force?: boolean }) {
            if (deps.documentStore.getState().dirty && !opts?.force) {
                showDocumentReloadConflict(deps.documentStore, content);
                return;
            }

            const filePath = deps.workspaceStore.getState().filePath || undefined;
            const tree = parsePersistedTreeContent(content, filePath);
            await applyDocumentTree(tree, {
                savedSnapshot: null,
                preserveSelection: true,
            });
            resetDocumentHistory();
            scheduleTreeSelected(true);
        },

        async applyNodeDefs(defs: NodeDef[]) {
            deps.workspaceStore.setState((state) => ({
                ...state,
                nodeDefs: defs,
                groupDefs: deriveGroupDefs(defs),
            }));
            await rebuildGraph({ preserveSelection: true });
        },

        async applyHostVars(payload: HostVarsPayload) {
            const current = deps.workspaceStore.getState();
            const nextAllFiles = payload.allFiles ?? current.allFiles;
            const usingVarsChanged = !isJsonEqual(current.usingVars, payload.usingVars);
            const allFilesChanged = !isJsonEqual(current.allFiles, nextAllFiles);
            const importDeclsChanged = !isJsonEqual(current.importDecls, payload.importDecls);
            const subtreeDeclsChanged = !isJsonEqual(current.subtreeDecls, payload.subtreeDecls);

            if (!usingVarsChanged && !allFilesChanged && !importDeclsChanged && !subtreeDeclsChanged) {
                return;
            }

            deps.workspaceStore.setState((state) => ({
                ...state,
                usingVars: payload.usingVars,
                allFiles: payload.allFiles ?? state.allFiles,
                importDecls: payload.importDecls,
                subtreeDecls: payload.subtreeDecls,
            }));

            if (usingVarsChanged) {
                await rebuildGraph({ preserveSelection: true });
            }
        },

        async markSubtreeChanged() {
            deps.workspaceStore.setState((state) => ({
                ...state,
                hostSubtreeRefreshSeq: state.hostSubtreeRefreshSeq + 1,
            }));
            await syncReachableSubtreeSources();
            await rebuildGraph({ preserveSelection: true });
            scheduleTreeSelected(true);
        },

        async selectTree() {
            const selection = deps.selectionStore.getState();
            const alreadyTreeSelected =
                selection.selectedTree?.filePath === deps.workspaceStore.getState().filePath &&
                selection.selectedNodeKey === null &&
                selection.selectedNodeRef === null &&
                selection.selectedNodeSnapshot === null &&
                selection.selectedNodeDef === null;

            if (alreadyTreeSelected && selection.activeVariableNames.length === 0) {
                return;
            }

            const shouldClearVariableFocus = selectTreeState({ clearVariableFocus: true });
            if (shouldClearVariableFocus) {
                await applyVisualState();
            } else {
                await deps.graphAdapter.applySelection({ selectedNodeKey: null });
            }
        },

        async selectNode(
            nodeKey: string,
            opts?: { force?: boolean; clearVariableFocus?: boolean }
        ) {
            if (!resolvedGraph) {
                return;
            }
            const node = resolvedGraph.nodesByInstanceKey[nodeKey];
            if (!node) {
                return;
            }

            const shouldClearVariableFocus =
                Boolean(opts?.clearVariableFocus) &&
                deps.selectionStore.getState().activeVariableNames.length > 0;
            const previous = deps.selectionStore.getState().selectedNodeKey;
            if (previous === nodeKey && !opts?.force) {
                if (!shouldClearVariableFocus) {
                    return;
                }

                clearActiveVariableFocus();
                await applyVisualState();
                return;
            }

            selectResolvedNodeState(node.ref.instanceKey, {
                clearVariableFocus: shouldClearVariableFocus,
            });

            if (shouldClearVariableFocus) {
                await applyVisualState();
            } else {
                await deps.graphAdapter.applySelection({ selectedNodeKey: node.ref.instanceKey });
            }
        },

        async focusVariable(names: string[]) {
            deps.selectionStore.setState((state) => ({
                ...state,
                activeVariableNames: [...names],
            }));
            await applyVisualState();
        },

        async updateTreeMeta(payload: UpdateTreeMetaInput) {
            const tree = deps.documentStore.getState().persistedTree;
            if (!tree) {
                return;
            }
            const nextDesc = payload.desc?.trim() || undefined;
            const nextPrefix = payload.prefix ?? "";
            const nextExport = payload.export !== false;
            const nextGroup = [...payload.group];
            const nextVars = cloneVars(payload.vars).sort((a, b) => a.name.localeCompare(b.name));
            const nextImportRefs = [...payload.importRefs].sort((a, b) => a.localeCompare(b));

            if (
                tree.desc === nextDesc &&
                tree.prefix === nextPrefix &&
                (tree.export !== false) === nextExport &&
                isJsonEqual(tree.group, nextGroup) &&
                isJsonEqual(tree.vars, nextVars) &&
                isJsonEqual(tree.import, nextImportRefs)
            ) {
                return;
            }

            const nextTree = clonePersistedTree(tree);
            nextTree.desc = nextDesc;
            nextTree.prefix = nextPrefix;
            nextTree.export = nextExport;
            nextTree.group = nextGroup;
            nextTree.vars = nextVars;
            nextTree.import = nextImportRefs;
            await commitTreeMutation(nextTree, {
                syncSubtreeSources: false,
                rebuildGraph: tree.prefix !== nextPrefix || !isJsonEqual(tree.group, nextGroup),
                preserveSelection: true,
                applyVisualState: true,
            });
        },

        async updateNode(payload: UpdateNodeInput) {
            const currentTree = deps.documentStore.getState().persistedTree;
            const selectedSnapshot = deps.selectionStore.getState().selectedNodeSnapshot;
            const resolvedNode =
                resolvedGraph?.nodesByInstanceKey[payload.target.instanceKey] ?? null;
            if (!currentTree || !resolvedNode) {
                return;
            }

            const nextName =
                String(payload.data.name ?? resolvedNode.name).trim() || resolvedNode.name;
            const nextDesc = payload.data.desc?.trim() || undefined;
            const nextPath = payload.data.path?.trim() || undefined;
            const nextDebug = Boolean(payload.data.debug);
            const nextDisabled = Boolean(payload.data.disabled);
            const nextInput = payload.data.input;
            const nextOutput = payload.data.output;
            const nextArgs = payload.data.args;

            if (
                nextName === resolvedNode.name &&
                nextDesc === resolvedNode.desc &&
                nextPath === resolvedNode.path &&
                nextDebug === Boolean(resolvedNode.debug) &&
                nextDisabled === Boolean(resolvedNode.disabled) &&
                isJsonEqual(nextInput ?? [], resolvedNode.input ?? []) &&
                isJsonEqual(nextOutput ?? [], resolvedNode.output ?? []) &&
                isJsonEqual(nextArgs ?? {}, resolvedNode.args ?? {})
            ) {
                return;
            }

            const tree = clonePersistedTree(currentTree);
            if (resolvedNode.subtreeNode) {
                const def = getNodeDef(resolvedNode.name);
                const original = resolvedNode.subtreeOriginal;
                if (!original) {
                    return;
                }

                const editedNode: PersistedNodeModel = {
                    $id: resolvedNode.ref.sourceStableId,
                    id: resolvedNode.ref.displayId,
                    name: nextName,
                    desc: nextDesc,
                    args: nextArgs,
                    input: nextInput,
                    output: nextOutput,
                    debug: nextDebug,
                    disabled: nextDisabled,
                    path: resolvedNode.path,
                };

                const diff = computeNodeOverride(
                    original as never,
                    editedNode as never,
                    { args: def?.args } as { args?: NodeDef["args"] } as never
                );

                if (diff) {
                    tree.$override[payload.target.sourceStableId] = diff;
                } else {
                    delete tree.$override[payload.target.sourceStableId];
                }

                await commitTreeMutation(tree);
                return;
            }

            const node = findPersistedNodeByStableId(tree.root, payload.target.structuralStableId);
            if (!node) {
                return;
            }

            const isDetachingSubtree = Boolean(selectedSnapshot?.data.path) && !payload.data.path;
            if (isDetachingSubtree) {
                const detached = buildPersistedNodeFromResolved(payload.target.instanceKey, {
                    clearPathOnRoot: true,
                });
                if (detached) {
                    detached.name = nextName;
                    detached.desc = nextDesc;
                    detached.args = nextArgs;
                    detached.input = nextInput;
                    detached.output = nextOutput;
                    detached.debug = nextDebug;
                    detached.disabled = nextDisabled;
                    overwritePersistedNode(node, detached);
                }
            } else {
                node.name = nextName;
                node.desc = nextDesc;
                node.args = nextArgs;
                node.input = nextInput;
                node.output = nextOutput;
                node.debug = nextDebug;
                node.disabled = nextDisabled;
                node.path = nextPath;
                if (nextPath && nextPath !== selectedSnapshot?.data.path) {
                    node.children = undefined;
                }
            }

            await commitTreeMutation(tree);
        },

        async performDrop(intent: DropIntent) {
            const currentTree = deps.documentStore.getState().persistedTree;
            const sourceResolved =
                resolvedGraph?.nodesByInstanceKey[intent.source.instanceKey] ?? null;
            const targetResolved =
                resolvedGraph?.nodesByInstanceKey[intent.target.instanceKey] ?? null;

            if (!currentTree || !resolvedGraph || !sourceResolved || !targetResolved) {
                return;
            }

            if (intent.source.instanceKey === intent.target.instanceKey) {
                return;
            }

            if (sourceResolved.subtreeNode) {
                throw new Error(i18n.t("node.moveSubtreeDenied"));
            }

            if (targetResolved.subtreeNode) {
                throw new Error(i18n.t("node.dropSubtreeInternalDenied"));
            }

            if (sourceResolved.parentKey === null) {
                throw new Error(i18n.t("node.moveRootDenied"));
            }

            if (
                (intent.position === "before" || intent.position === "after") &&
                targetResolved.parentKey === null
            ) {
                throw new Error(i18n.t("node.dropAroundRootDenied"));
            }

            if (
                intent.position === "child" &&
                targetResolved.ref.sourceTreePath !== null &&
                !targetResolved.subtreeNode
            ) {
                throw new Error(i18n.t("node.addChildToSubtreeRefDenied"));
            }

            if (
                isDescendantInstance(sourceResolved.ref.instanceKey, targetResolved.ref.instanceKey)
            ) {
                throw new Error(i18n.t("node.moveIntoDescendantDenied"));
            }

            const tree = clonePersistedTree(currentTree);
            const sourceLocation = findPersistedNodeLocationByStableId(
                tree.root,
                sourceResolved.ref.structuralStableId
            );
            const targetLocation = findPersistedNodeLocationByStableId(
                tree.root,
                targetResolved.ref.structuralStableId
            );

            if (!sourceLocation?.parent || !targetLocation) {
                return;
            }

            const sourceSiblings = sourceLocation.parent.children ?? [];
            const sourceIndex = sourceSiblings.findIndex(
                (entry) => entry.$id === sourceLocation.node.$id
            );
            if (sourceIndex < 0) {
                return;
            }

            const [movedNode] = sourceSiblings.splice(sourceIndex, 1);
            if (!movedNode) {
                return;
            }

            if (intent.position === "child") {
                targetLocation.node.children ||= [];
                targetLocation.node.children.push(movedNode);
            } else {
                const targetParent = targetLocation.parent;
                if (!targetParent?.children) {
                    return;
                }

                const targetIndex = targetParent.children.findIndex(
                    (entry) => entry.$id === targetLocation.node.$id
                );
                if (targetIndex < 0) {
                    return;
                }

                targetParent.children.splice(
                    intent.position === "before" ? targetIndex : targetIndex + 1,
                    0,
                    movedNode
                );
            }

            await commitTreeMutation(tree, {
                prepareSelection: () => {
                    selectResolvedNodeState(sourceResolved.ref.instanceKey);
                },
            });
        },

        async openSearch(mode: "content" | "id") {
            patchSelectionSearchState(deps.selectionStore, {
                open: true,
                mode,
            });
            await applyVisualState();
        },

        async updateSearch(query: string) {
            patchSelectionSearchState(deps.selectionStore, {
                query,
                index: 0,
            });
            await applyVisualState();
            const { results } = deps.selectionStore.getState().search;
            if (results.length > 0) {
                await controller.selectNode(results[0], { force: true });
                await deps.graphAdapter.focusNode(results[0]);
            }
        },

        async nextSearchResult() {
            const search = deps.selectionStore.getState().search;
            if (search.results.length === 0) {
                return;
            }
            const nextIndex = (search.index + 1) % search.results.length;
            patchSelectionSearchState(deps.selectionStore, {
                index: nextIndex,
            });
            await applyVisualState();
            const key = deps.selectionStore.getState().search.results[nextIndex];
            if (key) {
                await controller.selectNode(key, { force: true });
                await deps.graphAdapter.focusNode(key);
            }
        },

        async prevSearchResult() {
            const search = deps.selectionStore.getState().search;
            if (search.results.length === 0) {
                return;
            }
            const nextIndex = (search.index + search.results.length - 1) % search.results.length;
            patchSelectionSearchState(deps.selectionStore, {
                index: nextIndex,
            });
            await applyVisualState();
            const key = deps.selectionStore.getState().search.results[nextIndex];
            if (key) {
                await controller.selectNode(key, { force: true });
                await deps.graphAdapter.focusNode(key);
            }
        },

        async copyNode() {
            const selected = getSelectedResolvedNode();
            if (!selected) {
                message.error(i18n.t("node.noNodeSelected"));
                return;
            }

            const snapshot = buildPersistedNodeFromResolved(selected.ref.instanceKey, {
                clearPathOnRoot: true,
            });
            if (!snapshot) {
                return;
            }

            try {
                await navigator.clipboard.writeText(stringifyJson(snapshot, { indent: 2 }));
            } catch (error) {
                deps.hostAdapter.log("warn", `[v2] clipboard write failed: ${String(error)}`);
            }
        },

        async pasteNode() {
            const currentTree = deps.documentStore.getState().persistedTree;
            const selected = getSelectedResolvedNode();
            if (!currentTree || !selected) {
                message.error(i18n.t("node.noNodeSelected"));
                return;
            }
            if (isSubtreeStructureLocked(selected)) {
                message.error(i18n.t("node.editSubtreeDenied"));
                return;
            }

            const snapshot = await readClipboardNode();
            if (!snapshot) {
                return;
            }

            const tree = clonePersistedTree(currentTree);
            const targetNode = findPersistedNodeByStableId(
                tree.root,
                selected.ref.structuralStableId
            );
            if (!targetNode) {
                return;
            }

            const nextNode = clonePersistedNodeDeep(snapshot);
            assignFreshStableIds(nextNode);
            targetNode.children ||= [];
            targetNode.children.push(nextNode);

            await commitTreeMutation(tree, {
                prepareSelection: () => {
                    selectPendingNodeState(nextNode.$id);
                },
            });
        },

        async insertNode() {
            const currentTree = deps.documentStore.getState().persistedTree;
            const selected = getSelectedResolvedNode();
            if (!currentTree || !selected) {
                message.error(i18n.t("node.noNodeSelected"));
                return;
            }
            if (isSubtreeStructureLocked(selected)) {
                message.error(i18n.t("node.editSubtreeDenied"));
                return;
            }

            const tree = clonePersistedTree(currentTree);
            const targetNode = findPersistedNodeByStableId(
                tree.root,
                selected.ref.structuralStableId
            );
            if (!targetNode) {
                return;
            }

            const nextNode: PersistedNodeModel = {
                $id: nanoid(),
                id: "",
                name: "unknown",
            };
            targetNode.children ||= [];
            targetNode.children.push(nextNode);

            await commitTreeMutation(tree, {
                prepareSelection: () => {
                    selectPendingNodeState(nextNode.$id);
                },
            });
        },

        async replaceNode() {
            const currentTree = deps.documentStore.getState().persistedTree;
            const selected = getSelectedResolvedNode();
            if (!currentTree || !selected) {
                message.error(i18n.t("node.noNodeSelected"));
                return;
            }
            if (isSubtreeStructureLocked(selected)) {
                message.error(i18n.t("node.editSubtreeDenied"));
                return;
            }

            const snapshot = await readClipboardNode();
            if (!snapshot) {
                return;
            }

            const tree = clonePersistedTree(currentTree);
            const targetNode = findPersistedNodeByStableId(
                tree.root,
                selected.ref.structuralStableId
            );
            if (!targetNode) {
                return;
            }

            const replacement = clonePersistedNodeDeep(snapshot);
            replacement.$id = targetNode.$id;
            for (const child of replacement.children ?? []) {
                assignFreshStableIds(child);
            }
            if (replacement.path) {
                replacement.children = undefined;
            }
            overwritePersistedNode(targetNode, replacement);

            await commitTreeMutation(tree, {
                prepareSelection: () => {
                    selectPendingNodeState(replacement.$id);
                },
            });
        },

        async deleteNode() {
            const currentTree = deps.documentStore.getState().persistedTree;
            const selected = getSelectedResolvedNode();
            if (!currentTree || !selected) {
                return;
            }
            if (selected.parentKey === null) {
                message.error(i18n.t("node.deleteRootNodeDenied"));
                return;
            }
            if (selected.subtreeNode) {
                message.error(i18n.t("node.editSubtreeDenied"));
                return;
            }

            const tree = clonePersistedTree(currentTree);
            const location = findPersistedNodeLocationByStableId(
                tree.root,
                selected.ref.structuralStableId
            );
            if (!location?.parent?.children) {
                return;
            }

            location.parent.children = location.parent.children.filter(
                (entry) => entry.$id !== location.node.$id
            );
            const nextSelection = location.parent.$id;

            await commitTreeMutation(tree, {
                prepareSelection: () => {
                    selectPendingNodeState(nextSelection);
                },
            });
        },
        async undo() {
            const current = deps.documentStore.getState();
            if (current.historyIndex <= 0) {
                return;
            }
            await applyHistoryIndex(current.historyIndex - 1);
        },
        async redo() {
            const current = deps.documentStore.getState();
            if (current.historyIndex >= current.history.length - 1) {
                return;
            }
            await applyHistoryIndex(current.historyIndex + 1);
        },

        async refreshGraph(opts?: { preserveSelection?: boolean }) {
            await rebuildGraph({
                preserveSelection: opts?.preserveSelection ?? true,
            });
        },

        async saveDocument() {
            const tree = deps.documentStore.getState().persistedTree;
            if (!tree) {
                return;
            }
            if (tree.version > VERSION) {
                deps.hostAdapter.log(
                    "warn",
                    `[v2] refusing to save newer file version: ${tree.version}`
                );
                return;
            }
            const snapshot = serializePersistedTree(tree);
            const response = await deps.hostAdapter.saveDocument(snapshot);
            if (!response.success) {
                message.error(response.error ?? "Save failed");
                return;
            }
            markDocumentSaved(deps.documentStore, snapshot);
        },

        async buildDocument() {
            deps.hostAdapter.sendBuild();
        },

        async openSelectedSubtree() {
            const ref = deps.selectionStore.getState().selectedNodeRef;
            if (!ref || !resolvedGraph) {
                return;
            }
            const current = resolvedGraph.nodesByInstanceKey[ref.instanceKey];
            const path = current?.path ?? ref.subtreeStack.at(-1);
            if (!path) {
                return;
            }
            const response = await deps.hostAdapter.readFile(path, { openIfSubtree: true });
            if (response.content === null) {
                message.error(i18n.t("node.subtreeOpenFailed", { path }));
            }
        },

        async saveSelectedAsSubtree() {
            const currentTree = deps.documentStore.getState().persistedTree;
            const selected = getSelectedResolvedNode();
            if (!currentTree || !selected) {
                message.error(i18n.t("node.noNodeSelected"));
                return;
            }
            if (selected.parentKey === null) {
                message.error(i18n.t("node.subtreeSaveRootError"));
                return;
            }
            if (isSubtreeStructureLocked(selected)) {
                message.error(i18n.t("node.editSubtreeDenied"));
                return;
            }

            const subtreeRoot = buildPersistedNodeFromResolved(selected.ref.instanceKey, {
                clearPathOnRoot: true,
            });
            if (!subtreeRoot) {
                return;
            }

            const subtreeModel: PersistedTreeModel = {
                version: VERSION,
                name: "subtree",
                prefix: "",
                desc: subtreeRoot.desc,
                export: true,
                group: [],
                import: [],
                vars: [],
                custom: {},
                $override: {},
                root: subtreeRoot,
            };

            const suggestedBaseName = subtreeRoot.name?.trim() || "subtree";
            const result = await deps.hostAdapter.saveSubtreeAs(
                serializePersistedTree(subtreeModel),
                suggestedBaseName
            );
            if (!result.savedPath) {
                return;
            }

            const tree = clonePersistedTree(currentTree);
            const targetNode = findPersistedNodeByStableId(
                tree.root,
                selected.ref.structuralStableId
            );
            if (!targetNode) {
                return;
            }

            targetNode.path = normalizeWorkdirRelativePath(result.savedPath);
            targetNode.children = undefined;

            await commitTreeMutation(tree, {
                prepareSelection: () => {
                    selectPendingNodeState(targetNode.$id);
                },
            });
            message.success(i18n.t("node.subtreeSaveSuccess", { path: targetNode.path }));
        },
    };

    return controller;
};
