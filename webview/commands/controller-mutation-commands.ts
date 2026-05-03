import { VERSION } from "../shared/misc/b3type";
import { computeNodeOverride } from "../shared/misc/b3util";
import i18n from "../shared/misc/i18n";
import { stringifyJson } from "../shared/misc/stringify";
import { generateUuid } from "../shared/stable-id";
import type {
    DropIntent,
    EditorCommand,
    NodeDef,
    PersistedNodeModel,
    PersistedTreeModel,
    UpdateNodeInput,
    UpdateTreeMetaInput,
} from "../shared/contracts";
import { parseWorkdirRelativeJsonPath } from "../shared/protocol";
import {
    clonePersistedNode,
    clonePersistedTree,
    findPersistedNodeByStableId,
    serializePersistedTree,
} from "../shared/tree";
import { cloneVars, isJsonEqual, type ControllerRuntime } from "./controller-runtime";

type MutationCommandKeys =
    | "updateTreeMeta"
    | "updateNode"
    | "performDrop"
    | "copyNode"
    | "pasteNode"
    | "insertNode"
    | "replaceNode"
    | "deleteNode"
    | "openSubtreePath"
    | "openSelectedSubtree"
    | "saveSelectedAsSubtree";

export const createMutationCommands = (
    runtime: ControllerRuntime
): Pick<EditorCommand, MutationCommandKeys> => {
    const { deps } = runtime;

    const openSubtreePath = async (path: string) => {
        const subtreePath = parseWorkdirRelativeJsonPath(path);
        if (!subtreePath) {
            runtime.notifyError(i18n.t("validation.invalidJsonPath", { path }));
            return;
        }

        const response = await deps.hostAdapter.readFile(subtreePath, { openIfSubtree: true });
        if (response.content === null) {
            runtime.notifyError(i18n.t("node.subtreeOpenFailed", { path: subtreePath }));
        }
    };

    return {
        async updateTreeMeta(payload: UpdateTreeMetaInput) {
            const tree = deps.documentStore.getState().persistedTree;
            if (!tree) {
                return;
            }
            const nextDesc = payload.desc?.trim() || undefined;
            const nextPrefix = payload.prefix ?? "";
            const nextExport = payload.export !== false;
            const nextGroup = [...payload.group];
            const nextVars = cloneVars(payload.variables.locals).sort((a, b) =>
                a.name.localeCompare(b.name)
            );
            const nextImportRefs: NonNullable<typeof tree.variables>["imports"] = [];
            for (const rawPath of payload.variables.imports) {
                const parsedPath = parseWorkdirRelativeJsonPath(rawPath);
                if (!parsedPath) {
                    runtime.notifyError(i18n.t("validation.invalidJsonPath", { path: rawPath }));
                    return;
                }
                nextImportRefs.push(parsedPath);
            }
            nextImportRefs.sort((a, b) => a.localeCompare(b));

            if (
                tree.desc === nextDesc &&
                tree.prefix === nextPrefix &&
                (tree.export !== false) === nextExport &&
                isJsonEqual(tree.group, nextGroup) &&
                isJsonEqual(tree.variables.locals, nextVars) &&
                isJsonEqual(tree.variables.imports, nextImportRefs)
            ) {
                return;
            }

            const nextTree = clonePersistedTree(tree);
            nextTree.desc = nextDesc;
            nextTree.prefix = nextPrefix;
            nextTree.export = nextExport;
            nextTree.group = nextGroup;
            nextTree.variables = {
                imports: nextImportRefs,
                locals: nextVars,
            };
            await runtime.commitTreeMutation(nextTree, {
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
                runtime.getResolvedGraph()?.nodesByInstanceKey[payload.target.instanceKey] ?? null;
            if (!currentTree || !resolvedNode) {
                return;
            }

            const nextName =
                String(payload.data.name ?? resolvedNode.name).trim() || resolvedNode.name;
            const nextDesc = payload.data.desc?.trim() || undefined;
            const rawNextPath = payload.data.path?.trim() || undefined;
            let nextPath: PersistedNodeModel["path"];
            if (rawNextPath) {
                const parsedPath = parseWorkdirRelativeJsonPath(rawNextPath);
                if (!parsedPath) {
                    runtime.notifyError(i18n.t("validation.invalidJsonPath", { path: rawNextPath }));
                    return;
                }
                nextPath = parsedPath;
            }
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
                const def = runtime.getNodeDef(resolvedNode.name);
                const original = resolvedNode.subtreeOriginal;
                if (!original) {
                    return;
                }

                const editedNode: PersistedNodeModel = {
                    uuid: resolvedNode.ref.sourceStableId,
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
                    tree.overrides[payload.target.sourceStableId] = diff;
                } else {
                    delete tree.overrides[payload.target.sourceStableId];
                }

                await runtime.commitTreeMutation(tree);
                return;
            }

            const node = findPersistedNodeByStableId(tree.root, payload.target.structuralStableId);
            if (!node) {
                return;
            }

            const isDetachingSubtree = Boolean(selectedSnapshot?.data.path) && !payload.data.path;
            if (isDetachingSubtree) {
                const detached = runtime.buildPersistedNodeFromResolved(
                    payload.target.instanceKey,
                    {
                        clearPathOnRoot: true,
                    }
                );
                if (detached) {
                    detached.name = nextName;
                    detached.desc = nextDesc;
                    detached.args = nextArgs;
                    detached.input = nextInput;
                    detached.output = nextOutput;
                    detached.debug = nextDebug;
                    detached.disabled = nextDisabled;
                    runtime.overwritePersistedNode(node, detached);
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

            await runtime.commitTreeMutation(tree);
        },

        async performDrop(intent: DropIntent) {
            const currentTree = deps.documentStore.getState().persistedTree;
            const resolvedGraph = runtime.getResolvedGraph();
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
                runtime.isDescendantInstance(
                    sourceResolved.ref.instanceKey,
                    targetResolved.ref.instanceKey
                )
            ) {
                throw new Error(i18n.t("node.moveIntoDescendantDenied"));
            }

            const tree = clonePersistedTree(currentTree);
            const sourceLocation = runtime.findPersistedNodeLocationByStableId(
                tree.root,
                sourceResolved.ref.structuralStableId
            );
            const targetLocation = runtime.findPersistedNodeLocationByStableId(
                tree.root,
                targetResolved.ref.structuralStableId
            );

            if (!sourceLocation?.parent || !targetLocation) {
                return;
            }

            const sourceSiblings = sourceLocation.parent.children ?? [];
            const sourceIndex = sourceSiblings.findIndex(
                (entry) => entry.uuid === sourceLocation.node.uuid
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
                    (entry) => entry.uuid === targetLocation.node.uuid
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

            await runtime.commitTreeMutation(tree, {
                prepareSelection: () => {
                    runtime.selectResolvedNodeState(sourceResolved.ref.instanceKey);
                },
            });
        },

        async copyNode() {
            const selected = runtime.getSelectedResolvedNode();
            if (!selected) {
                runtime.notifyError(i18n.t("node.noNodeSelected"));
                return;
            }

            const snapshot = runtime.buildPersistedNodeFromResolved(selected.ref.instanceKey, {
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
            const selected = runtime.getSelectedResolvedNode();
            if (!currentTree || !selected) {
                runtime.notifyError(i18n.t("node.noNodeSelected"));
                return;
            }
            if (runtime.isSubtreeStructureLocked(selected)) {
                runtime.notifyError(i18n.t("node.editSubtreeDenied"));
                return;
            }

            const snapshot = await runtime.readClipboardNode();
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

            const nextNode = clonePersistedNode(snapshot);
            runtime.assignFreshStableIds(nextNode);
            targetNode.children ||= [];
            targetNode.children.push(nextNode);

            await runtime.commitTreeMutation(tree, {
                prepareSelection: () => {
                    runtime.selectPendingNodeState(nextNode.uuid);
                },
            });
        },

        async insertNode() {
            const currentTree = deps.documentStore.getState().persistedTree;
            const selected = runtime.getSelectedResolvedNode();
            if (!currentTree || !selected) {
                runtime.notifyError(i18n.t("node.noNodeSelected"));
                return;
            }
            if (runtime.isSubtreeStructureLocked(selected)) {
                runtime.notifyError(i18n.t("node.editSubtreeDenied"));
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
                uuid: generateUuid(),
                id: "",
                name: "unknown",
            };
            targetNode.children ||= [];
            targetNode.children.push(nextNode);

            await runtime.commitTreeMutation(tree, {
                prepareSelection: () => {
                    runtime.selectPendingNodeState(nextNode.uuid);
                },
            });
        },

        async replaceNode() {
            const currentTree = deps.documentStore.getState().persistedTree;
            const selected = runtime.getSelectedResolvedNode();
            if (!currentTree || !selected) {
                runtime.notifyError(i18n.t("node.noNodeSelected"));
                return;
            }
            if (runtime.isSubtreeStructureLocked(selected)) {
                runtime.notifyError(i18n.t("node.editSubtreeDenied"));
                return;
            }

            const snapshot = await runtime.readClipboardNode();
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

            const replacement = clonePersistedNode(snapshot);
            replacement.uuid = targetNode.uuid;
            for (const child of replacement.children ?? []) {
                runtime.assignFreshStableIds(child);
            }
            if (replacement.path) {
                replacement.children = undefined;
            }
            runtime.overwritePersistedNode(targetNode, replacement);

            await runtime.commitTreeMutation(tree, {
                prepareSelection: () => {
                    runtime.selectPendingNodeState(replacement.uuid);
                },
            });
        },

        async deleteNode() {
            const currentTree = deps.documentStore.getState().persistedTree;
            const selected = runtime.getSelectedResolvedNode();
            if (!currentTree || !selected) {
                return;
            }
            if (selected.parentKey === null) {
                runtime.notifyError(i18n.t("node.deleteRootNodeDenied"));
                return;
            }
            if (selected.subtreeNode) {
                runtime.notifyError(i18n.t("node.editSubtreeDenied"));
                return;
            }

            const tree = clonePersistedTree(currentTree);
            const location = runtime.findPersistedNodeLocationByStableId(
                tree.root,
                selected.ref.structuralStableId
            );
            if (!location?.parent?.children) {
                return;
            }

            location.parent.children = location.parent.children.filter(
                (entry) => entry.uuid !== location.node.uuid
            );
            const nextSelection = location.parent.uuid;

            await runtime.commitTreeMutation(tree, {
                prepareSelection: () => {
                    runtime.selectPendingNodeState(nextSelection);
                },
            });
        },

        openSubtreePath,

        async openSelectedSubtree() {
            const ref = deps.selectionStore.getState().selectedNodeRef;
            const resolvedGraph = runtime.getResolvedGraph();
            if (!ref || !resolvedGraph) {
                return;
            }
            const current = resolvedGraph.nodesByInstanceKey[ref.instanceKey];
            const lastSubtreePath =
                ref.subtreeStack.length > 0
                    ? ref.subtreeStack[ref.subtreeStack.length - 1]
                    : undefined;
            const path = current?.path ?? lastSubtreePath;
            if (!path) {
                return;
            }
            await openSubtreePath(path);
        },

        async saveSelectedAsSubtree() {
            const currentTree = deps.documentStore.getState().persistedTree;
            const selected = runtime.getSelectedResolvedNode();
            if (!currentTree || !selected) {
                runtime.notifyError(i18n.t("node.noNodeSelected"));
                return;
            }
            if (selected.parentKey === null) {
                runtime.notifyError(i18n.t("node.subtreeSaveRootError"));
                return;
            }
            if (runtime.isSubtreeStructureLocked(selected)) {
                runtime.notifyError(i18n.t("node.editSubtreeDenied"));
                return;
            }

            const subtreeRoot = runtime.buildPersistedNodeFromResolved(selected.ref.instanceKey, {
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
                variables: {
                    imports: [],
                    locals: [],
                },
                custom: {},
                overrides: {},
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

            const savedPath = parseWorkdirRelativeJsonPath(result.savedPath);
            if (!savedPath) {
                runtime.notifyError(i18n.t("validation.invalidJsonPath", { path: result.savedPath }));
                return;
            }

            targetNode.path = savedPath;
            targetNode.children = undefined;

            await runtime.commitTreeMutation(tree, {
                prepareSelection: () => {
                    runtime.selectPendingNodeState(targetNode.uuid);
                },
            });
            runtime.notifySuccess(i18n.t("node.subtreeSaveSuccess", { path: targetNode.path }));
        },
    };
};
