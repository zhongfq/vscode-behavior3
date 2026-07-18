import type { FormInstance } from "antd/es/form";
import type { EditorRuntime } from "../../app/runtime";
import { parseSlotDefinition } from "../../shared/node-utils";
import type { EditNode, UpdateNodeInput } from "../../shared/contracts";
import type { NodeArg, NodeDef } from "../../shared/b3type";
import { isNodeArgOverrideValueDifferent } from "../../shared/node-overrides";
import { formatArgInitialValue } from "./inspector-arg-values";
import { queueInspectorTask, trackPendingInspectorEdit } from "./inspector-commit-queue";
import {
    buildArgsWithoutArg,
    buildCommittedNodeData,
    buildRenamedNodeData,
    buildScopedArgs,
    buildScopedSlotArray,
    getEffectiveNodeArgs,
    getNodeSlotFormValue,
    type NodeInspectorFormValues,
} from "./inspector-form-values";
import { compareJsonValue } from "./inspector-validation";

export type SlotFieldName = "inputSlots" | "outputSlots";
export type NodeInspectorFieldTarget = string | Array<string | number>;

interface UseNodeInspectorCommittersParams {
    form: FormInstance<NodeInspectorFormValues>;
    runtime: EditorRuntime;
    selectedNode: EditNode;
    nodeDef: NodeDef | null;
    subtreeOriginal: EditNode["subtreeOriginal"];
    fieldEditDisabled: boolean;
    effectiveReadOnly: boolean;
    canShowOverride: boolean;
}

const buildSlotFieldTarget = (
    fieldName: SlotFieldName,
    index: number
): NodeInspectorFieldTarget[] => [[fieldName, index]];

