import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAppHooksStore } from "../webview/shared/misc/hooks";
import { buildBehaviorProject, resolveBehaviorBuildPaths } from "../src/build/build-cli";
import { normalizeNodeDefCollection, parseWorkspaceModelContent } from "../webview/shared/schema";
import { loadSubtreeSourceCache } from "../webview/shared/subtree-source-cache";
import { materializePersistedTree } from "../webview/shared/tree-materializer";
import { collectTransitivePaths, parsePersistedTreeContent } from "../webview/shared/tree";

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
        name: "loads subtree sources and applies override precedence in materialization",
        async run() {
            const mainTree = parsePersistedTreeContent(
                JSON.stringify({
                    version: "2.0.0",
                    name: "main",
                    prefix: "M",
                    group: [],
                    import: [],
                    vars: [],
                    custom: {},
                    $override: {
                        leaf: {
                            desc: "from-main",
                        },
                    },
                    root: {
                        $id: "root",
                        id: "1",
                        name: "Wrapper",
                        children: [
                            {
                                $id: "subref",
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
                        import: [],
                        vars: [],
                        custom: {},
                        $override: {
                            leaf: {
                                desc: "from-subtree",
                            },
                        },
                        root: {
                            $id: "sub-root",
                            id: "1",
                            name: "SubtreeRoot",
                            children: [
                                {
                                    $id: "leaf",
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
                    import: [],
                    vars: [],
                    custom: {},
                    $override: {},
                    root: {
                        $id: "root",
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
                        import: [],
                        vars: [],
                        custom: {},
                        $override: {},
                        root: {
                            $id: "root",
                            id: "1",
                            name: "Sequence",
                            children: [
                                {
                                    $id: "leaf",
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
