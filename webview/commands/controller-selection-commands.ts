import type { EditorCommand } from "../shared/contracts";
import { patchSelectionSearchState } from "../stores/selection-store";
import type { ControllerRuntime } from "./controller-runtime";

type SelectionCommandKeys =
    | "selectTree"
    | "selectNode"
    | "focusVariable"
    | "openSearch"
    | "updateSearch"
    | "nextSearchResult"
    | "prevSearchResult";

export const createSelectionCommands = (
    runtime: ControllerRuntime
): Pick<EditorCommand, SelectionCommandKeys> => {
    const { deps } = runtime;

    const commands: Pick<EditorCommand, SelectionCommandKeys> = {
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

            const shouldClearVariableFocus = runtime.selectTreeState({ clearVariableFocus: true });
            if (shouldClearVariableFocus) {
                await runtime.applyVisualState();
            } else {
                await deps.graphAdapter.applySelection({ selectedNodeKey: null });
            }
        },

        async selectNode(
            nodeKey: string,
            opts?: { force?: boolean; clearVariableFocus?: boolean }
        ) {
            const resolvedGraph = runtime.getResolvedGraph();
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

                runtime.clearActiveVariableFocus();
                await runtime.applyVisualState();
                return;
            }

            runtime.selectResolvedNodeState(node.ref.instanceKey, {
                clearVariableFocus: shouldClearVariableFocus,
            });

            if (shouldClearVariableFocus) {
                await runtime.applyVisualState();
            } else {
                await deps.graphAdapter.applySelection({ selectedNodeKey: node.ref.instanceKey });
            }
        },

        async focusVariable(names: string[]) {
            deps.selectionStore.setState((state) => ({
                ...state,
                activeVariableNames: [...names],
            }));
            await runtime.applyVisualState();
        },

        async openSearch(mode: "content" | "id") {
            patchSelectionSearchState(deps.selectionStore, {
                open: true,
                mode,
            });
            await runtime.applyVisualState();
        },

        async updateSearch(query: string) {
            patchSelectionSearchState(deps.selectionStore, {
                query,
                index: 0,
            });
            await runtime.applyVisualState();
            const { results } = deps.selectionStore.getState().search;
            if (results.length > 0) {
                await commands.selectNode(results[0], { force: true });
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
            await runtime.applyVisualState();
            const key = deps.selectionStore.getState().search.results[nextIndex];
            if (key) {
                await commands.selectNode(key, { force: true });
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
            await runtime.applyVisualState();
            const key = deps.selectionStore.getState().search.results[nextIndex];
            if (key) {
                await commands.selectNode(key, { force: true });
                await deps.graphAdapter.focusNode(key);
            }
        },
    };

    return commands;
};
