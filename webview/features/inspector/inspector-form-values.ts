import { stringifySearchValueAsJson5 } from "../../shared/json";
import { parseSlotDefinition, type NodeSlotDef } from "../../shared/node-utils";
import type { EditNode, UpdateNodeInput, UpdateTreeMetaInput } from "../../shared/contracts";
import type { NodeArg, NodeDef } from "../../shared/b3type";
import { formatArgInitialValue, parseArgSubmitValue } from "./inspector-arg-values";
import { isSameInspectorNodeIdentity } from "./inspector-node-snapshot-cache";
import { compareJsonValue } from "./inspector-validation";
import { type VariableRowValue } from "./inspector-variable-options";
import { formatChildrenLabel } from "./inspector-validation";
import { type TreeCustomRowValue } from "./tree-custom-metadata";

export {
    buildTreeCustomRecord,
    getTreeCustomValueKind,
    parseTreeCustomValue,
    type TreeCustomRowValue,
    type TreeCustomValue,
    type TreeCustomValueKind,
} from "./tree-custom-metadata";

type ImportRefFormValue = {
    path?: string;
    vars?: VariableRowValue[];
};

type TreeInspectorDocument = {
    name: string;
    desc?: string;
    prefix: string;
    export?: boolean;
    group: string[];
    variables: {
        imports: string[];
        locals: VariableRowValue[];
    };
    custom: Record<string, unknown>;
};

export type NodeInspectorFormValues = {
    id: string;
    type: string;
    children: string;
    group: string[];
    name: string;
    desc: string;
    path: string;
    debug: boolean;
    disabled: boolean;
    args: Record<string, unknown>;
    inputSlots: Array<string | string[]>;
    outputSlots: Array<string | string[]>;
    rawNodeJson: string;
};

export type TreeInspectorFormValues = {
    desc?: string;
    prefix?: string;
    export?: boolean;
    group?: string[];
    vars?: VariableRowValue[];
    importRefs?: ImportRefFormValue[];
    customRows?: TreeCustomRowValue[];
};

export type NodeInspectorSyncMode = "replace" | "patch" | "patch-and-clear-scoped-fields";

export const isSameLogicalInspectorNode = (
    previousSelectedNode: Pick<EditNode, "ref"> | null | undefined,
    nextSelectedNode: Pick<EditNode, "ref"> | null | undefined
) =>
    Boolean(
        previousSelectedNode &&
        nextSelectedNode &&
        isSameInspectorNodeIdentity(previousSelectedNode.ref, nextSelectedNode.ref)
    );

const toOptionalBoolean = (value: unknown): boolean | undefined =>
    typeof value === "boolean" ? value : undefined;

export const buildCommittedNodeData = (selectedNode: EditNode): UpdateNodeInput["data"] => ({
    name: selectedNode.data.name,
    desc: selectedNode.data.desc,
    path: selectedNode.data.path,
    debug: toOptionalBoolean(selectedNode.data.debug),
    disabled: toOptionalBoolean(selectedNode.data.disabled),
    input: selectedNode.data.input ? [...selectedNode.data.input] : undefined,
    output: selectedNode.data.output ? [...selectedNode.data.output] : undefined,
    args: selectedNode.data.args ? { ...selectedNode.data.args } : undefined,
});

const areSlotArraysEqual = (
    left: ReadonlyArray<string> | undefined,
    right: ReadonlyArray<string> | undefined
) => {
    if (left === right) {
        return true;
    }
    if (!left || !right) {
        return !left && !right;
    }
    if (left.length !== right.length) {
        return false;
    }
    return left.every((entry, index) => entry === right[index]);
};

const buildDefinitionScopedArgs = (
    committedArgs: Record<string, unknown> | undefined,
    nodeDef: NodeDef | null | undefined
) => {
    if (!committedArgs) {
        return committedArgs;
    }

    const committedEntries = Object.entries(committedArgs);
    if (committedEntries.length === 0) {
        return committedArgs;
    }

    const declaredArgNames = new Set((nodeDef?.args ?? []).map((arg) => arg.name));
    if (declaredArgNames.size === 0) {
        return undefined;
    }

    const nextEntries = committedEntries.filter(([argName]) => declaredArgNames.has(argName));
    if (nextEntries.length === committedEntries.length) {
        return committedArgs;
    }

    return nextEntries.length > 0 ? Object.fromEntries(nextEntries) : undefined;
};

