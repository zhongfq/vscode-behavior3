import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { buildResolvedGraphModel } from "../../webview/domain/graph-selectors";
import { buildTreeInspectorVariableUsageCount } from "../../webview/features/inspector/inspector-variable-options";
import { DOCUMENT_VERSION } from "../../webview/shared/b3type";
import type { NodeDef } from "../../webview/shared/contracts";
import { createNodeDefMap } from "../../webview/shared/node-utils";
import { parseWorkdirRelativeJsonPath } from "../../webview/shared/protocol";
import {
    collectTransitivePaths,
    loadSubtreeSourceCache,
    parsePersistedTreeContent,
    serializePersistedTree,
} from "../../webview/shared/tree";
import { materializePersistedTree } from "../../webview/shared/tree-materializer";
import {
    collectResolvedNodeDiagnostics,
    validateNodeArgValue,
} from "../../webview/shared/validation";
import { defineSharedTests } from "../shared-test-types";

export const validationMaterializationSharedTests = defineSharedTests([
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
        name: "does not mark graph subtree nodes overridden for default-only args",
        run() {
            const graphModel = buildResolvedGraphModel(
                {
                    rootKey: "1",
                    nodeOrder: ["1"],
                    nodesByInstanceKey: {
                        "1": {
                            ref: {
                                instanceKey: "1",
                                displayId: "56",
                                structuralStableId: "sub-node",
                                sourceStableId: "sub-node",
                                sourceTreePath: parseWorkdirRelativeJsonPath("sub.json"),
                                subtreeStack: [parseWorkdirRelativeJsonPath("sub.json")!],
                            },
                            parentKey: null,
                            childKeys: [],
                            depth: 0,
                            renderedIdLabel: "56",
                            name: "TryLaunchSkill",
                            args: { skip_cd: false },
                            subtreeNode: true,
                            subtreeEditable: true,
                            subtreeOriginal: {
                                uuid: "sub-node",
                                id: "56",
                                name: "TryLaunchSkill",
                            },
                        },
                    },
                },
                [
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
                ]
            );

            assert.equal(graphModel.nodes[0]?.hasOverride, false);
        },
    },
    {
        name: "marks graph nodes with custom checker diagnostics as errors",
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
                            name: "Wait",
                            args: { time: 0 },
                            subtreeNode: false,
                            subtreeEditable: true,
                        },
                    },
                },
                [
                    {
                        name: "Wait",
                        type: "Action",
                        desc: "",
                        args: [{ name: "time", type: "float", desc: "", checker: "positive" }],
                    },
                ],
                undefined,
                {
                    usingVars: null,
                    usingGroups: null,
                    checkExpr: true,
                    nodeFieldDiagnostics: {
                        "1": [
                            {
                                instanceKey: "1",
                                fieldKind: "arg",
                                fieldName: "time",
                                checker: "positive",
                                message: "must be greater than 0",
                            },
                        ],
                    },
                }
            );

            assert.equal(graphModel.nodes[0]?.nodeStyleKind, "Error");
        },
    },
    {
        name: "marks graph nodes with missing required args as errors",
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
                            name: "Wait",
                            args: {},
                            subtreeNode: false,
                            subtreeEditable: true,
                        },
                    },
                },
                [
                    {
                        name: "Wait",
                        type: "Action",
                        desc: "",
                        args: [{ name: "time", type: "float", desc: "时间" }],
                    },
                ],
                undefined,
                {
                    usingVars: null,
                    usingGroups: null,
                    checkExpr: true,
                }
            );

            assert.equal(graphModel.nodes[0]?.nodeStyleKind, "Error");
        },
    },
    {
        name: "collects shared validation diagnostics for graph nodes",
        run() {
            const diagnostics = collectResolvedNodeDiagnostics({
                node: {
                    name: "Check",
                    input: ["missing"],
                    args: { expr: "missing > 0" },
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
                    (entry) => entry.code === "undefined-variable" && entry.variable === "missing"
                ),
                true
            );
        },
    },
    {
        name: "collects required node arg diagnostics for missing values",
        run() {
            const diagnostics = collectResolvedNodeDiagnostics({
                node: {
                    name: "Wait",
                    args: {},
                },
                def: {
                    name: "Wait",
                    type: "Action",
                    desc: "",
                    args: [{ name: "time", type: "float", desc: "时间" }],
                },
                usingVars: null,
                usingGroups: null,
                checkExpr: true,
            });

            assert.equal(
                diagnostics.some(
                    (entry) => entry.code === "required-arg" && entry.argName === "time"
                ),
                true
            );
        },
    },
    {
        name: "collects oneof diagnostics for shared node validation",
        run() {
            const diagnostics = collectResolvedNodeDiagnostics({
                node: {
                    name: "Move",
                    input: ["enemy"],
                    args: { point: "manual" },
                },
                def: {
                    name: "Move",
                    type: "Action",
                    desc: "",
                    input: ["target?"],
                    args: [
                        {
                            name: "point",
                            type: "string?",
                            desc: "Point",
                            oneof: "target",
                        },
                    ],
                },
                usingVars: null,
                usingGroups: null,
                checkExpr: true,
            });

            assert.equal(
                diagnostics.some(
                    (entry) =>
                        entry.code === "oneof-conflict" &&
                        entry.argName === "point" &&
                        entry.inputLabel === "target"
                ),
                true
            );
        },
    },
    {
        name: "collects missing oneof input diagnostics for shared node validation",
        run() {
            const diagnostics = collectResolvedNodeDiagnostics({
                node: {
                    name: "Move",
                    args: { point: "manual" },
                },
                def: {
                    name: "Move",
                    type: "Action",
                    desc: "",
                    args: [
                        {
                            name: "point",
                            type: "string?",
                            desc: "Point",
                            oneof: "target",
                        },
                    ],
                },
                usingVars: null,
                usingGroups: null,
                checkExpr: true,
            });

            assert.deepEqual(diagnostics[0], {
                code: "missing-oneof-input",
                argName: "point",
                inputLabel: "target",
            });
        },
    },
    {
        name: "collects invalid child count diagnostics for fixed arity nodes",
        run() {
            const tooFewDiagnostics = collectResolvedNodeDiagnostics({
                node: {
                    name: "If",
                    children: [{}, {}],
                },
                def: {
                    name: "If",
                    type: "Composite",
                    desc: "",
                    children: 3,
                },
                usingVars: null,
                usingGroups: null,
                checkExpr: true,
            });
            const tooManyDiagnostics = collectResolvedNodeDiagnostics({
                node: {
                    name: "If",
                    children: [{}, {}, {}, {}],
                },
                def: {
                    name: "If",
                    type: "Composite",
                    desc: "",
                    children: 3,
                },
                usingVars: null,
                usingGroups: null,
                checkExpr: true,
            });
            const disabledDiagnostics = collectResolvedNodeDiagnostics({
                node: {
                    name: "If",
                    children: [{}, {}, {}, { disabled: true }],
                },
                def: {
                    name: "If",
                    type: "Composite",
                    desc: "",
                    children: 3,
                },
                usingVars: null,
                usingGroups: null,
                checkExpr: true,
            });

            assert.deepEqual(tooFewDiagnostics[0], {
                code: "invalid-children",
                expected: 3,
                actual: 2,
            });
            assert.deepEqual(tooManyDiagnostics[0], {
                code: "invalid-children",
                expected: 3,
                actual: 4,
            });
            assert.equal(disabledDiagnostics.length, 0);
        },
    },
    {
        name: "marks graph nodes with invalid child counts as errors",
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
                            name: "If",
                            children: [{}, {}],
                            subtreeNode: false,
                            subtreeEditable: true,
                        },
                    },
                },
                [{ name: "If", type: "Composite", desc: "", children: 3 }],
                undefined,
                {
                    usingVars: null,
                    usingGroups: null,
                    checkExpr: true,
                }
            );

            assert.equal(graphModel.nodes[0]?.nodeStyleKind, "Error");
        },
    },
    {
        name: "marks graph nodes with oneof conflicts as errors",
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
                            name: "Move",
                            input: ["enemy"],
                            args: { point: "manual" },
                            subtreeNode: false,
                            subtreeEditable: true,
                        },
                    },
                },
                [
                    {
                        name: "Move",
                        type: "Action",
                        desc: "",
                        input: ["target?"],
                        args: [
                            {
                                name: "point",
                                type: "string?",
                                desc: "Point",
                                oneof: "target",
                            },
                        ],
                    },
                ],
                undefined,
                {
                    usingVars: null,
                    usingGroups: null,
                    checkExpr: true,
                }
            );

            assert.equal(graphModel.nodes[0]?.nodeStyleKind, "Error");
        },
    },
    {
        name: "validates node arg scalar entries through shared validation",
        run() {
            const diagnostics = validateNodeArgValue({
                arg: { name: "weights", type: "float[]?", desc: "Weights" },
                value: [1, "bad"],
                validateOptions: false,
            });

            assert.equal(diagnostics[0]?.code, "invalid-arg-value");
            assert.equal(
                diagnostics[0]?.code === "invalid-arg-value" ? diagnostics[0].expected : undefined,
                "number"
            );
        },
    },
    {
        name: "validates node arg options through shared validation",
        run() {
            const diagnostics = validateNodeArgValue({
                arg: {
                    name: "mode",
                    type: "string",
                    desc: "Mode",
                    options: [{ source: [{ name: "A", value: "a" }] }],
                },
                value: "b",
                args: { mode: "b" },
            });

            assert.equal(diagnostics[0]?.code, "invalid-arg-option");
        },
    },
    {
        name: "does not treat required bool false as missing",
        run() {
            const diagnostics = collectResolvedNodeDiagnostics({
                node: {
                    name: "Flag",
                    args: { enabled: false },
                },
                def: {
                    name: "Flag",
                    type: "Action",
                    desc: "",
                    args: [{ name: "enabled", type: "bool", desc: "启用" }],
                },
                usingVars: null,
                usingGroups: null,
                checkExpr: true,
            });

            assert.equal(
                diagnostics.some((entry) => entry.code === "required-arg"),
                false
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
        name: "generates deterministic stable ids for legacy tree files",
        run() {
            const legacyContent = JSON.stringify({
                version: "2.0.0",
                name: "legacy",
                prefix: "",
                group: [],
                variables: {
                    imports: [],
                    locals: [],
                },
                custom: {},
                overrides: {},
                root: {
                    id: "1",
                    name: "Sequence",
                    children: [
                        {
                            id: "2",
                            name: "Log",
                        },
                    ],
                },
            });

            const first = parsePersistedTreeContent(legacyContent, "subtree/c.json");
            const second = parsePersistedTreeContent(legacyContent, "subtree/c.json");
            const differentFile = parsePersistedTreeContent(legacyContent, "subtree/d.json");

            assert.match(first.root.uuid, /^[0-9A-Za-z]{10}$/);
            assert.match(first.root.children?.[0]?.uuid ?? "", /^[0-9A-Za-z]{10}$/);
            assert.equal(first.root.uuid, second.root.uuid);
            assert.equal(first.root.children?.[0]?.uuid, second.root.children?.[0]?.uuid);
            assert.notEqual(first.root.uuid, differentFile.root.uuid);
            assert.notEqual(first.root.children?.[0]?.uuid, differentFile.root.children?.[0]?.uuid);
        },
    },
    {
        name: "generates valid stable ids for legacy sample vars trees",
        run() {
            const relativePath = "sample/vars/test.json";
            const content = fs.readFileSync(path.join(process.cwd(), relativePath), "utf-8");

            const first = parsePersistedTreeContent(content, relativePath);
            const second = parsePersistedTreeContent(content, relativePath);
            const serialized = serializePersistedTree(first);

            assert.match(first.root.uuid, /^[0-9A-Za-z]{10}$/);
            assert.doesNotMatch(first.root.uuid, /undefined/);
            assert.equal(first.root.uuid, second.root.uuid);
            assert.match(serialized, /"uuid": "[0-9A-Za-z]{10}"/);
            assert.doesNotMatch(serialized, /"uuid": ".*undefined.*"/);
        },
    },
    {
        name: "parses migrated sample tree files with variables",
        run() {
            const sampleTreeFiles = [
                "sample/vars/declare-core.json",
                "sample/vars/declare-vars.json",
                "sample/vars/subtree.json",
                "sample/vars/test.json",
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
        name: "applies explicit false subtree boolean overrides in materialization",
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
                    overrides: {
                        leaf: {
                            debug: false,
                            disabled: false,
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
                        overrides: {},
                        root: {
                            uuid: "sub-root",
                            id: "1",
                            name: "SubtreeRoot",
                            children: [
                                {
                                    uuid: "leaf",
                                    id: "2",
                                    name: "Leaf",
                                    debug: true,
                                    disabled: true,
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
                subtreeEditable: true,
            });

            const leaf = root.children[0]?.children[0];
            assert.ok(leaf);
            assert.equal(leaf?.data.debug, false);
            assert.equal(leaf?.data.disabled, false);
            assert.equal(leaf?.subtreeOriginal?.debug, true);
            assert.equal(leaf?.subtreeOriginal?.disabled, true);
        },
    },
    {
        name: "counts tree inspector variable usages inside materialized subtrees",
        run() {
            const mainTree = parsePersistedTreeContent(
                JSON.stringify({
                    version: "2.0.0",
                    name: "main",
                    prefix: "",
                    group: [],
                    variables: {
                        imports: ["vars.json"],
                        locals: [{ name: "mainTarget", desc: "main target" }],
                    },
                    custom: {},
                    overrides: {},
                    root: {
                        uuid: "root",
                        id: "1",
                        name: "Sequence",
                        children: [
                            {
                                uuid: "subref",
                                id: "2",
                                name: "SubtreeRef",
                                path: "sub.json",
                            },
                            {
                                uuid: "main-use",
                                id: "3",
                                name: "UseVars",
                                input: ["mainTarget"],
                                args: {
                                    expr: "importedVar + mainTarget",
                                },
                            },
                        ],
                    },
                }),
                "main.json"
            );

            const subtreeTree = parsePersistedTreeContent(
                JSON.stringify({
                    version: "2.0.0",
                    name: "sub",
                    prefix: "",
                    group: [],
                    variables: {
                        imports: [],
                        locals: [{ name: "subTarget", desc: "sub target" }],
                    },
                    custom: {},
                    overrides: {},
                    root: {
                        uuid: "sub-root",
                        id: "1",
                        name: "SubtreeRoot",
                        children: [
                            {
                                uuid: "sub-use",
                                id: "2",
                                name: "UseVars",
                                input: ["subTarget"],
                                output: ["importedVar"],
                                args: {
                                    expr: "subTarget + importedVar",
                                },
                            },
                        ],
                    },
                }),
                "sub.json"
            );

            const nodeDefs: NodeDef[] = [
                {
                    name: "Sequence",
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
                    name: "UseVars",
                    type: "Action",
                    desc: "",
                    input: ["target"],
                    output: ["result"],
                    args: [{ name: "expr", type: "expr", desc: "" }],
                },
            ];

            const usageCount = buildTreeInspectorVariableUsageCount({
                document: mainTree,
                subtreeSources: {
                    [parseWorkdirRelativeJsonPath("sub.json")!]: subtreeTree,
                },
                nodeDefs,
                nodeDefMap: createNodeDefMap(nodeDefs),
                subtreeEditable: true,
            });

            assert.equal(usageCount.mainTarget, 2);
            assert.equal(usageCount.subTarget, 2);
            assert.equal(usageCount.importedVar, 3);
        },
    },
    {
        name: "counts repeated subtree instances separately in tree inspector variable usages",
        run() {
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
                        name: "Sequence",
                        children: [
                            {
                                uuid: "subref-a",
                                id: "2",
                                name: "SubtreeRef",
                                path: "sub.json",
                            },
                            {
                                uuid: "subref-b",
                                id: "3",
                                name: "SubtreeRef",
                                path: "sub.json",
                            },
                        ],
                    },
                }),
                "main.json"
            );

            const subtreeTree = parsePersistedTreeContent(
                JSON.stringify({
                    version: "2.0.0",
                    name: "sub",
                    prefix: "",
                    group: [],
                    variables: {
                        imports: [],
                        locals: [{ name: "sharedTarget", desc: "shared target" }],
                    },
                    custom: {},
                    overrides: {},
                    root: {
                        uuid: "sub-root",
                        id: "1",
                        name: "SubtreeRoot",
                        children: [
                            {
                                uuid: "sub-use",
                                id: "2",
                                name: "UseVars",
                                input: ["sharedTarget"],
                            },
                        ],
                    },
                }),
                "sub.json"
            );

            const nodeDefs: NodeDef[] = [
                {
                    name: "Sequence",
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
                    name: "UseVars",
                    type: "Action",
                    desc: "",
                    input: ["target"],
                },
            ];

            const usageCount = buildTreeInspectorVariableUsageCount({
                document: mainTree,
                subtreeSources: {
                    [parseWorkdirRelativeJsonPath("sub.json")!]: subtreeTree,
                },
                nodeDefs,
                nodeDefMap: createNodeDefMap(nodeDefs),
                subtreeEditable: true,
            });

            assert.equal(usageCount.sharedTarget, 2);
        },
    },
    {
        name: "normalizes subtree original args with resolved defaults",
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
                        name: "SubtreeRef",
                        path: "sub.json",
                    },
                }),
                "main.json"
            );

            const subtreeSources = await loadSubtreeSourceCache({
                root: mainTree.root,
                readContent: async () =>
                    JSON.stringify({
                        version: "2.0.0",
                        name: "sub",
                        prefix: "",
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
                                    uuid: "sub-node",
                                    id: "2",
                                    name: "TryLaunchSkill",
                                },
                            ],
                        },
                    }),
            });

            const root = materializePersistedTree({
                persistedTree: mainTree,
                subtreeSources,
                nodeDefs: [
                    {
                        name: "SubtreeRef",
                        type: "Action",
                        desc: "",
                    },
                    {
                        name: "Sequence",
                        type: "Composite",
                        desc: "",
                    },
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
                ],
                subtreeEditable: false,
            });

            const subtreeNode = root.children[0];
            assert.ok(subtreeNode);
            assert.equal(subtreeNode?.data.args?.skip_cd, false);
            assert.equal(subtreeNode?.subtreeOriginal?.args?.skip_cd, false);
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
        name: "fills missing tree file version for legacy content",
        run() {
            const tree = parsePersistedTreeContent(
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
            );

            assert.equal(tree.version, DOCUMENT_VERSION);
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
]);
