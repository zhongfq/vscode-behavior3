import assert from "node:assert/strict";
import {
    formatArgInitialValue,
    parseArgSubmitValue,
    validateInspectorArgValue,
} from "../../webview/features/inspector/inspector-arg-values";
import { validateNodeArgOneof } from "../../webview/shared/validation";
import {
    buildCommittedNodeData,
    buildArgsWithoutArg,
    buildScopedArgs,
    buildRenamedNodeData,
    createNodeInspectorFormValues,
    getNodeInspectorSyncMode,
    isSameLogicalInspectorNode,
    shouldLockPendingInspectorForm,
    buildTreeCustomRecord,
    getTreeCustomValueKind,
} from "../../webview/features/inspector/inspector-form-values";
import {
    buildArgsWithoutHiddenVisibility,
    collectHiddenStructuredArgNames,
    filterStructuredArgsByVisibility,
} from "../../webview/features/inspector/inspector-arg-visibility";
import type { EditNode } from "../../webview/shared/contracts";
import type { NodeArg } from "../../webview/shared/b3type";
import { normalizeNodeDefCollection, parseNodeDefsContent } from "../../webview/shared/schema";
import { defineSharedTests } from "../shared-test-types";

const createNodeInspectorSyncSnapshot = (
    instanceKey: string,
    name: string
): Pick<EditNode, "ref" | "data"> => ({
    ref: {
        instanceKey,
        displayId: instanceKey,
        structuralStableId: "child",
        sourceStableId: "child",
        sourceTreePath: null,
        subtreeStack: [],
    },
    data: {
        uuid: "child",
        id: instanceKey,
        name,
    },
});

