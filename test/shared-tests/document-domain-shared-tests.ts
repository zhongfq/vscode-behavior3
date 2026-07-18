import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DocumentSessionState } from "../../src/editor-session/document/document-session-state";
import { handleNativeWheelZoom } from "../../webview/adapters/graph/g6-wheel-zoom";
import {
    preparePersistedTreeForMainDocumentSave,
    serializePersistedTreeForMainDocumentSave,
} from "../../webview/domain/main-document-save";
import { DOCUMENT_VERSION } from "../../webview/shared/b3type";
import type { NodeDef, PersistedTreeModel } from "../../webview/shared/contracts";
import { reduceDocumentMutation } from "../../webview/shared/document";
import { parseWorkdirRelativeJsonPath } from "../../webview/shared/protocol";
import { parseNodeDefsContent, parseWorkspaceModelContent } from "../../webview/shared/schema";
import {
    parsePersistedTreeContent,
    pruneStaleSubtreeOverrides,
    serializePersistedTree,
} from "../../webview/shared/tree";
import { createTestTree } from "../shared-test-fixtures";
import { defineSharedTests } from "../shared-test-types";

export const documentDomainSharedTests = defineSharedTests([
    {
        name: "replays host document session undo and redo from snapshot history",
        run() {
            const session = new DocumentSessionState({ initialContent: "A" });

            assert.equal(session.applyCommittedSnapshot("B"), true);
            assert.equal(session.applyCommittedSnapshot("C"), true);
            assert.equal(session.canUndo(), true);
            assert.equal(session.canRedo(), false);
            assert.equal(session.undo(), "B");
            assert.deepEqual(session.getSnapshot(), {
                dirty: true,
                historyIndex: 1,
                historyLength: 3,
                lastSavedSnapshot: "A",
                alertReload: false,
                pendingExternalContent: null,
            });
            assert.equal(session.canRedo(), true);
            assert.equal(session.redo(), "C");
            assert.equal(session.getCurrentSnapshot(), "C");
        },
    },
    {
        name: "clears host document dirty when undo returns to the saved snapshot",
        run() {
            const session = new DocumentSessionState({ initialContent: "A" });

            session.applyCommittedSnapshot("B");
            session.markSaved("B");
            session.applyCommittedSnapshot("C");
            session.showReloadConflict("disk");

            assert.equal(session.undo(), "B");
            assert.deepEqual(session.getSnapshot(), {
                dirty: false,
                historyIndex: 1,
                historyLength: 3,
                lastSavedSnapshot: "B",
                alertReload: false,
                pendingExternalContent: null,
            });
        },
    },
    {
        name: "replaces current host history snapshot when save normalizes content",
        run() {
            const session = new DocumentSessionState({ initialContent: "A" });

            session.applyCommittedSnapshot("B");
            session.markSaved("B*");

            assert.equal(session.undo(), "A");
            assert.equal(session.redo(), "B*");
            assert.deepEqual(session.getSnapshot(), {
                dirty: false,
                historyIndex: 1,
                historyLength: 2,
                lastSavedSnapshot: "B*",
                alertReload: false,
                pendingExternalContent: null,
            });
        },
    },
    {
        name: "prunes stale subtree overrides when reachable subtree graph is complete",
        run() {
            const linkedPath = parseWorkdirRelativeJsonPath("sub/tree.json");
            assert.ok(linkedPath);

            const tree = createTestTree();
            tree.root.children = [
                {
                    uuid: "link-root",
                    id: "2",
                    name: "LinkNode",
                    path: linkedPath,
                },
            ];
            tree.overrides = {
                "sub-child": { desc: "keep" },
                stale: { desc: "drop" },
            };

            const subtree: PersistedTreeModel = {
                version: "2.0.0",
                name: "tree",
                prefix: "",
                export: true,
                group: [],
                variables: {
                    imports: [],
                    locals: [],
                },
                custom: {},
                overrides: {},
                root: {
                    uuid: "sub-root",
                    id: "1",
                    name: "Sequence",
                    children: [
                        {
                            uuid: "sub-child",
                            id: "2",
                            name: "Action",
                        },
                    ],
                },
            };

            const changed = pruneStaleSubtreeOverrides({
                tree,
                subtreeSources: {
                    [linkedPath]: subtree,
                } as any,
            });

            assert.equal(changed, true);
            assert.deepEqual(tree.overrides, {
                "sub-child": { desc: "keep" },
            });
        },
    },
    {
        name: "keeps subtree overrides when reachable subtree graph is incomplete",
        run() {
            const linkedPath = parseWorkdirRelativeJsonPath("sub/tree.json");
            assert.ok(linkedPath);

            const tree = createTestTree();
            tree.root.children = [
                {
                    uuid: "link-root",
                    id: "2",
                    name: "LinkNode",
                    path: linkedPath,
                },
            ];
            tree.overrides = {
                "sub-child": { desc: "keep" },
                stale: { desc: "keep-too" },
            };

            const changed = pruneStaleSubtreeOverrides({
                tree,
                subtreeSources: {
                    [linkedPath]: null,
                } as any,
            });

            assert.equal(changed, false);
            assert.deepEqual(tree.overrides, {
                "sub-child": { desc: "keep" },
                stale: { desc: "keep-too" },
            });
        },
    },
    {
        name: "writes current main-tree display ids during main-document save serialization",
        async run() {
            const linkedPath = parseWorkdirRelativeJsonPath("sub/tree.json");
            assert.ok(linkedPath);
            const tree: PersistedTreeModel = {
                version: "2.0.0",
                name: "main",
                prefix: "",
                export: true,
                group: [],
                variables: {
                    imports: [],
                    locals: [],
                },
                custom: {},
                overrides: {},
                root: {
                    uuid: "root",
                    id: "1",
                    name: "Sequence",
                    children: [
                        {
                            uuid: "child-1",
                            id: "",
                            name: "ActionA",
                            children: [],
                        },
                        {
                            uuid: "child-2",
                            id: "",
                            name: "LinkNode",
                            path: linkedPath,
                            children: [],
                        },
                    ],
                },
            };

            const subtree = serializePersistedTree({
                version: "2.0.0",
                name: "tree",
                prefix: "",
                export: true,
                group: [],
                variables: {
                    imports: [],
                    locals: [],
                },
                custom: {},
                overrides: {},
                root: {
                    uuid: "sub-root",
                    id: "1",
                    name: "SubSequence",
                    children: [
                        {
                            uuid: "sub-child",
                            id: "2",
                            name: "SubAction",
                        },
                    ],
                },
            });

            const content = await serializePersistedTreeForMainDocumentSave({
                tree,
                nodeDefs: [
                    {
                        name: "Sequence",
                        type: "Composite",
                        desc: "",
                        status: ["success"],
                    },
                    {
                        name: "ActionA",
                        type: "Action",
                        desc: "",
                    },
                    {
                        name: "LinkNode",
                        type: "Action",
                        desc: "",
                    },
                    {
                        name: "SubSequence",
                        type: "Composite",
                        desc: "",
                        status: ["success"],
                    },
                    {
                        name: "SubAction",
                        type: "Action",
                        desc: "",
                    },
                ],
                readSubtreeContent: async (path) => {
                    assert.equal(path, "sub/tree.json");
                    return subtree;
                },
            });
            const savedJson = JSON.parse(content) as {
                root: {
                    children?: Array<{
                        children?: unknown[];
                    }>;
                };
            };

            const savedTree = parsePersistedTreeContent(content, "/tmp/main.json");
            assert.equal(savedTree.root.children?.[0]?.id, "2");
            assert.equal(savedTree.root.children?.[1]?.id, "3");
            assert.equal(savedJson.root.children?.[0]?.children, undefined);
            assert.equal(savedTree.root.children?.[1]?.children, undefined);
        },
    },
    {
        name: "prunes stale subtree overrides during main-document save serialization",
        async run() {
            const tree = createTestTree();
            tree.overrides = {
                orphaned: {
                    desc: "stale",
                },
            };

            const content = await serializePersistedTreeForMainDocumentSave({
                tree,
                nodeDefs: [],
                readSubtreeContent: async () => {
                    throw new Error(
                        "save should not read subtree content when no subtree links exist"
                    );
                },
            });

            const savedTree = parsePersistedTreeContent(content, "/tmp/main.json");
            assert.deepEqual(savedTree.overrides, {});
        },
    },
    {
        name: "omits empty children arrays during persisted tree serialization",
        run() {
            const tree = createTestTree();
            tree.root.children = [
                {
                    uuid: "leaf",
                    id: "2",
                    name: "LeafAction",
                    children: [],
                },
                {
                    uuid: "branch",
                    id: "3",
                    name: "Sequence",
                    children: [
                        {
                            uuid: "grandchild",
                            id: "4",
                            name: "NestedAction",
                            children: [],
                        },
                    ],
                },
            ];

            const serializedTree = JSON.parse(serializePersistedTree(tree)) as {
                root: {
                    children?: Array<{
                        children?: unknown[];
                    }>;
                };
            };
            const branchChildren = serializedTree.root.children?.[1]?.children as
                | Array<{ children?: unknown[] }>
                | undefined;

            assert.equal(Array.isArray(serializedTree.root.children), true);
            assert.equal(serializedTree.root.children?.[0]?.children, undefined);
            assert.equal(Array.isArray(serializedTree.root.children?.[1]?.children), true);
            assert.equal(branchChildren?.[0]?.children, undefined);
        },
    },
    {
        name: "stages legacy subtree normalization for missing version and stable ids",
        async run() {
            const linkedPath = parseWorkdirRelativeJsonPath("sub/tree.json");
            assert.ok(linkedPath);
            const tree: PersistedTreeModel = {
                version: "2.0.0",
                name: "main",
                prefix: "",
                export: true,
                group: [],
                variables: {
                    imports: [],
                    locals: [],
                },
                custom: {},
                overrides: {},
                root: {
                    uuid: "root",
                    id: "1",
                    name: "Sequence",
                    children: [
                        {
                            uuid: "child",
                            id: "2",
                            name: "LinkNode",
                            path: linkedPath,
                        },
                    ],
                },
            };
            const legacySubtree = JSON.stringify({
                name: "tree",
                prefix: "",
                export: true,
                group: [],
                variables: {
                    imports: [],
                    locals: [],
                },
                custom: {},
                overrides: {},
                root: {
                    id: "1",
                    name: "SubSequence",
                    children: [
                        {
                            id: "2",
                            name: "SubAction",
                        },
                    ],
                },
            });

            const buildPlan = () =>
                preparePersistedTreeForMainDocumentSave({
                    tree,
                    nodeDefs: [
                        {
                            name: "Sequence",
                            type: "Composite",
                            desc: "",
                            status: ["success"],
                        },
                        {
                            name: "LinkNode",
                            type: "Action",
                            desc: "",
                        },
                        {
                            name: "SubSequence",
                            type: "Composite",
                            desc: "",
                            status: ["success"],
                        },
                        {
                            name: "SubAction",
                            type: "Action",
                            desc: "",
                        },
                    ],
                    readSubtreeContent: async (path) => {
                        assert.equal(path, linkedPath);
                        return legacySubtree;
                    },
                });

            const firstPlan = await buildPlan();
            const secondPlan = await buildPlan();

            assert.equal(firstPlan.subtreeWritebacks.length, 1);
            assert.equal(firstPlan.subtreeWritebacks[0]?.path, linkedPath);
            assert.equal(
                firstPlan.subtreeWritebacks[0]?.content,
                secondPlan.subtreeWritebacks[0]?.content
            );

            const normalizedSubtree = parsePersistedTreeContent(
                firstPlan.subtreeWritebacks[0]!.content,
                linkedPath
            );
            assert.equal(normalizedSubtree.version, DOCUMENT_VERSION);
            assert.ok(normalizedSubtree.root.uuid);
            assert.ok(normalizedSubtree.root.children?.[0]?.uuid);
        },
    },
    {
        name: "reduces tree meta mutations in shared host reducer",
        run() {
            const tree = createTestTree();
            const result = reduceDocumentMutation(
                {
                    type: "updateTreeMeta",
                    payload: {
                        desc: "updated",
                        prefix: "BT",
                        export: true,
                        group: ["combat"],
                        variables: {
                            imports: ["vars/b.json", "vars/a.json"],
                            locals: [
                                { name: "zeta", desc: "Z" },
                                { name: "alpha", desc: "A" },
                            ],
                        },
                    },
                },
                {
                    tree,
                    nodeDefs: [],
                }
            );

            assert.equal(result.status, "changed");
            if (result.status !== "changed") {
                return;
            }

            assert.equal(result.rebuildGraph, true);
            assert.deepEqual(result.tree.variables.imports, ["vars/a.json", "vars/b.json"]);
            assert.deepEqual(
                result.tree.variables.locals.map((entry) => entry.name),
                ["alpha", "zeta"]
            );
        },
    },
    {
        name: "reduces tree custom metadata mutations without rebuilding graph",
        run() {
            const tree = createTestTree();
            tree.custom = {
                legacy: "keep",
            };

            const result = reduceDocumentMutation(
                {
                    type: "updateTreeMeta",
                    payload: {
                        desc: tree.desc,
                        prefix: tree.prefix,
                        export: tree.export,
                        group: [...tree.group],
                        custom: {
                            label: "hero",
                            enabled: true,
                            threshold: 3,
                        },
                        variables: {
                            imports: [...tree.variables.imports],
                            locals: tree.variables.locals.map((entry) => ({ ...entry })),
                        },
                    },
                },
                {
                    tree,
                    nodeDefs: [],
                }
            );

            assert.equal(result.status, "changed");
            if (result.status !== "changed") {
                return;
            }

            assert.equal(result.rebuildGraph, false);
            assert.deepEqual(result.tree.custom, {
                label: "hero",
                enabled: true,
                threshold: 3,
            });
        },
    },
    {
        name: "reduces subtree override node mutations in shared host reducer",
        run() {
            const tree = createTestTree();
            const nodeDefs: NodeDef[] = [
                {
                    name: "Wait",
                    type: "Action",
                    desc: "",
                    args: [{ name: "time", type: "int", desc: "" }],
                },
            ];

            const result = reduceDocumentMutation(
                {
                    type: "updateNode",
                    payload: {
                        target: {
                            instanceKey: "node-1",
                            displayId: "2",
                            structuralStableId: "sub-node",
                            sourceStableId: "sub-node",
                            sourceTreePath: "subtree/child.json" as any,
                            subtreeStack: [],
                        },
                        data: {
                            name: "Wait",
                            args: { time: 2 },
                        },
                        currentNodeSnapshot: {
                            data: {
                                uuid: "sub-node",
                                id: "2",
                                name: "Wait",
                                args: { time: 1 },
                            },
                            subtreeNode: true,
                            subtreeOriginal: {
                                uuid: "sub-node",
                                id: "2",
                                name: "Wait",
                                args: { time: 1 },
                            },
                        },
                    },
                },
                {
                    tree,
                    nodeDefs,
                }
            );

            assert.equal(result.status, "changed");
            if (result.status !== "changed") {
                return;
            }

            assert.deepEqual(result.tree.overrides["sub-node"], {
                args: { time: 2 },
            });
        },
    },
    {
        name: "prunes stale schema fields from normal node updates in shared host reducer",
        run() {
            const tree = createTestTree();
            tree.root.children = [
                {
                    uuid: "child-a",
                    id: "2",
                    name: "TestVisibleAndChecker",
                    args: {
                        health: 3,
                        type: 1,
                        类型: 1,
                        血量: 1,
                    },
                },
            ];

            const nodeDefs: NodeDef[] = [
                {
                    name: "TestVisibleAndChecker",
                    type: "Action",
                    desc: "",
                    args: [
                        { name: "health", type: "int", desc: "" },
                        { name: "type", type: "int", desc: "" },
                    ],
                },
            ];

            const result = reduceDocumentMutation(
                {
                    type: "updateNode",
                    payload: {
                        target: {
                            instanceKey: "node-1",
                            displayId: "2",
                            structuralStableId: "child-a",
                            sourceStableId: "child-a",
                            sourceTreePath: null,
                            subtreeStack: [],
                        },
                        data: {
                            name: "TestVisibleAndChecker",
                            args: {
                                health: 4,
                                type: 2,
                                类型: 1,
                                血量: 1,
                            },
                        },
                        currentNodeSnapshot: {
                            data: {
                                uuid: "child-a",
                                id: "2",
                                name: "TestVisibleAndChecker",
                                args: {
                                    health: 3,
                                    type: 1,
                                    类型: 1,
                                    血量: 1,
                                },
                            },
                            subtreeNode: false,
                        },
                    },
                },
                {
                    tree,
                    nodeDefs,
                }
            );

            assert.equal(result.status, "changed");
            if (result.status !== "changed") {
                return;
            }

            assert.deepEqual(result.tree.root.children?.[0]?.args, {
                health: 4,
                type: 2,
            });
        },
    },
    {
        name: "does not persist default-only subtree args into overrides",
        run() {
            const tree = createTestTree();
            const nodeDefs: NodeDef[] = [
                {
                    name: "TryLaunchSkill",
                    type: "Action",
                    desc: "",
                    args: [
                        {
                            name: "skip_cd",
                            type: "bool?",
                            desc: "",
                            default: false,
                        },
                    ],
                },
            ];

            const result = reduceDocumentMutation(
                {
                    type: "updateNode",
                    payload: {
                        target: {
                            instanceKey: "node-1",
                            displayId: "2",
                            structuralStableId: "sub-node",
                            sourceStableId: "sub-node",
                            sourceTreePath: "subtree/child.json" as any,
                            subtreeStack: [],
                        },
                        data: {
                            name: "TryLaunchSkill",
                            desc: "updated",
                            args: { skip_cd: false },
                        },
                        currentNodeSnapshot: {
                            data: {
                                uuid: "sub-node",
                                id: "2",
                                name: "TryLaunchSkill",
                                desc: "",
                                args: { skip_cd: false },
                            },
                            subtreeNode: true,
                            subtreeOriginal: {
                                uuid: "sub-node",
                                id: "2",
                                name: "TryLaunchSkill",
                                desc: "",
                                args: { skip_cd: false },
                            },
                        },
                    },
                },
                {
                    tree,
                    nodeDefs,
                }
            );

            assert.equal(result.status, "changed");
            if (result.status !== "changed") {
                return;
            }

            assert.deepEqual(result.tree.overrides["sub-node"], {
                desc: "updated",
            });
        },
    },
    {
        name: "does not persist default-only subtree args when original omits defaults",
        run() {
            const tree = createTestTree();
            const nodeDefs: NodeDef[] = [
                {
                    name: "TryLaunchSkill",
                    type: "Action",
                    desc: "",
                    args: [
                        {
                            name: "skip_cd",
                            type: "bool?",
                            desc: "",
                            default: false,
                        },
                    ],
                },
            ];

            const result = reduceDocumentMutation(
                {
                    type: "updateNode",
                    payload: {
                        target: {
                            instanceKey: "node-1",
                            displayId: "2",
                            structuralStableId: "sub-node",
                            sourceStableId: "sub-node",
                            sourceTreePath: "subtree/child.json" as any,
                            subtreeStack: [],
                        },
                        data: {
                            name: "TryLaunchSkill",
                            desc: "updated",
                            args: { skip_cd: false },
                        },
                        currentNodeSnapshot: {
                            data: {
                                uuid: "sub-node",
                                id: "2",
                                name: "TryLaunchSkill",
                                desc: "",
                                args: { skip_cd: false },
                            },
                            subtreeNode: true,
                            subtreeOriginal: {
                                uuid: "sub-node",
                                id: "2",
                                name: "TryLaunchSkill",
                                desc: "",
                            },
                        },
                    },
                },
                {
                    tree,
                    nodeDefs,
                }
            );

            assert.equal(result.status, "changed");
            if (result.status !== "changed") {
                return;
            }

            assert.deepEqual(result.tree.overrides["sub-node"], {
                desc: "updated",
            });
        },
    },
    {
        name: "persists subtree debug override when turning true off",
        run() {
            const tree = createTestTree();
            const nodeDefs: NodeDef[] = [
                {
                    name: "Wait",
                    type: "Action",
                    desc: "",
                },
            ];

            const result = reduceDocumentMutation(
                {
                    type: "updateNode",
                    payload: {
                        target: {
                            instanceKey: "node-debug",
                            displayId: "2",
                            structuralStableId: "sub-node",
                            sourceStableId: "sub-node",
                            sourceTreePath: "subtree/child.json" as any,
                            subtreeStack: [],
                        },
                        data: {
                            name: "Wait",
                            debug: false,
                            disabled: false,
                        },
                        currentNodeSnapshot: {
                            data: {
                                uuid: "sub-node",
                                id: "2",
                                name: "Wait",
                                debug: true,
                            },
                            subtreeNode: true,
                            subtreeOriginal: {
                                uuid: "sub-node",
                                id: "2",
                                name: "Wait",
                                debug: true,
                            },
                        },
                    },
                },
                {
                    tree,
                    nodeDefs,
                }
            );

            assert.equal(result.status, "changed");
            if (result.status !== "changed") {
                return;
            }

            assert.deepEqual(result.tree.overrides["sub-node"], {
                debug: false,
            });
        },
    },
    {
        name: "persists subtree disabled override when turning true off",
        run() {
            const tree = createTestTree();
            const nodeDefs: NodeDef[] = [
                {
                    name: "Wait",
                    type: "Action",
                    desc: "",
                },
            ];

            const result = reduceDocumentMutation(
                {
                    type: "updateNode",
                    payload: {
                        target: {
                            instanceKey: "node-disabled",
                            displayId: "2",
                            structuralStableId: "sub-node",
                            sourceStableId: "sub-node",
                            sourceTreePath: "subtree/child.json" as any,
                            subtreeStack: [],
                        },
                        data: {
                            name: "Wait",
                            debug: false,
                            disabled: false,
                        },
                        currentNodeSnapshot: {
                            data: {
                                uuid: "sub-node",
                                id: "2",
                                name: "Wait",
                                disabled: true,
                            },
                            subtreeNode: true,
                            subtreeOriginal: {
                                uuid: "sub-node",
                                id: "2",
                                name: "Wait",
                                disabled: true,
                            },
                        },
                    },
                },
                {
                    tree,
                    nodeDefs,
                }
            );

            assert.equal(result.status, "changed");
            if (result.status !== "changed") {
                return;
            }

            assert.deepEqual(result.tree.overrides["sub-node"], {
                disabled: false,
            });
        },
    },
    {
        name: "keeps explicit false subtree boolean overrides when editing another field",
        run() {
            const tree = createTestTree();
            const nodeDefs: NodeDef[] = [
                {
                    name: "Wait",
                    type: "Action",
                    desc: "",
                },
            ];

            const result = reduceDocumentMutation(
                {
                    type: "updateNode",
                    payload: {
                        target: {
                            instanceKey: "node-bool-desc",
                            displayId: "2",
                            structuralStableId: "sub-node",
                            sourceStableId: "sub-node",
                            sourceTreePath: "subtree/child.json" as any,
                            subtreeStack: [],
                        },
                        data: {
                            name: "Wait",
                            desc: "updated",
                            debug: false,
                            disabled: false,
                        },
                        currentNodeSnapshot: {
                            data: {
                                uuid: "sub-node",
                                id: "2",
                                name: "Wait",
                                desc: "",
                                debug: false,
                                disabled: false,
                            },
                            subtreeNode: true,
                            subtreeOriginal: {
                                uuid: "sub-node",
                                id: "2",
                                name: "Wait",
                                desc: "",
                                debug: true,
                                disabled: true,
                            },
                        },
                    },
                },
                {
                    tree,
                    nodeDefs,
                }
            );

            assert.equal(result.status, "changed");
            if (result.status !== "changed") {
                return;
            }

            assert.deepEqual(result.tree.overrides["sub-node"], {
                desc: "updated",
                debug: false,
                disabled: false,
            });
        },
    },
    {
        name: "reduces subtree detach mutations in shared host reducer",
        run() {
            const tree = createTestTree();
            tree.root.children = [
                {
                    uuid: "sub-root",
                    id: "2",
                    name: "SubtreeRef",
                    path: "subtree/child.json" as any,
                },
            ];

            const result = reduceDocumentMutation(
                {
                    type: "updateNode",
                    payload: {
                        target: {
                            instanceKey: "node-1",
                            displayId: "2",
                            structuralStableId: "sub-root",
                            sourceStableId: "sub-root",
                            sourceTreePath: null,
                            subtreeStack: [],
                        },
                        data: {
                            name: "Sequence",
                        },
                        currentNodeSnapshot: {
                            data: {
                                uuid: "sub-root",
                                id: "2",
                                name: "SubtreeRef",
                                path: "subtree/child.json" as any,
                            },
                            subtreeNode: false,
                        },
                        detachedSubtreeRoot: {
                            uuid: "sub-root",
                            id: "2",
                            name: "Sequence",
                            children: [
                                {
                                    uuid: "leaf-1",
                                    id: "3",
                                    name: "ActionA",
                                },
                            ],
                        },
                    },
                },
                {
                    tree,
                    nodeDefs: [],
                }
            );

            assert.equal(result.status, "changed");
            if (result.status !== "changed") {
                return;
            }

            const detached = result.tree.root.children?.[0];
            assert.equal(detached?.name, "Sequence");
            assert.equal(detached?.path, undefined);
            assert.equal(detached?.children?.[0]?.uuid, "leaf-1");
        },
    },
    {
        name: "reduces canvas insert and delete mutations in shared host reducer",
        run() {
            const tree = createTestTree();
            tree.root.children = [
                {
                    uuid: "child-a",
                    id: "2",
                    name: "ActionA",
                },
            ];

            const insertResult = reduceDocumentMutation(
                {
                    type: "insertNode",
                    payload: {
                        target: {
                            instanceKey: "1",
                            displayId: "1",
                            structuralStableId: "root",
                            sourceStableId: "root",
                            sourceTreePath: null,
                            subtreeStack: [],
                        },
                    },
                },
                {
                    tree,
                    nodeDefs: [],
                }
            );

            assert.equal(insertResult.status, "changed");
            if (insertResult.status !== "changed") {
                return;
            }

            const inserted = insertResult.tree.root.children?.[1];
            assert.equal(inserted?.name, "unknown");
            assert.deepEqual(insertResult.nextSelection, {
                kind: "node",
                structuralStableId: inserted?.uuid,
            });

            const deleteResult = reduceDocumentMutation(
                {
                    type: "deleteNode",
                    payload: {
                        target: {
                            instanceKey: "2",
                            displayId: "2",
                            structuralStableId: "child-a",
                            sourceStableId: "child-a",
                            sourceTreePath: null,
                            subtreeStack: [],
                        },
                    },
                },
                {
                    tree: insertResult.tree,
                    nodeDefs: [],
                }
            );

            assert.equal(deleteResult.status, "changed");
            if (deleteResult.status !== "changed") {
                return;
            }

            assert.equal(
                deleteResult.tree.root.children?.some((node) => node.uuid === "child-a"),
                false
            );
            assert.deepEqual(deleteResult.nextSelection, {
                kind: "node",
                structuralStableId: "root",
            });
        },
    },
    {
        name: "reduces canvas drop and paste mutations in shared host reducer",
        run() {
            const tree = createTestTree();
            tree.root.children = [
                {
                    uuid: "child-a",
                    id: "2",
                    name: "ActionA",
                },
                {
                    uuid: "child-b",
                    id: "3",
                    name: "ActionB",
                },
            ];

            const dropResult = reduceDocumentMutation(
                {
                    type: "performDrop",
                    payload: {
                        source: {
                            instanceKey: "2",
                            displayId: "2",
                            structuralStableId: "child-a",
                            sourceStableId: "child-a",
                            sourceTreePath: null,
                            subtreeStack: [],
                        },
                        target: {
                            instanceKey: "3",
                            displayId: "3",
                            structuralStableId: "child-b",
                            sourceStableId: "child-b",
                            sourceTreePath: null,
                            subtreeStack: [],
                        },
                        position: "after",
                    },
                },
                {
                    tree,
                    nodeDefs: [],
                }
            );

            assert.equal(dropResult.status, "changed");
            if (dropResult.status !== "changed") {
                return;
            }

            assert.deepEqual(
                dropResult.tree.root.children?.map((node) => node.uuid),
                ["child-b", "child-a"]
            );
            assert.deepEqual(dropResult.nextSelection, {
                kind: "node",
                structuralStableId: "child-a",
            });

            const pasteResult = reduceDocumentMutation(
                {
                    type: "pasteNode",
                    payload: {
                        target: {
                            instanceKey: "1",
                            displayId: "1",
                            structuralStableId: "root",
                            sourceStableId: "root",
                            sourceTreePath: null,
                            subtreeStack: [],
                        },
                        snapshot: {
                            uuid: "clip-root",
                            id: "9",
                            name: "ClipboardAction",
                            children: [
                                {
                                    uuid: "clip-leaf",
                                    id: "10",
                                    name: "ClipboardLeaf",
                                },
                            ],
                        },
                    },
                },
                {
                    tree: dropResult.tree,
                    nodeDefs: [],
                }
            );

            assert.equal(pasteResult.status, "changed");
            if (pasteResult.status !== "changed") {
                return;
            }

            const pasted = pasteResult.tree.root.children?.[2];
            assert.equal(pasted?.name, "ClipboardAction");
            assert.notEqual(pasted?.uuid, "clip-root");
            assert.notEqual(pasted?.children?.[0]?.uuid, "clip-leaf");
            assert.deepEqual(pasteResult.nextSelection, {
                kind: "node",
                structuralStableId: pasted?.uuid,
            });
        },
    },
    {
        name: "dispatches native wheel zoom callbacks",
        run() {
            const zoomCalls: Array<{ ratio: number; origin: [number, number] | undefined }> = [];
            let prevented = 0;
            let stopped = 0;

            handleNativeWheelZoom({
                event: {
                    deltaX: 0,
                    deltaY: -20,
                    preventDefault() {
                        prevented += 1;
                    },
                    stopPropagation() {
                        stopped += 1;
                    },
                },
                isEnabled: () => true,
                getOrigin: () => [12, 24],
                async zoomTo(ratio, origin) {
                    zoomCalls.push({ ratio, origin });
                },
            });

            assert.equal(prevented, 1);
            assert.equal(stopped, 1);
            assert.equal(zoomCalls.length, 1);
            assert.equal(zoomCalls[0]?.ratio, 1.2);
            assert.deepEqual(zoomCalls[0]?.origin, [12, 24]);
        },
    },
    {
        name: "rejects unsafe tree import and subtree paths",
        run() {
            assert.throws(
                () =>
                    parsePersistedTreeContent(
                        JSON.stringify({
                            version: "2.0.0",
                            name: "main",
                            prefix: "",
                            group: [],
                            variables: {
                                imports: ["../vars.json"],
                                locals: [],
                            },
                            custom: {},
                            overrides: {},
                            root: {
                                uuid: "root",
                                id: "1",
                                name: "Sequence",
                                children: [],
                            },
                        }),
                        "main.json"
                    ),
                /workdir-relative .*json path/i
            );

            assert.throws(
                () =>
                    parsePersistedTreeContent(
                        JSON.stringify({
                            version: "2.0.0",
                            name: "main",
                            prefix: "",
                            group: [],
                            variables: {
                                imports: [],
                                locals: [],
                            },
                            custom: {},
                            overrides: {},
                            root: {
                                uuid: "root",
                                id: "1",
                                name: "Sequence",
                                path: "/tmp/sub.json",
                            },
                        }),
                        "main.json"
                    ),
                /workdir-relative .*json path/i
            );
        },
    },
    {
        name: "parses sample node config",
        run() {
            const defs = parseNodeDefsContent(
                fs.readFileSync(path.join(process.cwd(), "sample/node-config.b3-setting"), "utf-8")
            );

            assert.equal(
                defs.some((def) => def.name === "Attack"),
                true
            );
            assert.equal(
                defs.find((def) => def.name === "TestB3")?.args?.find((arg) => arg.name === "open")
                    ?.type,
                "bool"
            );
        },
    },
    {
        name: "parses workspace settings with node colors",
        run() {
            const workspace = parseWorkspaceModelContent(
                JSON.stringify({
                    settings: {
                        allowNewFunction: true,
                        checkExpr: true,
                        buildScript: "scripts/build.ts",
                        checkScripts: ["scripts/checkers/**/*.ts"],
                        nodeColors: {
                            Action: "#123456",
                        },
                    },
                })
            );

            assert.equal(workspace.settings.allowNewFunction, true);
            assert.equal(workspace.settings.checkExpr, true);
            assert.equal(workspace.settings.buildScript, "scripts/build.ts");
            assert.deepEqual(workspace.settings.checkScripts, ["scripts/checkers/**/*.ts"]);
            assert.equal(workspace.settings.nodeColors?.Action, "#123456");
        },
    },
    {
        name: "rejects invalid workspace check script patterns",
        run() {
            assert.throws(
                () =>
                    parseWorkspaceModelContent(
                        JSON.stringify({
                            settings: {
                                checkScripts: ["scripts/checkers/**/*.ts", ""],
                            },
                        })
                    ),
                /workspace settings\.checkScripts\[1\] must be a non-empty string/
            );
        },
    },
]);