export function useNodeInspectorCommitters({
    form,
    runtime,
    selectedNode,
    nodeDef,
    subtreeOriginal,
    fieldEditDisabled,
    effectiveReadOnly,
    canShowOverride,
}: UseNodeInspectorCommittersParams) {
    const relatedArgForInput = (index: number): NodeArg | null => {
        if (!nodeDef) {
            return null;
        }
        const slotName = parseSlotDefinition(
            nodeDef.input?.[index] ?? "",
            nodeDef.input,
            index
        ).label;
        return nodeDef.args?.find((arg) => arg.oneof === slotName) ?? null;
    };

    const buildInputFieldTargets = (index: number): NodeInspectorFieldTarget[] => {
        const relatedArg = relatedArgForInput(index);
        return relatedArg
            ? [...buildSlotFieldTarget("inputSlots", index), ["args", relatedArg.name]]
            : buildSlotFieldTarget("inputSlots", index);
    };

    const buildArgFieldTargets = (arg: NodeArg): NodeInspectorFieldTarget[] => {
        const fields: NodeInspectorFieldTarget[] = [["args", arg.name]];
        if (!arg.oneof || !nodeDef?.input) {
            return fields;
        }

        const relatedInputIndex = nodeDef.input.findIndex(
            (input, inputIndex) =>
                parseSlotDefinition(input, nodeDef.input, inputIndex).label === arg.oneof
        );
        if (relatedInputIndex >= 0) {
            fields.push(["inputSlots", relatedInputIndex]);
        }
        return fields;
    };

    const commitNodeMutation = async (
        fields: NodeInspectorFieldTarget[],
        buildData: (values: NodeInspectorFormValues) => UpdateNodeInput["data"]
    ) => {
        if (effectiveReadOnly) {
            return;
        }

        if (fields.length > 0) {
            try {
                await form.validateFields(fields as never, { recursive: true });
            } catch {
                return;
            }
        }

        const values = form.getFieldsValue(true) as NodeInspectorFormValues;
        try {
            trackPendingInspectorEdit(
                runtime.controller.updateNode({
                    target: selectedNode.ref,
                    data: buildData(values),
                })
            );
        } catch (error) {
            runtime.hostAdapter.log("warn", `[v2] node form submit failed: ${String(error)}`);
        }
    };

    const queueNodeMutation = (
        fields: NodeInspectorFieldTarget[],
        buildData: (values: NodeInspectorFormValues) => UpdateNodeInput["data"]
    ) => {
        queueInspectorTask(() => {
            void commitNodeMutation(fields, buildData);
        });
    };

    const commitName = () => {
        queueNodeMutation(["name"], (values) => {
            const nextName =
                String(values.name ?? selectedNode.data.name).trim() || selectedNode.data.name;
            return buildRenamedNodeData(selectedNode, nextName, nodeDef);
        });
    };

    const commitDesc = () => {
        queueNodeMutation(["desc"], (values) => ({
            ...buildCommittedNodeData(selectedNode),
            desc: values.desc?.trim() || undefined,
        }));
    };

    const commitDebug = () => {
        queueNodeMutation(["debug"], (values) => ({
            ...buildCommittedNodeData(selectedNode),
            debug: values.debug,
        }));
    };

    const commitDisabled = () => {
        queueNodeMutation(["disabled"], (values) => ({
            ...buildCommittedNodeData(selectedNode),
            disabled: values.disabled,
        }));
    };

    const commitPath = () => {
        queueNodeMutation(["path"], (values) => ({
            ...buildCommittedNodeData(selectedNode),
            path:
                selectedNode.subtreeNode || fieldEditDisabled
                    ? selectedNode.data.path
                    : values.path?.trim() || undefined,
        }));
    };

    const isSlotOverridden = (
        currentSlots: string[] | undefined,
        originalSlots: string[] | undefined,
        index: number,
        variadic = false
    ) => {
        if (!canShowOverride) {
            return false;
        }
        if (variadic) {
            return !compareJsonValue(
                currentSlots?.slice(index) ?? [],
                originalSlots?.slice(index) ?? []
            );
        }
        return (currentSlots?.[index] ?? "") !== (originalSlots?.[index] ?? "");
    };

    const isInputOverridden = (index: number, variadic = false) =>
        isSlotOverridden(selectedNode.data.input, subtreeOriginal?.input, index, variadic);
    const isOutputOverridden = (index: number, variadic = false) =>
        isSlotOverridden(selectedNode.data.output, subtreeOriginal?.output, index, variadic);
    const isArgOverridden = (argName: string) =>
        canShowOverride &&
        isNodeArgOverrideValueDifferent({
            argName,
            currentArgs: selectedNode.data.args,
            originalArgs: subtreeOriginal?.args,
            nodeDef,
        });

    const commitInputField = (index: number) => {
        queueNodeMutation(buildInputFieldTargets(index), (values) => ({
            ...buildCommittedNodeData(selectedNode),
            input: buildScopedSlotArray(
                nodeDef?.input,
                selectedNode.data.input,
                values.inputSlots,
                index
            ),
        }));
    };

    const commitOutputField = (index: number) => {
        queueNodeMutation(buildSlotFieldTarget("outputSlots", index), (values) => ({
            ...buildCommittedNodeData(selectedNode),
            output: buildScopedSlotArray(
                nodeDef?.output,
                selectedNode.data.output,
                values.outputSlots,
                index
            ),
        }));
    };

    const commitArgField = (arg: NodeArg) => {
        queueNodeMutation(buildArgFieldTargets(arg), (values) => ({
            ...buildCommittedNodeData(selectedNode),
            args: buildScopedArgs(
                selectedNode.data.args,
                getEffectiveNodeArgs(selectedNode),
                arg,
                values,
                form.isFieldTouched(["args", arg.name])
            ),
        }));
    };

    const resetSlotField = (
        fieldName: SlotFieldName,
        originalSlots: string[] | undefined,
        index: number,
        variadic = false
    ) => {
        form.setFieldValue(
            [fieldName, index],
            getNodeSlotFormValue(originalSlots, index, variadic)
        );
        if (fieldName === "inputSlots") {
            commitInputField(index);
            return;
        }
        commitOutputField(index);
    };

    const resetInputField = (index: number, variadic = false) => {
        resetSlotField("inputSlots", subtreeOriginal?.input, index, variadic);
    };

    const resetOutputField = (index: number, variadic = false) => {
        resetSlotField("outputSlots", subtreeOriginal?.output, index, variadic);
    };

    const resetArgField = (arg: NodeArg) => {
        form.setFieldValue(
            ["args", arg.name],
            formatArgInitialValue(arg, subtreeOriginal?.args?.[arg.name])
        );
        queueNodeMutation([["args", arg.name]], (values) => ({
            ...buildCommittedNodeData(selectedNode),
            args: buildScopedArgs(
                selectedNode.data.args,
                getEffectiveNodeArgs(selectedNode),
                arg,
                values,
                true
            ),
        }));
    };

    const resetArgToDefault = (arg: NodeArg) => {
        form.setFields([
            {
                name: ["args", arg.name],
                value: formatArgInitialValue(arg, arg.default),
                touched: false,
                errors: [],
                warnings: [],
            },
        ]);
        queueNodeMutation([], () => ({
            ...buildCommittedNodeData(selectedNode),
            args: buildArgsWithoutArg(selectedNode.data.args, arg.name),
        }));
    };

    const resetDesc = () => {
        form.setFieldValue("desc", subtreeOriginal?.desc ?? "");
        commitDesc();
    };

    const resetDebug = () => {
        form.setFieldValue("debug", Boolean(subtreeOriginal?.debug));
        commitDebug();
    };

    const resetDisabled = () => {
        form.setFieldValue("disabled", Boolean(subtreeOriginal?.disabled));
        commitDisabled();
    };

    return {
        relatedArgForInput,
        commitName,
        commitDesc,
        commitDebug,
        commitDisabled,
        commitPath,
        isInputOverridden,
        isOutputOverridden,
        isArgOverridden,
        resetInputField,
        resetOutputField,
        resetArgField,
        resetArgToDefault,
        resetDesc,
        resetDebug,
        resetDisabled,
        commitInputField,
        commitOutputField,
        commitArgField,
    };
}
