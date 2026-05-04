import { VERSION } from "../shared/misc/b3type";
import { compareDocumentVersion } from "../shared/document-version";
import type { EditorCommand, HostInitPayload, HostVarsPayload, NodeDef } from "../shared/contracts";
import { deriveGroupDefs } from "../shared/protocol";
import { parsePersistedTreeContent } from "../shared/tree";
import {
    clearDocumentReloadConflict,
    markDocumentSaved,
    showDocumentReloadConflict,
} from "../stores/document-store";
import { buildUsingGroups, isJsonEqual, type ControllerRuntime } from "./controller-runtime";

type DocumentCommandKeys =
    | "initFromHost"
    | "reloadDocumentFromHost"
    | "applyNodeDefs"
    | "applyHostVars"
    | "markSubtreeChanged"
    | "dismissReloadConflict"
    | "undo"
    | "redo"
    | "refreshGraph"
    | "saveDocument"
    | "revertDocument"
    | "buildDocument";

export const createDocumentCommands = (
    runtime: ControllerRuntime
): Pick<EditorCommand, DocumentCommandKeys> => {
    const { deps } = runtime;

    return {
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
            runtime.selectTreeState();

            await runtime.applyDocumentTree(persistedTree, {
                savedSnapshot: null,
                preserveSelection: false,
            });
            runtime.resetDocumentHistory();
        },

        async reloadDocumentFromHost(content: string, opts?: { force?: boolean }) {
            if (runtime.matchesCurrentDocumentSnapshot(content)) {
                clearDocumentReloadConflict(deps.documentStore);
                if (opts?.force) {
                    const snapshot = runtime.getSerializedCurrentTree();
                    if (snapshot) {
                        markDocumentSaved(deps.documentStore, snapshot);
                    }
                }
                return;
            }

            if (deps.documentStore.getState().dirty && !opts?.force) {
                showDocumentReloadConflict(deps.documentStore, content);
                return;
            }

            const filePath = deps.workspaceStore.getState().filePath || undefined;
            const tree = parsePersistedTreeContent(content, filePath);
            clearDocumentReloadConflict(deps.documentStore);
            await runtime.applyDocumentTree(tree, {
                savedSnapshot: null,
                preserveSelection: true,
            });
            runtime.resetDocumentHistory();
            runtime.scheduleTreeSelected(true);
        },

        async applyNodeDefs(defs: NodeDef[]) {
            deps.workspaceStore.setState((state) => ({
                ...state,
                nodeDefs: defs,
                groupDefs: deriveGroupDefs(defs),
            }));
            await runtime.rebuildGraph({ preserveSelection: true });
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
                await runtime.rebuildGraph({ preserveSelection: true });
            }
        },

        async markSubtreeChanged() {
            deps.workspaceStore.setState((state) => ({
                ...state,
                hostSubtreeRefreshSeq: state.hostSubtreeRefreshSeq + 1,
            }));
            await runtime.syncReachableSubtreeSources();
            await runtime.rebuildGraph({ preserveSelection: true });
            runtime.scheduleTreeSelected(true);
        },

        async dismissReloadConflict() {
            clearDocumentReloadConflict(deps.documentStore);
        },

        async undo() {
            const current = deps.documentStore.getState();
            if (current.historyIndex <= 0) {
                return;
            }
            await runtime.applyHistoryIndex(current.historyIndex - 1);
        },

        async redo() {
            const current = deps.documentStore.getState();
            if (current.historyIndex >= current.history.length - 1) {
                return;
            }
            await runtime.applyHistoryIndex(current.historyIndex + 1);
        },

        async refreshGraph(opts?: { preserveSelection?: boolean }) {
            await runtime.rebuildGraph({
                preserveSelection: opts?.preserveSelection ?? true,
            });
        },

        async saveDocument() {
            const tree = deps.documentStore.getState().persistedTree;
            if (!tree) {
                return;
            }
            if (compareDocumentVersion(tree.version, VERSION) > 0) {
                deps.hostAdapter.log("warn", `[v2] refusing to save newer file version: ${tree.version}`);
                return;
            }
            const snapshot = runtime.getSerializedCurrentTree();
            if (!snapshot) {
                return;
            }
            const response = await deps.hostAdapter.saveDocument(snapshot);
            if (!response.success) {
                runtime.notifyError(response.error ?? "Save failed");
                return;
            }
            markDocumentSaved(deps.documentStore, snapshot);
        },

        async revertDocument() {
            const response = await deps.hostAdapter.revertDocument();
            if (!response.success) {
                runtime.notifyError(response.error ?? "Revert failed");
            }
        },

        async buildDocument(opts) {
            deps.hostAdapter.sendBuild(opts);
        },
    };
};