const buildDefinitionScopedSlotArray = (
    slotDefs: readonly NodeSlotDef[] | undefined,
    committedSlots: string[] | undefined
) => {
    if (!committedSlots) {
        return committedSlots;
    }

    if (!slotDefs?.length) {
        return undefined;
    }

    if (committedSlots.length === 0) {
        return committedSlots;
    }

    const scopedRawSlots = slotDefs.map((slotDef, slotIndex) => {
        const currentValue = getNodeSlotFormValue(
            committedSlots,
            slotIndex,
            parseSlotDefinition(slotDef, slotDefs, slotIndex).variadic
        );
        return Array.isArray(currentValue) ? [...currentValue] : currentValue;
    }) as Array<string | string[]>;

    const normalizedSlots = buildNodeSlotArray(
        slotDefs,
        scopedRawSlots,
        committedSlots
    ) ?? [];
    const nextSlots =
        normalizedSlots.length > committedSlots.length
            ? normalizedSlots.slice(0, committedSlots.length)
            : normalizedSlots;

    return areSlotArraysEqual(committedSlots, nextSlots) ? committedSlots : nextSlots;
};

export const getNodeInspectorSyncMode = (
    previousSelectedNode: Pick<EditNode, "ref" | "data"> | null | undefined,
    nextSelectedNode: Pick<EditNode, "ref" | "data">
): NodeInspectorSyncMode => {
    if (!isSameLogicalInspectorNode(previousSelectedNode, nextSelectedNode)) {
        return "replace";
    }

    if (!previousSelectedNode) {
        return "replace";
    }

    return previousSelectedNode.data.name === nextSelectedNode.data.name
        ? "patch"
        : "patch-and-clear-scoped-fields";
};

export const shouldLockPendingInspectorForm = (params: {
    readOnly: boolean;
    pendingSelectedNodeSnapshot: boolean;
    previousSelectedNode: Pick<EditNode, "ref"> | null | undefined;
    nextSelectedNode: Pick<EditNode, "ref"> | null | undefined;
}) => {
    if (params.readOnly) {
        return true;
    }

    if (!params.pendingSelectedNodeSnapshot) {
        return false;
    }

    return !isSameLogicalInspectorNode(params.previousSelectedNode, params.nextSelectedNode);
};

export const getEffectiveNodeArgs = (
    selectedNode: Pick<EditNode, "effectiveArgs" | "data">
): Record<string, unknown> | undefined => selectedNode.effectiveArgs ?? selectedNode.data.args;

export const buildRenamedNodeData = (
    selectedNode: EditNode,
    nextName: string,
    nextNodeDef?: NodeDef | null
): UpdateNodeInput["data"] => ({
    ...buildCommittedNodeData(selectedNode),
    name: nextName,
    input: buildDefinitionScopedSlotArray(nextNodeDef?.input, selectedNode.data.input),
    output: buildDefinitionScopedSlotArray(nextNodeDef?.output, selectedNode.data.output),
    args: buildDefinitionScopedArgs(selectedNode.data.args, nextNodeDef),
});

export const parseVisibleArgs = (
    currentNodeDef: NodeDef | null,
    values: Pick<NodeInspectorFormValues, "args">,
    fallbackArgs: Record<string, unknown> | undefined
) => {
    if (!currentNodeDef) {
        return fallbackArgs;
    }

    const nextArgs = Object.fromEntries(
        (currentNodeDef.args ?? [])
            .map((arg) => [arg.name, parseArgSubmitValue(arg, values.args?.[arg.name])])
            .filter(([, value]) => value !== undefined)
    );
    return Object.keys(nextArgs).length > 0 ? nextArgs : undefined;
};

export const buildScopedSlotArray = (
    slotDefs: readonly NodeSlotDef[] | undefined,
    committedSlots: string[] | undefined,
    rawFormSlots: unknown,
    index: number
) => {
    if (!slotDefs?.length) {
        return committedSlots;
    }

    const scopedRawSlots = slotDefs.map((_, slotIndex) =>
        getNodeSlotFormValue(
            committedSlots,
            slotIndex,
            parseSlotDefinition(slotDefs[slotIndex] ?? "", slotDefs, slotIndex).variadic
        )
    ) as Array<string | string[]>;
    const formSlots = Array.isArray(rawFormSlots) ? rawFormSlots : [];
    scopedRawSlots[index] = formSlots[index];
    return buildNodeSlotArray(slotDefs, scopedRawSlots, committedSlots);
};

export const buildScopedArgs = (
    committedArgs: Record<string, unknown> | undefined,
    effectiveArgs: Record<string, unknown> | undefined,
    arg: NodeArg,
    values: Pick<NodeInspectorFormValues, "args">,
    touched: boolean
) => {
    if (!touched) {
        const parsedUntouchedValue = parseArgSubmitValue(arg, values.args?.[arg.name]);
        const committedValue = committedArgs?.[arg.name];
        const effectiveValue = effectiveArgs?.[arg.name];
        if (compareJsonValue(parsedUntouchedValue, committedValue)) {
            return committedArgs;
        }
        if (
            compareJsonValue(parsedUntouchedValue, effectiveValue) &&
            compareJsonValue(committedValue, undefined)
        ) {
            return committedArgs;
        }
    }

    const nextArgs = { ...(committedArgs ?? {}) };
    const parsedValue = parseArgSubmitValue(arg, values.args?.[arg.name]);
    if (parsedValue === undefined) {
        delete nextArgs[arg.name];
    } else {
        nextArgs[arg.name] = parsedValue;
    }
    return Object.keys(nextArgs).length > 0 ? nextArgs : undefined;
};

