import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAppHooksStore } from "../webview/shared/misc/hooks";
import { createEditorController } from "../webview/commands/create-editor-controller";
import { createDocumentStore, showDocumentReloadConflict } from "../webview/stores/document-store";
import { createSelectionStore } from "../webview/stores/selection-store";
import { createWorkspaceStore } from "../webview/stores/workspace-store";
import { buildBehaviorProject, resolveBehaviorBuildPaths } from "../src/build/build-cli";
import { buildResolvedGraphModel } from "../webview/domain/graph-selectors";
import { collectResolvedNodeDiagnostics } from "../webview/domain/tree-validation";
import {
    normalizeNodeDefCollection,
    parseNodeDefsContent,
    parseWorkspaceModelContent,
} from "../webview/shared/schema";
import { loadSubtreeSourceCache } from "../webview/shared/subtree-source-cache";
import { materializePersistedTree } from "../webview/shared/tree-materializer";
import {
    collectTransitivePaths,
    parsePersistedTreeContent,
    serializePersistedTree,
} from "../webview/shared/tree";
import { parseWorkdirRelativeJsonPath } from "../webview/shared/protocol";
import type { GraphAdapter } from "../webview/shared/graph-contracts";
import type { HostAdapter } from "../webview/shared/contracts";

const tests: Array<{ name: string; run(): Promise<void> | void }> = [
    {
        name: "normalizes legacy node definitions",
        run() {
            const defs = normalizeNodeDefCollection({
                nodes: [
                    {
                        name: "Check",
                        type: "Condition",
                        desc: "legacy",
                        args: [{ name: "value", type: "code?", desc: "expr" }],
                    },
                ],
            });

            assert.equal(defs.length, 1);
            assert.equal(defs[0]?.args?.[0]?.type, "expr?");
        },
    },
    {
        name: "normalizes boolean node arg alias",
        run() {
            const defs = normalizeNodeDefCollection([
                {
                    name: "Flag",
                    type: "Action",
                    desc: "",
                    args: [{ name: "enabled", type: "boolean?", desc: "" }],
                },
            ]);

            assert.equal(defs[0]?.args?.[0]?.type, "bool?");
        },
    },
    {
        name: "parses only strict workdir-relative json paths",
        run() {
            assert.equal(parseWorkdirRelativeJsonPath("vars\\test.json"), "vars/test.json");
            assert.equal(parseWorkdirRelativeJsonPath("./sub/tree.json"), "sub/tree.json");
            assert.equal(parseWorkdirRelativeJsonPath("../escape.json"), null);
            assert.equal(parseWorkdirRelativeJsonPath("/absolute.json"), null);
            assert.equal(parseWorkdirRelativeJsonPath("C:\\absolute.json"), null);
            assert.equal(parseWorkdirRelativeJsonPath("tree.txt"), null);
            assert.equal(parseWorkdirRelativeJsonPath("http://example.com/tree.json"), null);
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
                        checkExpr: true,
                        buildScript: "scripts/build.ts",
                        nodeColors: {
                            Action: "#123456",
                        },
                    },
                })
            );

            assert.equal(workspace.settings.checkExpr, true);
            assert.equal(workspace.settings.buildScript, "scripts/build.ts");
            assert.equal(workspace.settings.nodeColors?.Action, "#123456");
        },
    },
    {
        name: "skips variable declaration checks when none are declared",
        run() {
            const graphModel = buildResolvedGraphModel(
                {
                    rootKey: "1",
                    nodeOrder: ["1"],
                    nodesByInstanceKey: {
                        "1": {
                            ref: {
                                instanceKey: "1",
                                displayId: "1",
                                structuralStableId: "root",
                                sourceStableId: "root",
                                sourceTreePath: null,
                                subtreeStack: [],
                            },
                            parentKey: null,
                            childKeys: [],
                            depth: 0,
                            renderedIdLabel: "1",
                            name: "Clear",
                            output: ["context"],
                            subtreeNode: false,
                            subtreeEditable: true,
                        },
                    },
                },
                [{ name: "Clear", type: "Action", desc: "", output: ["variable"] }],
                undefined,
                {
                    usingVars: {},
                    usingGroups: null,
                    checkExpr: true,
                }
            );

            assert.equal(graphModel.nodes[0]?.nodeStyleKind, "Action");

            const strictGraphModel = buildResolvedGraphModel(
                {
                    rootKey: "1",
                    nodeOrder: ["1"],
                    nodesByInstanceKey: {
                        "1": {
                            ref: {
                                instanceKey: "1",
                                displayId: "1",
                                structuralStableId: "root",
                                sourceStableId: "root",
                                sourceTreePath: null,
                                subtreeStack: [],
                            },
                            parentKey: null,
                            childKeys: [],
                            depth: 0,
                            renderedIdLabel: "1",
                            name: "Clear",
                            output: ["context"],
                            subtreeNode: false,
                            subtreeEditable: true,
                        },
                    },
                },
                [{ name: "Clear", type: "Action", desc: "", output: ["variable"] }],
                undefined,
                {
                    usingVars: {
                        target: { name: "target", desc: "" },
                    },
                    usingGroups: null,
                    checkExpr: true,
                }
            );

            assert.equal(strictGraphModel.nodes[0]?.nodeStyleKind, "Error");
        },
    },
    {
        name: "collects shared validation diagnostics for graph nodes",
        run() {
            const diagnostics = collectResolvedNodeDiagnostics({
                node: {
                    ref: {
                        instanceKey: "1",
                        displayId: "1",
                        structuralStableId: "root",
                        sourceStableId: "root",
                        sourceTreePath: null,
                        subtreeStack: [],
                    },
                    parentKey: null,
                    childKeys: [],
                    depth: 0,
                    renderedIdLabel: "1",
                    name: "Check",
                    input: ["missing"],
                    args: { expr: "missing > 0" },
                    subtreeNode: false,
                    subtreeEditable: true,
                },
                def: {
                    name: "Check",
                    type: "Condition",
                    desc: "",
                    input: ["target"],
                    args: [{ name: "expr", type: "expr", desc: "" }],
                },
                usingVars: {
                    target: { name: "target", desc: "" },
                },
                usingGroups: null,
                checkExpr: false,
            });

            assert.equal(
                diagnostics.some(
                    (entry) =>
                        entry.code === "undefined-variable" && entry.variable === "missing"
                ),
                true
            );
        },
    },
    {
        name: "normalizes legacy node $id and $override on open",
        run() {
            const tree = parsePersistedTreeContent(
                JSON.stringify({
                    version: "2.0.0",
                    name: "legacy",
                    prefix: "",
                    group: [],
                    import: ["vars/legacy.json"],
                    vars: [{ name: "legacyVar", desc: "legacy variable" }],
                    custom: {},
                    $override: {
                        "legacy-leaf": {
                            desc: "from-legacy",
                        },
                    },
                    root: {
                        $id: "legacy-root",
                        id: "1",
                        name: "Sequence",
                        children: [
                            {
                                $id: "legacy-leaf",
                                id: "2",
                                name: "Log",
                            },
                        ],
                    },
                }),
                "legacy.json"
            );

            assert.equal(tree.root.uuid, "legacy-root");
            assert.equal(tree.root.children?.[0]?.uuid, "legacy-leaf");
            assert.equal(tree.overrides["legacy-leaf"]?.desc, "from-legacy");
            assert.deepEqual(tree.variables.imports, ["vars/legacy.json"]);
            assert.deepEqual(tree.variables.locals, [
                { name: "legacyVar", desc: "legacy variable" },
            ]);

            const serialized = serializePersistedTree(tree);
            const serializedTree = JSON.parse(serialized) as Record<string, unknown>;
            assert.match(serialized, /"uuid": "legacy-root"/);
            assert.match(serialized, /"overrides"/);
            assert.deepEqual(serializedTree.variables, {
                imports: ["vars/legacy.json"],
                locals: [{ name: "legacyVar", desc: "legacy variable" }],
            });
            assert.equal(serializedTree.import, undefined);
            assert.equal(serializedTree.vars, undefined);
            assert.doesNotMatch(serialized, /"\$id"/);
            assert.doesNotMatch(serialized, /"\$override"/);
        },
    },
    {
        name: "parses migrated sample tree files with variables",
        run() {
            const sampleTreeFiles = [
                "sample/vars/declare-core.json",
                "sample/vars/declare-vars.json",
                "sample/vars/subtree.json",
                "sample/vars/test-subtree.json",
                "sample/vars/test-vars.json",
                "sample/workdir/hero.json",
                "sample/workdir/monster.json",
                "sample/workdir/sub/subtree1.json",
                "sample/workdir/sub/subtree2.json",
                "sample/workdir/subtree1.json",
                "sample/workdir/subtree2.json",
            ];

            for (const relativePath of sampleTreeFiles) {
                const tree = parsePersistedTreeContent(
                    fs.readFileSync(path.join(process.cwd(), relativePath), "utf-8"),
                    relativePath
                );

                assert.ok(Array.isArray(tree.variables.imports), relativePath);
                assert.ok(Array.isArray(tree.variables.locals), relativePath);

                const serializedTree = JSON.parse(serializePersistedTree(tree)) as Record<
                    string,
                    unknown
                >;
                assert.equal(serializedTree.import, undefined, relativePath);
                assert.equal(serializedTree.vars, undefined, relativePath);
            }
        },
    },
    {
        name: "loads subtree sources and applies override precedence in materialization",
        async run() {
            const mainTree = parsePersistedTreeContent(
                JSON.stringify({
                    version: "2.0.0",
                    name: "main",
                    prefix: "M",
                    group: [],
                    variables: {
                        imports: [],
                        locals: [],
                    },
                    custom: {},
                    overrides: {
                        leaf: {
                            desc: "from-main",
                        },
                    },
                    root: {
                        uuid: "root",
                        id: "1",
                        name: "Wrapper",
                        children: [
                            {
                                uuid: "subref",
                                id: "2",
                                name: "SubtreeRef",
                                path: "sub.json",
                            },
                        ],
                    },
                }),
                "main.json"
            );

            const subtreeSources = await loadSubtreeSourceCache({
                root: mainTree.root,
                readContent: async (relativePath) => {
                    if (relativePath !== "sub.json") {
                        return null;
                    }

                    return JSON.stringify({
                        version: "2.0.0",
                        name: "sub",
                        prefix: "",
                        group: [],
                        variables: {
                            imports: [],
                            locals: [],
                        },
                        custom: {},
                        overrides: {
                            leaf: {
                                desc: "from-subtree",
                            },
                        },
                        root: {
                            uuid: "sub-root",
                            id: "1",
                            name: "SubtreeRoot",
                            children: [
                                {
                                    uuid: "leaf",
                                    id: "2",
                                    name: "Leaf",
                                },
                            ],
                        },
                    });
                },
            });

            const root = materializePersistedTree({
                persistedTree: mainTree,
                subtreeSources,
                nodeDefs: [
                    {
                        name: "Wrapper",
                        type: "Composite",
                        desc: "",
                        status: ["|success"],
                    },
                    {
                        name: "SubtreeRef",
                        type: "Action",
                        desc: "",
                    },
                    {
                        name: "SubtreeRoot",
                        type: "Composite",
                        desc: "",
                        status: ["|success"],
                    },
                    {
                        name: "Leaf",
                        type: "Action",
                        desc: "",
                        status: ["success"],
                    },
                ],
                subtreeEditable: false,
            });

            assert.equal(root.children.length, 1);
            assert.equal(root.children[0]?.data.name, "SubtreeRoot");
            assert.equal(root.children[0]?.data.path, "sub.json");
            assert.equal(root.children[0]?.children[0]?.subtreeEditable, false);
            assert.equal(root.children[0]?.children[0]?.data.desc, "from-main");
            assert.equal(root.children[0]?.children[0]?.data.$status, 1 << 2);
            assert.equal(root.data.$status, 1 << 2);
        },
    },
    {
        name: "marks missing subtree references without crashing materialization",
        async run() {
            const mainTree = parsePersistedTreeContent(
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
                        name: "Missing",
                        path: "missing.json",
                    },
                }),
                "main.json"
            );

            const subtreeSources = await loadSubtreeSourceCache({
                root: mainTree.root,
                readContent: async () => null,
            });

            const root = materializePersistedTree({
                persistedTree: mainTree,
                subtreeSources,
                nodeDefs: [{ name: "Missing", type: "Action", desc: "" }],
                subtreeEditable: true,
            });

            assert.equal(root.resolutionError, "missing-subtree");
            assert.equal(root.children.length, 0);
        },
    },
    {
        name: "requires explicit tree file version",
        run() {
            assert.throws(
                () =>
                    parsePersistedTreeContent(
                        JSON.stringify({
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
                                children: [],
                            },
                        }),
                        "main.json"
                    ),
                /tree file version/i
            );
        },
    },
    {
        name: "collects transitive paths breadth-first without duplicates",
        async run() {
            const graph: Record<string, string[]> = {
                "root-a": ["child-a", "child-b"],
                "root-b": ["child-b", "child-c"],
                "child-a": ["leaf-a"],
                "child-b": ["leaf-a"],
                "child-c": [],
                "leaf-a": [],
            };

            const ordered = await collectTransitivePaths(["root-a", "root-b"], async (path) => {
                return graph[path] ?? [];
            });

            assert.deepEqual(ordered, [
                "root-a",
                "root-b",
                "child-a",
                "child-b",
                "child-c",
                "leaf-a",
            ]);
        },
    },
    {
        name: "binds and guards app hooks explicitly",
        run() {
            const hooks = createAppHooksStore();
            assert.throws(() => hooks.getMessage(), /not available/i);

            const fakeHooks = {
                message: { success() {}, error() {} } as any,
                notification: {} as any,
                modal: {} as any,
            };

            hooks.bind(fakeHooks);
            assert.equal(hooks.getMessage(), fakeHooks.message);
            assert.equal(hooks.getNotification(), fakeHooks.notification);
            assert.equal(hooks.getModal(), fakeHooks.modal);

            hooks.reset();
            assert.throws(() => hooks.getMessage(), /not available/i);
        },
    },
    {
        name: "routes boundary-only actions through controller commands",
        async run() {
            const documentStore = createDocumentStore();
            const workspaceStore = createWorkspaceStore();
            const selectionStore = createSelectionStore();
            const appHooks = createAppHooksStore();
            const errors: string[] = [];
            appHooks.bind({
                message: {
                    success() {},
                    error(value: string) {
                        errors.push(value);
                    },
                } as any,
                notification: {} as any,
                modal: {} as any,
            });

            let readPath: string | null = null;
            const hostAdapter: HostAdapter = {
                connect: () => () => {},
                sendReady() {},
                sendUpdate() {},
                sendTreeSelected() {},
                sendRequestSetting() {},
                sendBuild() {},
                async saveDocument() {
                    return { success: true };
                },
                async revertDocument() {
                    return { success: true };
                },
                async readFile(path) {
                    readPath = path;
                    return { content: "{}" };
                },
                async saveSubtree() {
                    return { success: true };
                },
                async saveSubtreeAs() {
                    return { savedPath: null };
                },
                log() {},
            };
            const graphAdapter: GraphAdapter = {
                async mount() {},
                unmount() {},
                async render() {},
                async applySelection() {},
                async applyHighlights() {},
                async applySearch() {},
                async focusNode() {},
                async restoreViewport() {},
                getViewport: () => ({ zoom: 1, x: 0, y: 0 }),
            };
            const controller = createEditorController({
                documentStore,
                workspaceStore,
                selectionStore,
                hostAdapter,
                graphAdapter,
                appHooks,
            });

            showDocumentReloadConflict(documentStore, "{}");
            await controller.dismissReloadConflict();
            assert.equal(documentStore.getState().alertReload, false);

            await controller.openSubtreePath("../escape.json");
            assert.equal(readPath, null);
            assert.equal(errors.length > 0, true);

            await controller.openSubtreePath("sub\\tree.json");
            assert.equal(readPath, "sub/tree.json");
        },
    },
    {
        name: "resolves pending host requests on disconnect",
        async run() {
            const testGlobal = globalThis as unknown as {
                window?: unknown;
                acquireVsCodeApi?: unknown;
            };
            const previousWindow = testGlobal.window;
            const previousAcquire = testGlobal.acquireVsCodeApi;
            const posts: unknown[] = [];
            const listeners = new Map<string, Set<EventListener>>();

            testGlobal.window = {
                setTimeout,
                clearTimeout,
                addEventListener(type: string, listener: EventListener) {
                    const entries = listeners.get(type) ?? new Set<EventListener>();
                    entries.add(listener);
                    listeners.set(type, entries);
                },
                removeEventListener(type: string, listener: EventListener) {
                    listeners.get(type)?.delete(listener);
                },
            };
            testGlobal.acquireVsCodeApi = () => ({
                postMessage(message: unknown) {
                    posts.push(message);
                },
                getState() {
                    return undefined;
                },
                setState() {},
            });

            const { getLogger, setLogger } = await import("../webview/shared/misc/logger");
            const previousLogger = getLogger();
            try {
                const { createVsCodeHostAdapter } = await import(
                    "../webview/adapters/host/vscode-host-adapter"
                );
                const adapter = createVsCodeHostAdapter();
                const off = adapter.connect(() => {});
                const resultPromise = adapter.readFile(parseWorkdirRelativeJsonPath("sub/a.json")!);

                assert.equal((posts[0] as { type?: string } | undefined)?.type, "readFile");
                off();

                const result = await resultPromise;
                assert.deepEqual(result, { content: null });
            } finally {
                setLogger(previousLogger);
                testGlobal.window = previousWindow;
                testGlobal.acquireVsCodeApi = previousAcquire;
            }
        },
    },
    {
        name: "resolves project files and builds from the CLI API",
        async run() {
            const root = fs.mkdtempSync(path.join(os.tmpdir(), "behavior3-cli-"));
            const workspaceFile = path.join(root, "workspace.b3-workspace");
            const settingFile = path.join(root, "node-config.b3-setting");
            const treeFile = path.join(root, "main.json");
            const outputDir = path.join(root, "dist");

            try {
                fs.writeFileSync(
                    workspaceFile,
                    JSON.stringify({
                        settings: {
                            checkExpr: true,
                        },
                    }),
                    "utf-8"
                );
                fs.writeFileSync(
                    settingFile,
                    JSON.stringify([
                        {
                            name: "Sequence",
                            type: "Composite",
                            desc: "",
                            children: -1,
                            status: ["|success"],
                        },
                        {
                            name: "Log",
                            type: "Action",
                            desc: "",
                        },
                    ]),
                    "utf-8"
                );
                fs.writeFileSync(
                    treeFile,
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
                            children: [
                                {
                                    uuid: "leaf",
                                    id: "2",
                                    name: "Log",
                                },
                            ],
                        },
                    }),
                    "utf-8"
                );

                const resolved = resolveBehaviorBuildPaths({
                    projectPath: treeFile,
                    outputDir,
                });

                assert.equal(resolved.workspaceFile, workspaceFile);
                assert.equal(resolved.settingFile, settingFile);
                assert.equal(resolved.workdir, root);
                assert.equal(resolved.outputDir, outputDir);

                const result = await buildBehaviorProject({
                    projectPath: treeFile,
                    outputDir,
                });

                assert.equal(result.hasError, false);
                assert.equal(fs.existsSync(path.join(outputDir, "main.json")), true);
            } finally {
                fs.rmSync(root, { recursive: true, force: true });
            }
        },
    },
    {
        name: "loads TypeScript build scripts with local TypeScript imports",
        async run() {
            const root = fs.mkdtempSync(path.join(os.tmpdir(), "behavior3-build-ts-import-"));
            const scriptsDir = path.join(root, "scripts");
            const workspaceFile = path.join(root, "workspace.b3-workspace");
            const settingFile = path.join(root, "node-config.b3-setting");
            const treeFile = path.join(root, "main.json");
            const buildScriptFile = path.join(scriptsDir, "build.ts");
            const helperFile = path.join(scriptsDir, "helper.ts");
            const constantsFile = path.join(scriptsDir, "constants.ts");
            const outputDir = path.join(root, "dist");

            try {
                fs.mkdirSync(scriptsDir, { recursive: true });
                fs.writeFileSync(
                    workspaceFile,
                    JSON.stringify({
                        settings: {
                            buildScript: "scripts/build.ts",
                        },
                    })
                );
                fs.writeFileSync(
                    settingFile,
                    JSON.stringify([
                        {
                            name: "Root",
                            type: "Composite",
                            desc: "",
                            children: -1,
                        },
                    ])
                );
                fs.writeFileSync(
                    treeFile,
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
                            name: "Root",
                            children: [],
                        },
                    })
                );
                fs.writeFileSync(
                    constantsFile,
                    [
                        'export const helperValue = "imported-helper";',
                        "export type HelperTree = { custom?: Record<string, unknown> };",
                        "",
                    ].join("\n")
                );
                fs.writeFileSync(
                    helperFile,
                    [
                        'import { helperValue, type HelperTree } from "./constants.ts";',
                        "",
                        "export function markTree(tree: HelperTree) {",
                        "  tree.custom = { ...(tree.custom ?? {}), helperValue };",
                        "}",
                        "",
                    ].join("\n")
                );
                fs.writeFileSync(
                    buildScriptFile,
                    [
                        'import { markTree } from "./helper.ts";',
                        "",
                        "export class Hook {",
                        "  onProcessTree(tree) {",
                        "    markTree(tree);",
                        "    return tree;",
                        "  }",
                        "}",
                        "",
                    ].join("\n")
                );

                const result = await buildBehaviorProject({
                    projectPath: treeFile,
                    outputDir,
                });
                const outputTree = JSON.parse(
                    fs.readFileSync(path.join(outputDir, "main.json"), "utf-8")
                );

                assert.equal(result.hasError, false);
                assert.equal(outputTree.custom.helperValue, "imported-helper");
            } finally {
                fs.rmSync(root, { recursive: true, force: true });
            }
        },
    },
    {
        name: "keeps sourcemapped TypeScript build script runtime modules in debug mode",
        async run() {
            const root = fs.mkdtempSync(path.join(os.tmpdir(), "behavior3-build-debug-"));
            const scriptsDir = path.join(root, "scripts");
            const workspaceFile = path.join(root, "workspace.b3-workspace");
            const settingFile = path.join(root, "node-config.b3-setting");
            const treeFile = path.join(root, "main.json");
            const buildScriptFile = path.join(scriptsDir, "build.ts");
            const helperFile = path.join(scriptsDir, "helper.ts");
            const outputDir = path.join(root, "dist");
            const previousDebug = process.env.BEHAVIOR3_BUILD_DEBUG;

            try {
                process.env.BEHAVIOR3_BUILD_DEBUG = "1";
                fs.mkdirSync(scriptsDir, { recursive: true });
                fs.writeFileSync(
                    workspaceFile,
                    JSON.stringify({
                        settings: {
                            buildScript: "scripts/build.ts",
                        },
                    })
                );
                fs.writeFileSync(
                    settingFile,
                    JSON.stringify([
                        {
                            name: "Root",
                            type: "Composite",
                            desc: "",
                            children: -1,
                        },
                    ])
                );
                fs.writeFileSync(
                    treeFile,
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
                            name: "Root",
                            children: [],
                        },
                    })
                );
                fs.writeFileSync(
                    helperFile,
                    [
                        'export const debugValue = "debug-helper";',
                        "export function markTree(tree) {",
                        "  tree.custom = { ...(tree.custom ?? {}), debugValue };",
                        "}",
                        "",
                    ].join("\n")
                );
                fs.writeFileSync(
                    buildScriptFile,
                    [
                        'import { markTree } from "./helper.ts";',
                        "",
                        "export class Hook {",
                        "  onProcessTree(tree) {",
                        "    markTree(tree);",
                        "    return tree;",
                        "  }",
                        "}",
                        "",
                    ].join("\n")
                );

                const result = await buildBehaviorProject({
                    projectPath: treeFile,
                    outputDir,
                });
                const outputTree = JSON.parse(
                    fs.readFileSync(path.join(outputDir, "main.json"), "utf-8")
                );
                const runtimeFiles = fs
                    .readdirSync(scriptsDir)
                    .filter((file) => file.includes(".runtime.") && file.endsWith(".mjs"));
                const runtimeContents = runtimeFiles.map((file) =>
                    fs.readFileSync(path.join(scriptsDir, file), "utf-8")
                );

                assert.equal(result.hasError, false);
                assert.equal(outputTree.custom.debugValue, "debug-helper");
                assert.equal(runtimeFiles.length >= 2, true);
                assert.equal(
                    runtimeContents.every((content) =>
                        content.includes("sourceMappingURL=data:application/json")
                    ),
                    true
                );
            } finally {
                if (previousDebug === undefined) {
                    delete process.env.BEHAVIOR3_BUILD_DEBUG;
                } else {
                    process.env.BEHAVIOR3_BUILD_DEBUG = previousDebug;
                }
                fs.rmSync(root, { recursive: true, force: true });
            }
        },
    },
    {
        name: "rejects legacy function-style build scripts",
        async run() {
            const root = fs.mkdtempSync(path.join(os.tmpdir(), "behavior3-build-hook-"));
            const workspaceFile = path.join(root, "workspace.b3-workspace");
            const settingFile = path.join(root, "node-config.b3-setting");
            const treeFile = path.join(root, "main.json");
            const buildScriptFile = path.join(root, "legacy-build.js");
            const outputDir = path.join(root, "dist");

            try {
                fs.writeFileSync(
                    workspaceFile,
                    JSON.stringify({
                        settings: {
                            buildScript: "legacy-build.js",
                        },
                    })
                );
                fs.writeFileSync(
                    settingFile,
                    JSON.stringify([
                        {
                            name: "Root",
                            type: "Composite",
                            desc: "",
                            children: -1,
                        },
                    ])
                );
                fs.writeFileSync(
                    treeFile,
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
                            name: "Root",
                            children: [],
                        },
                    })
                );
                fs.writeFileSync(
                    buildScriptFile,
                    ["export function onProcessTree(tree) {", "  return tree;", "}", ""].join("\n")
                );

                const result = await buildBehaviorProject({
                    projectPath: treeFile,
                    outputDir,
                });

                assert.equal(result.hasError, true);
                assert.equal(fs.existsSync(path.join(outputDir, "main.json")), true);
            } finally {
                fs.rmSync(root, { recursive: true, force: true });
            }
        },
    },
];

async function main() {
    for (const test of tests) {
        await test.run();
        console.log(`ok - ${test.name}`);
    }

    console.log(`${tests.length} shared tests passed`);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