export const inspectorSharedTests = defineSharedTests([
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
        name: "preserves node arg checker and visible names in node definitions",
        run() {
            const defs = parseNodeDefsContent(
                JSON.stringify([
                    {
                        name: "Wait",
                        type: "Action",
                        desc: "",
                        args: [
                            {
                                name: "time",
                                type: "float",
                                desc: "",
                                checker: "positive",
                                visible: "show-time",
                            },
                        ],
                    },
                ])
            );

            assert.equal(defs[0]?.args?.[0]?.checker, "positive");
            assert.equal(defs[0]?.args?.[0]?.visible, "show-time");
            assert.throws(
                () =>
                    parseNodeDefsContent(
                        JSON.stringify([
                            {
                                name: "Wait",
                                type: "Action",
                                desc: "",
                                args: [
                                    {
                                        name: "time",
                                        type: "float",
                                        desc: "",
                                        checker: "",
                                    },
                                ],
                            },
                        ])
                    ),
                /checker.*non-empty string/
            );
            assert.throws(
                () =>
                    parseNodeDefsContent(
                        JSON.stringify([
                            {
                                name: "Wait",
                                type: "Action",
                                desc: "",
                                args: [
                                    {
                                        name: "time",
                                        type: "float",
                                        desc: "",
                                        visible: "",
                                    },
                                ],
                            },
                        ])
                    ),
                /visible.*non-empty string/
            );
        },
    },
    {
        name: "preserves structured slot checker and visible names in node definitions",
        run() {
            const defs = parseNodeDefsContent(
                JSON.stringify([
                    {
                        name: "Wait",
                        type: "Action",
                        desc: "",
                        input: [
                            {
                                name: "target?",
                                checker: "positive-input",
                                visible: "show-target",
                            },
                        ],
                        output: [
                            {
                                name: "result",
                                checker: "check-result",
                            },
                        ],
                    },
                ])
            );

            assert.deepEqual(defs[0]?.input?.[0], {
                name: "target?",
                checker: "positive-input",
                visible: "show-target",
            });
            assert.deepEqual(defs[0]?.output?.[0], {
                name: "result",
                checker: "check-result",
                visible: undefined,
            });
        },
    },
    {
        name: "reports structured slot schema errors with node names",
        run() {
            assert.throws(
                () =>
                    parseNodeDefsContent(
                        JSON.stringify([
                            {
                                name: "TestVisibleAndChecker",
                                type: "Action",
                                desc: "",
                                input: [
                                    {
                                        name: "",
                                    },
                                ],
                            },
                        ])
                    ),
                /nodes\[0\]\(TestVisibleAndChecker\)\.input\[0\]\.name must be a non-empty string/
            );
        },
    },
    {
        name: "filters structured args by selected node visibility state",
        run() {
            const args: NodeArg[] = [
                { name: "mode", type: "string", desc: "" },
                { name: "time", type: "float", desc: "", visible: "show-time" },
                { name: "count", type: "int", desc: "", visible: "show-count" },
            ];

            const visibleArgs = filterStructuredArgsByVisibility(args, {
                time: false,
                count: true,
            });

            assert.deepEqual(
                visibleArgs.map((arg) => arg.name),
                ["mode", "count"]
            );
        },
    },
    {
        name: "collects and clears hidden structured args by selected node visibility state",
        run() {
            const args: NodeArg[] = [
                { name: "mode", type: "string", desc: "" },
                { name: "time", type: "float", desc: "", visible: "show-time" },
                { name: "speed", type: "float", desc: "", visible: "show-speed" },
            ];

            assert.deepEqual(collectHiddenStructuredArgNames(args, { time: false }), ["time"]);
            assert.deepEqual(
                buildArgsWithoutHiddenVisibility(
                    {
                        mode: "delay",
                        time: 3,
                        speed: 4,
                    },
                    args,
                    { time: false, speed: true }
                ),
                {
                    mode: "delay",
                    speed: 4,
                }
            );
            assert.equal(
                buildArgsWithoutHiddenVisibility({ time: 3 }, args, { time: false }),
                undefined
            );
        },
    },
    {
        name: "creates node inspector identity and raw json form values",
        run() {
            const selectedNode: EditNode = {
                ref: {
                    instanceKey: "7",
                    displayId: "7",
                    structuralStableId: "node-uuid",
                    sourceStableId: "node-uuid",
                    sourceTreePath: null,
                    subtreeStack: [],
                },
                data: {
                    uuid: "node-uuid",
                    id: "legacy-7",
                    name: "Wait",
                    desc: "pause",
                    args: {
                        time: 1,
                    },
                },
                prefix: "",
                activeChildCount: 0,
                disabled: false,
                subtreeNode: false,
                subtreeEditable: true,
            };

            const values = createNodeInspectorFormValues(
                {
                    name: "Wait",
                    type: "Action",
                    desc: "wait",
                    args: [{ name: "time", type: "float", desc: "Time" }],
                },
                selectedNode,
                "Unknown"
            );

            assert.equal(values.id, "7 (node-uuid)");
            assert.match(values.rawNodeJson, /"uuid": "node-uuid"/);
            assert.match(values.rawNodeJson, /"id": "legacy-7"/);
        },
    },
    {
        name: "renaming an unknown node does not synthesize inputs outputs or args",
        run() {
            const selectedNode: EditNode = {
                ref: {
                    instanceKey: "9",
                    displayId: "9",
                    structuralStableId: "unknown-node",
                    sourceStableId: "unknown-node",
                    sourceTreePath: null,
                    subtreeStack: [],
                },
                data: {
                    uuid: "unknown-node",
                    id: "9",
                    name: "unknown",
                },
                prefix: "",
                activeChildCount: 0,
                disabled: false,
                subtreeNode: false,
                subtreeEditable: true,
            };

            assert.deepEqual(buildRenamedNodeData(selectedNode, "Wait"), {
                name: "Wait",
                desc: undefined,
                path: undefined,
                debug: undefined,
                disabled: undefined,
                input: undefined,
                output: undefined,
                args: undefined,
            });
        },
    },
    {
        name: "committed node data preserves explicit false booleans",
        run() {
            const selectedNode: EditNode = {
                ref: {
                    instanceKey: "9b",
                    displayId: "9",
                    structuralStableId: "bool-node",
                    sourceStableId: "bool-node",
                    sourceTreePath: null,
                    subtreeStack: [],
                },
                data: {
                    uuid: "bool-node",
                    id: "9",
                    name: "Wait",
                    debug: false,
                    disabled: false,
                },
                prefix: "",
                activeChildCount: 0,
                disabled: false,
                subtreeNode: true,
                subtreeEditable: true,
            };

            assert.deepEqual(buildCommittedNodeData(selectedNode), {
                name: "Wait",
                desc: undefined,
                path: undefined,
                debug: false,
                disabled: false,
                input: undefined,
                output: undefined,
                args: undefined,
            });
        },
    },
    {
        name: "renaming a node prunes args and slots that are missing from the next node definition",
        run() {
            const selectedNode: EditNode = {
                ref: {
                    instanceKey: "13",
                    displayId: "13",
                    structuralStableId: "schema-prune-node",
                    sourceStableId: "schema-prune-node",
                    sourceTreePath: null,
                    subtreeStack: [],
                },
                data: {
                    uuid: "schema-prune-node",
                    id: "13",
                    name: "OldNode",
                    args: {
                        mode: "delay",
                        time: 3,
                    },
                    input: ["targetA", "targetB"],
                    output: ["resultA", "resultB"],
                },
                prefix: "",
                activeChildCount: 0,
                disabled: false,
                subtreeNode: false,
                subtreeEditable: true,
            };

            assert.deepEqual(
                buildRenamedNodeData(selectedNode, "Wait", {
                    name: "Wait",
                    type: "Action",
                    desc: "",
                    args: [{ name: "time", type: "float", desc: "Time" }],
                    input: ["target"],
                    output: ["result"],
                }),
                {
                    name: "Wait",
                    desc: undefined,
                    path: undefined,
                    debug: undefined,
                    disabled: undefined,
                    input: ["targetA"],
                    output: ["resultA"],
                    args: { time: 3 },
                }
            );
        },
    },
    {
        name: "renaming a node does not synthesize empty slots for a longer next node definition",
        run() {
            const selectedNode: EditNode = {
                ref: {
                    instanceKey: "14",
                    displayId: "14",
                    structuralStableId: "schema-keep-node",
                    sourceStableId: "schema-keep-node",
                    sourceTreePath: null,
                    subtreeStack: [],
                },
                data: {
                    uuid: "schema-keep-node",
                    id: "14",
                    name: "OldNode",
                    input: ["targetA"],
                },
                prefix: "",
                activeChildCount: 0,
                disabled: false,
                subtreeNode: false,
                subtreeEditable: true,
            };

            assert.deepEqual(
                buildRenamedNodeData(selectedNode, "Wait", {
                    name: "Wait",
                    type: "Action",
                    desc: "",
                    input: ["target", "fallback?"],
                }),
                {
                    name: "Wait",
                    desc: undefined,
                    path: undefined,
                    debug: undefined,
                    disabled: undefined,
                    input: ["targetA"],
                    output: undefined,
                    args: undefined,
                }
            );
        },
    },
    {
        name: "unknown nodes initialize inspector form values without residual args or slots",
        run() {
            const selectedNode: EditNode = {
                ref: {
                    instanceKey: "10",
                    displayId: "10",
                    structuralStableId: "unknown-clean",
                    sourceStableId: "unknown-clean",
                    sourceTreePath: null,
                    subtreeStack: [],
                },
                data: {
                    uuid: "unknown-clean",
                    id: "10",
                    name: "unknown",
                },
                prefix: "",
                activeChildCount: 0,
                disabled: false,
                subtreeNode: false,
                subtreeEditable: true,
            };

            const values = createNodeInspectorFormValues(null, selectedNode, "Unknown");

            assert.deepEqual(values.args, {});
            assert.deepEqual(values.inputSlots, []);
            assert.deepEqual(values.outputSlots, []);
        },
    },
    {
        name: "required inspector args with no committed value are omitted from preview form values",
        run() {
            const selectedNode: EditNode = {
                ref: {
                    instanceKey: "11",
                    displayId: "11",
                    structuralStableId: "wait-node",
                    sourceStableId: "wait-node",
                    sourceTreePath: null,
                    subtreeStack: [],
                },
                data: {
                    uuid: "wait-node",
                    id: "11",
                    name: "Wait",
                },
                prefix: "",
                activeChildCount: 0,
                disabled: false,
                subtreeNode: false,
                subtreeEditable: true,
            };

            const values = createNodeInspectorFormValues(
                {
                    name: "Wait",
                    type: "Action",
                    desc: "",
                    args: [{ name: "time", type: "float", desc: "Time" }],
                },
                selectedNode,
                "Unknown"
            );

            assert.deepEqual(values.args, {});
        },
    },
    {
        name: "inspector form values can display effective default args without committed args",
        run() {
            const selectedNode: EditNode = {
                ref: {
                    instanceKey: "12",
                    displayId: "12",
                    structuralStableId: "back-team-node",
                    sourceStableId: "back-team-node",
                    sourceTreePath: null,
                    subtreeStack: [],
                },
                data: {
                    uuid: "back-team-node",
                    id: "12",
                    name: "BackTeam",
                },
                effectiveArgs: {
                    speed_rate: 1.5,
                },
                prefix: "",
                activeChildCount: 0,
                disabled: false,
                subtreeNode: false,
                subtreeEditable: true,
            };

            const values = createNodeInspectorFormValues(
                {
                    name: "BackTeam",
                    type: "Action",
                    desc: "",
                    args: [{ name: "speed_rate", type: "float", desc: "Speed Rate", default: 1.5 }],
                },
                selectedNode,
                "Unknown"
            );

            assert.deepEqual(values.args, { speed_rate: 1.5 });
        },
    },
    {
        name: "same logical node snapshot refresh patches instead of replacing the inspector form",
        run() {
            assert.equal(
                isSameLogicalInspectorNode(
                    createNodeInspectorSyncSnapshot("5", "Action"),
                    createNodeInspectorSyncSnapshot("12", "Action")
                ),
                true
            );
            const syncMode = getNodeInspectorSyncMode(
                createNodeInspectorSyncSnapshot("5", "Action"),
                createNodeInspectorSyncSnapshot("12", "Action")
            );

            assert.equal(syncMode, "patch");
        },
    },
    {
        name: "pending inspector form stays interactive while the same logical node snapshot refreshes",
        run() {
            assert.equal(
                shouldLockPendingInspectorForm({
                    readOnly: false,
                    pendingSelectedNodeSnapshot: true,
                    previousSelectedNode: createNodeInspectorSyncSnapshot("5", "Action"),
                    nextSelectedNode: createNodeInspectorSyncSnapshot("12", "Action"),
                }),
                false
            );
        },
    },
    {
        name: "same logical node rename clears dependent inspector fields without full replacement",
        run() {
            const syncMode = getNodeInspectorSyncMode(
                createNodeInspectorSyncSnapshot("5", "Wait"),
                createNodeInspectorSyncSnapshot("12", "BackTeam")
            );

            assert.equal(syncMode, "patch-and-clear-scoped-fields");
        },
    },
    {
        name: "pending inspector form locks while switching to a different logical node",
        run() {
            assert.equal(
                shouldLockPendingInspectorForm({
                    readOnly: false,
                    pendingSelectedNodeSnapshot: true,
                    previousSelectedNode: createNodeInspectorSyncSnapshot("5", "Action"),
                    nextSelectedNode: {
                        ref: {
                            instanceKey: "7",
                            displayId: "7",
                            structuralStableId: "other-child",
                            sourceStableId: "other-child",
                            sourceTreePath: null,
                            subtreeStack: [],
                        },
                    },
                }),
                true
            );
        },
    },
    {
        name: "untouched default args remain omitted from committed scoped args",
        run() {
            const nextArgs = buildScopedArgs(
                undefined,
                { speed_rate: 1.5 },
                { name: "speed_rate", type: "float?", desc: "Speed Rate", default: 1.5 },
                { args: { speed_rate: 1.5 } } as any,
                false
            );

            assert.equal(nextArgs, undefined);
        },
    },
    {
        name: "touched default args persist into committed scoped args",
        run() {
            const nextArgs = buildScopedArgs(
                undefined,
                { speed_rate: 1.5 },
                { name: "speed_rate", type: "float?", desc: "Speed Rate", default: 1.5 },
                { args: { speed_rate: 1.5 } } as any,
                true
            );

            assert.deepEqual(nextArgs, { speed_rate: 1.5 });
        },
    },
    {
        name: "default arg reset removes explicit committed override",
        run() {
            const nextArgs = buildArgsWithoutArg(
                {
                    speed_rate: 2.5,
                    duration: 8,
                },
                "speed_rate"
            );

            assert.deepEqual(nextArgs, { duration: 8 });
            assert.equal(buildArgsWithoutArg({ speed_rate: 2.5 }, "speed_rate"), undefined);
        },
    },
    {
        name: "keeps required inspector arg initial values unset",
        run() {
            assert.equal(
                formatArgInitialValue({ name: "text", type: "string", desc: "" }, undefined),
                undefined
            );
            assert.equal(
                formatArgInitialValue({ name: "expr", type: "expr", desc: "" }, undefined),
                undefined
            );
            assert.equal(
                formatArgInitialValue({ name: "count", type: "int", desc: "" }, undefined),
                undefined
            );
            assert.equal(
                formatArgInitialValue({ name: "enabled", type: "bool", desc: "" }, undefined),
                undefined
            );
            assert.equal(
                formatArgInitialValue(
                    {
                        name: "status",
                        type: "string",
                        desc: "",
                        options: [],
                    },
                    undefined
                ),
                undefined
            );
        },
    },
    {
        name: "formats optional inspector arg initial values",
        run() {
            assert.equal(
                formatArgInitialValue({ name: "text", type: "string?", desc: "" }, undefined),
                ""
            );
            assert.equal(
                formatArgInitialValue({ name: "enabled", type: "bool?", desc: "" }, undefined),
                false
            );
            assert.equal(
                formatArgInitialValue(
                    {
                        name: "camp",
                        type: "string?",
                        desc: "",
                        options: [],
                    },
                    undefined
                ),
                undefined
            );
        },
    },
    {
        name: "does not coerce unset required inspector args into serialized values",
        run() {
            assert.equal(
                parseArgSubmitValue({ name: "text", type: "string", desc: "" }, undefined),
                undefined
            );
            assert.equal(
                parseArgSubmitValue({ name: "expr", type: "expr", desc: "" }, undefined),
                undefined
            );
            assert.equal(
                parseArgSubmitValue({ name: "count", type: "int", desc: "" }, undefined),
                undefined
            );
            assert.equal(
                parseArgSubmitValue({ name: "enabled", type: "bool", desc: "" }, undefined),
                undefined
            );
            assert.equal(
                parseArgSubmitValue(
                    {
                        name: "status",
                        type: "string",
                        desc: "",
                        options: [],
                    },
                    undefined
                ),
                undefined
            );
        },
    },
    {
        name: "preserves explicit inspector arg values during serialization",
        run() {
            assert.equal(
                parseArgSubmitValue({ name: "enabled", type: "bool", desc: "" }, false),
                false
            );
            assert.equal(
                parseArgSubmitValue({ name: "enabled", type: "bool?", desc: "" }, false),
                false
            );
            assert.equal(parseArgSubmitValue({ name: "count", type: "int", desc: "" }, 0), 0);
            assert.equal(
                parseArgSubmitValue(
                    {
                        name: "status",
                        type: "string",
                        desc: "",
                        options: [],
                    },
                    "RUNNING"
                ),
                "RUNNING"
            );
        },
    },
    {
        name: "treats legacy unset option sentinel as missing during oneof validation",
        run() {
            const arg: NodeArg = {
                name: "camp",
                type: "string?",
                desc: "阵营",
                oneof: "target",
                options: [],
            };

            const diagnostic = validateNodeArgOneof({
                arg,
                argValue: parseArgSubmitValue(arg, "__unset__"),
                inputValues: ["one_member"],
                inputDefs: ["target?"],
            });

            assert.equal(diagnostic, null);
        },
    },
    {
        name: "accepts valid integer array inspector args",
        run() {
            assert.equal(
                validateInspectorArgValue({
                    arg: { name: "option", type: "int[]?", desc: "选项" },
                    rawValue: "[1,2]",
                    usingVars: null,
                    checkExpr: true,
                }),
                null
            );
        },
    },
    {
        name: "accepts valid float array inspector args",
        run() {
            assert.equal(
                validateInspectorArgValue({
                    arg: { name: "weights", type: "float[]?", desc: "权重" },
                    rawValue: "[1,2.5]",
                    usingVars: null,
                    checkExpr: true,
                }),
                null
            );
        },
    },
    {
        name: "rejects invalid integer array inspector args",
        run() {
            const error = validateInspectorArgValue({
                arg: { name: "option", type: "int[]?", desc: "选项" },
                rawValue: "[1,2.5]",
                usingVars: null,
                checkExpr: true,
            });
            assert.equal(typeof error, "string");
            assert.match(error ?? "", /选项/);
            assert.match(error ?? "", /integer|整数/);
        },
    },
    {
        name: "parses tree custom inspector rows into persisted custom values",
        run() {
            assert.deepEqual(
                buildTreeCustomRecord([
                    { key: "label", value: "hello" },
                    { key: "literal", value: "null" },
                    { key: "count", value: "42" },
                    { key: "enabled", value: "true" },
                    { key: "quoted", value: '"true"' },
                ]),
                {
                    label: "hello",
                    literal: "null",
                    count: 42,
                    enabled: true,
                    quoted: "true",
                }
            );
        },
    },
    {
        name: "rejects invalid tree custom inspector literals",
        run() {
            assert.throws(
                () => buildTreeCustomRecord([{ key: "object", value: "{ nested: true }" }]),
                /invalid tree custom value/
            );
            assert.throws(
                () => buildTreeCustomRecord([{ key: "array", value: "[1, 2, 3]" }]),
                /invalid tree custom value/
            );
        },
    },
    {
        name: "infers tree custom value kinds from inspector input",
        run() {
            assert.equal(getTreeCustomValueKind("hello"), "string");
            assert.equal(getTreeCustomValueKind("42"), "number");
            assert.equal(getTreeCustomValueKind("false"), "boolean");
            assert.equal(getTreeCustomValueKind('"quoted"'), "string");
            assert.equal(getTreeCustomValueKind("{ nested: true }"), "invalid");
        },
    },
]);