export const buildArgsWithoutArg = (
    committedArgs: Record<string, unknown> | undefined,
    argName: string
) => {
    if (!committedArgs || !(argName in committedArgs)) {
        return committedArgs;
    }

    const nextArgs = { ...committedArgs };
    delete nextArgs[argName];
    return Object.keys(nextArgs).length > 0 ? nextArgs : undefined;
};

export const getNodeSlotFormValue = (
    slots: string[] | undefined,
    index: number,
    variadic: boolean
) => {
    return variadic ? (slots?.slice(index) ?? []) : (slots?.[index] ?? "");
};

export const buildNodeSlotArray = (
    slotDefs: readonly NodeSlotDef[] | undefined,
    rawSlots: unknown,
    fallback: string[] | undefined
) => {
    if (!slotDefs?.length) {
        return fallback;
    }

    const slots = (Array.isArray(rawSlots) ? rawSlots : []) as Array<string | string[]>;
    const nextValue: string[] = [];

    slotDefs.forEach((_, index) => {
        const rawValue = slots[index];
        if (parseSlotDefinition(slotDefs[index] ?? "", slotDefs, index).variadic) {
            const entries = Array.isArray(rawValue) ? rawValue : [];
            nextValue.push(
                ...entries.filter((entry): entry is string => typeof entry === "string")
            );
        } else {
            nextValue.push(typeof rawValue === "string" ? rawValue : "");
        }
    });

    return nextValue;
};

export const createNodeInspectorFormValues = (
    currentNodeDef: NodeDef | null,
    selectedNode: EditNode,
    unknownTypeLabel: string
) => {
    const effectiveArgs = getEffectiveNodeArgs(selectedNode);

    return {
        id: `${selectedNode.ref.displayId} (${selectedNode.data.uuid})`,
        type: currentNodeDef?.type ?? unknownTypeLabel,
        children: formatChildrenLabel(currentNodeDef),
        group: currentNodeDef?.group ?? [],
        name: selectedNode.data.name,
        desc: selectedNode.data.desc ?? currentNodeDef?.desc ?? "",
        path: selectedNode.data.path ?? "",
        debug: Boolean(selectedNode.data.debug),
        disabled: Boolean(selectedNode.data.disabled),
        args: Object.fromEntries(
            (currentNodeDef?.args ?? [])
                .map(
                    (arg) =>
                        [arg.name, formatArgInitialValue(arg, effectiveArgs?.[arg.name])] as const
                )
                .filter(([, value]) => value !== undefined)
        ),
        inputSlots: (currentNodeDef?.input ?? []).map((_, index) =>
            getNodeSlotFormValue(
                selectedNode.data.input,
                index,
                parseSlotDefinition(
                    currentNodeDef?.input?.[index] ?? "",
                    currentNodeDef?.input,
                    index
                ).variadic
            )
        ),
        outputSlots: (currentNodeDef?.output ?? []).map((_, index) =>
            getNodeSlotFormValue(
                selectedNode.data.output,
                index,
                parseSlotDefinition(
                    currentNodeDef?.output?.[index] ?? "",
                    currentNodeDef?.output,
                    index
                ).variadic
            )
        ),
        rawNodeJson: JSON.stringify(selectedNode.data ?? {}, null, 2),
    };
};

export const createTreeInspectorFormValues = (
    document: TreeInspectorDocument,
    variableUsageCount: Record<string, number>
) => {
    return {
        name: document.name,
        desc: document.desc ?? "",
        prefix: document.prefix ?? "",
        export: document.export !== false,
        group: document.group,
        vars: document.variables.locals.map((variable) => ({
            ...variable,
            count: variableUsageCount[variable.name] ?? 0,
        })),
        importRefs: document.variables.imports.map((path) => ({ path })),
        customRows: Object.entries(document.custom).map(([key, value]) => ({
            key,
            value: stringifySearchValueAsJson5(value),
        })),
    };
};

export const createTreeMetaPayload = (values: TreeInspectorFormValues): UpdateTreeMetaInput => {
    return {
        desc: values.desc?.trim() || undefined,
        prefix: values.prefix ?? "",
        export: values.export !== false,
        group: values.group ?? [],
        variables: {
            imports: (values.importRefs ?? [])
                .map((entry) => entry.path?.trim())
                .filter((entry): entry is string => Boolean(entry)),
            locals: (values.vars ?? [])
                .filter((entry) => entry.name?.trim())
                .map((entry) => ({
                    name: entry.name.trim(),
                    desc: entry.desc.trim(),
                })),
        },
    };
};
