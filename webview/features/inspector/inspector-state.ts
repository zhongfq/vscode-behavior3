import { Form } from "antd";
import type { FormInstance } from "antd/es/form";
import { useMemo } from "react";
import { useNodeInspectorState, useTreeInspectorState } from "../../app/runtime";
import type { NodeDef } from "../../shared/misc/b3type";
import { isVariadic } from "../../shared/misc/b3util";
import {
    buildVariableUsageCount,
    createNodeDefMap,
    createVariableOptions,
    formatArgInitialValue,
    formatChildrenLabel,
    type VariableRowValue,
} from "./inspector-shared";

type ImportRefFormValue = {
    path?: string;
    vars?: VariableRowValue[];
};

type TreeInspectorDocument = NonNullable<ReturnType<typeof useTreeInspectorState>["document"]>;

type TreeInspectorFormValues = {
    desc?: string;
    prefix?: string;
    export?: boolean;
    group?: string[];
    vars?: VariableRowValue[];
    importRefs?: ImportRefFormValue[];
};

export const useNodeInspectorViewState = (form: FormInstance) => {
    const {
        document,
        selectedNode,
        nodeDefs,
        usingVars,
        usingGroups,
        allFiles,
        checkExpr,
        nodeCheckDiagnostics,
    } = useNodeInspectorState();

    const nodeDefMap = useMemo(() => createNodeDefMap(nodeDefs), [nodeDefs]);
    const variableOptions = useMemo(
        () => createVariableOptions(usingVars, document?.root ?? null, nodeDefMap),
        [usingVars, document?.root, nodeDefMap]
    );
    const watchedName = Form.useWatch("name", form) as string | undefined;

    const effectiveName =
        (watchedName ?? selectedNode?.data.name ?? "").trim() || selectedNode?.data.name || "";
    const nodeDef = nodeDefs.find((entry) => entry.name === effectiveName) ?? null;
    const fieldEditDisabled = selectedNode?.disabled ?? false;
    const structuredArgs = nodeDef?.args ?? [];
    const subtreeOriginal = selectedNode?.subtreeOriginal;

    return {
        document,
        selectedNode,
        nodeDefs,
        usingVars,
        usingGroups,
        allFiles,
        checkExpr,
        nodeCheckDiagnostics: selectedNode
            ? (nodeCheckDiagnostics[selectedNode.ref.instanceKey] ?? [])
            : [],
        nodeDefMap,
        variableOptions,
        watchedName,
        effectiveName,
        nodeDef,
        fieldEditDisabled,
        title: nodeDef?.desc || effectiveName,
        structuredArgs,
        hasStructuredArgs: structuredArgs.length > 0,
        shouldShowRawNodeJson: nodeDef === null,
        subtreeOriginal,
        canShowOverride: Boolean(selectedNode?.subtreeNode && subtreeOriginal),
    };
};

export const useTreeInspectorViewState = (form: FormInstance) => {
    const { document, nodeDefs, groupDefs, allFiles, importDecls, subtreeDecls } =
        useTreeInspectorState();

    const nodeDefMap = useMemo(() => createNodeDefMap(nodeDefs), [nodeDefs]);
    const variableUsageCount = useMemo(
        () => buildVariableUsageCount(document?.root ?? null, nodeDefMap),
        [document?.root, nodeDefMap]
    );
    const currentImportRefs =
        (Form.useWatch("importRefs", form) as ImportRefFormValue[] | undefined) ?? [];

    const subtreeRows = useMemo(
        () =>
            subtreeDecls.map((entry) => ({
                ...entry,
                vars: entry.vars.map((variable) => ({
                    ...variable,
                    count: variableUsageCount[variable.name] ?? 0,
                })),
            })),
        [subtreeDecls, variableUsageCount]
    );

    const importDeclByPath = useMemo(() => {
        const record = new Map<string, VariableRowValue[]>();
        importDecls.forEach((entry) => {
            record.set(
                entry.path,
                entry.vars.map((variable) => ({
                    ...variable,
                    count: variableUsageCount[variable.name] ?? 0,
                }))
            );
        });
        return record;
    }, [importDecls, variableUsageCount]);

    return {
        document,
        nodeDefs,
        groupDefs,
        allFiles,
        importDecls,
        subtreeDecls,
        nodeDefMap,
        variableUsageCount,
        currentImportRefs,
        subtreeRows,
        importDeclByPath,
    };
};

export const getNodeSlotFormValue = (
    slots: string[] | undefined,
    index: number,
    variadic: boolean
) => {
    return variadic ? (slots?.slice(index) ?? []) : (slots?.[index] ?? "");
};

export const buildNodeSlotArray = (
    slotDefs: string[] | undefined,
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
        if (isVariadic(slotDefs, index)) {
            const entries = Array.isArray(rawValue) ? rawValue : [];
            nextValue.push(...entries.filter((entry): entry is string => typeof entry === "string"));
        } else {
            nextValue.push(typeof rawValue === "string" ? rawValue : "");
        }
    });

    return nextValue;
};

export const createNodeInspectorFormValues = (
    currentNodeDef: NodeDef | null,
    selectedNode: NonNullable<ReturnType<typeof useNodeInspectorState>["selectedNode"]>,
    unknownTypeLabel: string
) => {
    return {
        id: selectedNode.ref.displayId,
        type: currentNodeDef?.type ?? unknownTypeLabel,
        children: formatChildrenLabel(currentNodeDef),
        group: currentNodeDef?.group ?? [],
        name: selectedNode.data.name,
        desc: selectedNode.data.desc ?? currentNodeDef?.desc ?? "",
        path: selectedNode.data.path ?? "",
        debug: Boolean(selectedNode.data.debug),
        disabled: Boolean(selectedNode.data.disabled),
        args: Object.fromEntries(
            (currentNodeDef?.args ?? []).map((arg) => [
                arg.name,
                formatArgInitialValue(arg, selectedNode.data.args?.[arg.name]),
            ])
        ),
        inputSlots: (currentNodeDef?.input ?? []).map((_, index) =>
            getNodeSlotFormValue(
                selectedNode.data.input,
                index,
                Boolean(currentNodeDef?.input && isVariadic(currentNodeDef.input, index))
            )
        ),
        outputSlots: (currentNodeDef?.output ?? []).map((_, index) =>
            getNodeSlotFormValue(
                selectedNode.data.output,
                index,
                Boolean(currentNodeDef?.output && isVariadic(currentNodeDef.output, index))
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
    };
};

export const createTreeMetaPayload = (values: TreeInspectorFormValues) => {
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
