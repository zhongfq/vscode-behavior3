import { MinusCircleOutlined, PlusOutlined } from "@ant-design/icons";
import {
    AutoComplete,
    Button,
    Flex,
    Form,
    Input,
    InputNumber,
    Select,
    Switch,
    Typography,
} from "antd";
import type { FormInstance } from "antd/es/form";
import React, { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import ReactMarkdown from "react-markdown";
import {
    hasArgOptions,
    isBoolType,
    isExprType,
    isFloatType,
    isIntType,
    isJsonType,
    isStringType,
    type NodeArg,
    type NodeDef,
    type VarDecl,
} from "../../shared/misc/b3type";
import {
    checkOneof,
    getNodeArgOptions,
    getNodeArgRawType,
    isNodeArgArray,
    isNodeArgOptional,
    isVariadic,
} from "../../shared/misc/b3util";
import { useRuntime } from "../../app/runtime";
import {
    OverrideBar,
    SectionDivider,
    cleanSlotLabel,
    compareJsonValue,
    createInspectorLabelProps,
    filterOptionByLabel,
    formatArgInitialValue,
    parseArgSubmitValue,
    queueSubmit,
    validateExpressionValues,
    validateVariableValue,
    type VariableOption,
} from "./inspector-shared";
import {
    buildNodeSlotArray,
    createNodeInspectorFormValues,
    getNodeSlotFormValue,
    useNodeInspectorViewState,
} from "./inspector-state";

const { TextArea } = Input;

type SlotFieldName = "inputSlots" | "outputSlots";

const NodeArgField: React.FC<{
    form: FormInstance;
    arg: NodeArg;
    nodeDef: NodeDef;
    usingVars: Record<string, VarDecl> | null;
    checkExpr: boolean;
    disabled: boolean;
    onCommit: () => void;
}> = ({ form, arg, nodeDef, usingVars, checkExpr, disabled, onCommit }) => {
    const { t } = useTranslation();
    const argsValue = (Form.useWatch("args", form) as Record<string, unknown> | undefined) ?? {};
    const type = getNodeArgRawType(arg);
    const options = useMemo(() => getNodeArgOptions(arg, argsValue) ?? [], [arg, argsValue]);
    const required = !isNodeArgOptional(arg);
    const argLabel = arg.desc || arg.name;
    const argLabelProps = {
        ...createInspectorLabelProps(argLabel, required),
        required,
    };

    const validateField = async (_: unknown, value: unknown) => {
        const empty =
            value === undefined ||
            value === null ||
            value === "" ||
            value === "__unset__" ||
            (Array.isArray(value) && value.length === 0);

        if (empty && !required) {
            return;
        }

        if (empty && required && !isBoolType(type)) {
            throw new Error(t("fieldRequired", { field: arg.desc || arg.name }));
        }

        let parsedValue: unknown = value;

        if (isNodeArgArray(arg) || isJsonType(type)) {
            parsedValue = parseArgSubmitValue(arg, value);
        }

        if (isIntType(type) && value !== undefined && value !== "") {
            if (!Number.isInteger(Number(value))) {
                throw new Error(t("validation.integer", { field: arg.desc || arg.name }));
            }
        }

        if (isFloatType(type) && value !== undefined && value !== "") {
            if (!Number.isFinite(Number(value))) {
                throw new Error(t("validation.number", { field: arg.desc || arg.name }));
            }
        }

        if (isExprType(type)) {
            const exprValues = Array.isArray(parsedValue)
                ? parsedValue.filter((entry): entry is string => typeof entry === "string")
                : typeof parsedValue === "string"
                  ? [parsedValue]
                  : [];
            const error = validateExpressionValues(exprValues, usingVars, checkExpr);
            if (error) {
                throw new Error(error);
            }
        }

        if (arg.oneof) {
            const relatedInputIndex =
                nodeDef.input?.findIndex((input) => cleanSlotLabel(input) === arg.oneof) ?? -1;

            if (relatedInputIndex < 0) {
                throw new Error(t("validation.missingOneofInput", { input: arg.oneof }));
            }

            const relatedInputValue = form.getFieldValue(["inputSlots", relatedInputIndex]);
            if (!checkOneof(arg, parsedValue, relatedInputValue)) {
                throw new Error(t("validation.oneof", { left: arg.name, right: arg.oneof }));
            }
        }
    };

    if (hasArgOptions(arg)) {
        return (
            <Form.Item
                {...argLabelProps}
                name={["args", arg.name]}
                rules={[{ validator: validateField }]}
            >
                <Select
                    mode={isNodeArgArray(arg) ? "multiple" : undefined}
                    disabled={disabled}
                    allowClear={!required}
                    onChange={() => queueSubmit(form)}
                    onBlur={onCommit}
                    options={options.map((option: { name: string; value: unknown }) => ({
                        label: `${option.name} (${String(option.value)})`,
                        value: option.value as string | number | boolean,
                    }))}
                    filterOption={filterOptionByLabel}
                />
            </Form.Item>
        );
    }

    if (isNodeArgArray(arg) || isJsonType(type)) {
        return (
            <Form.Item
                {...argLabelProps}
                name={["args", arg.name]}
                rules={[{ validator: validateField }]}
            >
                <TextArea
                    autoSize={{ minRows: 1 }}
                    disabled={disabled}
                    placeholder={
                        isNodeArgArray(arg) ? t("form.enterJsonArray") : t("form.enterJsonValue")
                    }
                    onBlur={onCommit}
                />
            </Form.Item>
        );
    }

    if (isBoolType(type)) {
        if (isNodeArgOptional(arg)) {
            return (
                <Form.Item
                    {...argLabelProps}
                    name={["args", arg.name]}
                    rules={[{ validator: validateField }]}
                >
                    <Select
                        disabled={disabled}
                        allowClear={false}
                        onChange={() => queueSubmit(form)}
                        options={[
                            { label: t("form.unset"), value: "__unset__" },
                            { label: t("form.true"), value: true },
                            { label: t("form.false"), value: false },
                        ]}
                    />
                </Form.Item>
            );
        }

        return (
            <Form.Item
                {...argLabelProps}
                name={["args", arg.name]}
                valuePropName="checked"
                rules={[{ validator: validateField }]}
            >
                <Switch disabled={disabled} onChange={() => queueSubmit(form)} />
            </Form.Item>
        );
    }

    if (isIntType(type) || isFloatType(type)) {
        return (
            <Form.Item
                {...argLabelProps}
                name={["args", arg.name]}
                rules={[{ validator: validateField }]}
            >
                <InputNumber
                    style={{ width: "100%" }}
                    disabled={disabled}
                    precision={isIntType(type) ? 0 : undefined}
                    onBlur={onCommit}
                />
            </Form.Item>
        );
    }

    if (isStringType(type)) {
        return (
            <Form.Item
                {...argLabelProps}
                name={["args", arg.name]}
                rules={[{ validator: validateField }]}
            >
                <TextArea autoSize={{ minRows: 1 }} disabled={disabled} onBlur={onCommit} />
            </Form.Item>
        );
    }

    return (
        <Form.Item
            {...argLabelProps}
            name={["args", arg.name]}
            rules={[{ validator: validateField }]}
        >
            <Input disabled={disabled} onBlur={onCommit} />
        </Form.Item>
    );
};

const NodeMetaFields: React.FC<{
    form: FormInstance;
    selectedNode: NonNullable<ReturnType<typeof useNodeInspectorViewState>["selectedNode"]>;
    nodeDefs: NodeDef[];
    nodeDef: NodeDef | null;
    nodeDefMap: Map<string, NodeDef>;
    usingGroups: Record<string, boolean> | null;
    allFiles: string[];
    fieldEditDisabled: boolean;
    canShowOverride: boolean;
    subtreeOriginal: ReturnType<typeof useNodeInspectorViewState>["subtreeOriginal"];
    onCommit: () => void;
}> = ({
    form,
    selectedNode,
    nodeDefs,
    nodeDef,
    nodeDefMap,
    usingGroups,
    allFiles,
    fieldEditDisabled,
    canShowOverride,
    subtreeOriginal,
    onCommit,
}) => {
    const { t } = useTranslation();
    const resetField = (name: string, value: unknown) => {
        form.setFieldValue(name, value);
        queueSubmit(form);
    };

    return (
        <>
            <Form.Item {...createInspectorLabelProps(t("node.id"))} name="id">
                <Input disabled />
            </Form.Item>
            <Form.Item {...createInspectorLabelProps(t("node.type"))} name="type">
                <Input disabled />
            </Form.Item>

            {nodeDef?.group?.length ? (
                <Form.Item
                    {...createInspectorLabelProps(t("node.group"))}
                    name="group"
                    rules={[
                        {
                            validator: async () => {
                                if (!nodeDef.group?.some((group) => usingGroups?.[group])) {
                                    throw new Error(
                                        t("node.groupNotEnabled", {
                                            group: nodeDef.group,
                                        })
                                    );
                                }
                            },
                        },
                    ]}
                >
                    <Select
                        mode="multiple"
                        disabled
                        options={nodeDef.group.map((group) => ({
                            label: group,
                            value: group,
                        }))}
                    />
                </Form.Item>
            ) : null}

            <Form.Item
                {...createInspectorLabelProps(t("node.children"))}
                name="children"
                rules={[
                    {
                        validator: async () => {
                            if (
                                nodeDef?.children !== undefined &&
                                nodeDef.children !== -1 &&
                                selectedNode.activeChildCount !== nodeDef.children
                            ) {
                                throw new Error(t("node.invalidChildren"));
                            }
                        },
                    },
                ]}
            >
                <Input disabled />
            </Form.Item>

            <Form.Item
                {...createInspectorLabelProps(t("node.name"))}
                name="name"
                rules={[
                    {
                        validator: async (_, value) => {
                            const nextName = String(value ?? "").trim();
                            if (!nextName) {
                                throw new Error(
                                    t("node.notFound", { name: selectedNode.data.name })
                                );
                            }
                            if (nextName === selectedNode.data.name) {
                                return;
                            }
                            if (!nodeDefMap.has(nextName)) {
                                throw new Error(
                                    t("node.notFound", {
                                        name: nextName || selectedNode.data.name,
                                    })
                                );
                            }
                        },
                    },
                ]}
            >
                <AutoComplete
                    disabled={fieldEditDisabled}
                    options={nodeDefs.map((entry) => ({
                        label: `${entry.name} (${entry.desc})`,
                        value: entry.name,
                    }))}
                    filterOption={filterOptionByLabel}
                    onBlur={onCommit}
                    onSelect={() => queueSubmit(form)}
                />
            </Form.Item>

            <OverrideBar
                active={canShowOverride && (selectedNode.data.desc ?? "") !== (subtreeOriginal?.desc ?? "")}
                onReset={() => resetField("desc", subtreeOriginal?.desc ?? "")}
            >
                <Form.Item {...createInspectorLabelProps(t("node.desc"))} name="desc">
                    <TextArea
                        autoSize={{ minRows: 1 }}
                        disabled={fieldEditDisabled}
                        onBlur={onCommit}
                    />
                </Form.Item>
            </OverrideBar>

            <OverrideBar
                active={
                    canShowOverride &&
                    Boolean(selectedNode.data.debug) !== Boolean(subtreeOriginal?.debug)
                }
                onReset={() => resetField("debug", Boolean(subtreeOriginal?.debug))}
            >
                <Form.Item
                    {...createInspectorLabelProps(t("node.debug"))}
                    name="debug"
                    valuePropName="checked"
                >
                    <Switch
                        disabled={fieldEditDisabled && !selectedNode.data.path}
                        onChange={() => queueSubmit(form)}
                    />
                </Form.Item>
            </OverrideBar>

            <OverrideBar
                active={
                    canShowOverride &&
                    Boolean(selectedNode.data.disabled) !== Boolean(subtreeOriginal?.disabled)
                }
                onReset={() => resetField("disabled", Boolean(subtreeOriginal?.disabled))}
            >
                <Form.Item
                    {...createInspectorLabelProps(t("node.disabled"))}
                    name="disabled"
                    valuePropName="checked"
                >
                    <Switch
                        disabled={fieldEditDisabled && !selectedNode.data.path}
                        onChange={() => queueSubmit(form)}
                    />
                </Form.Item>
            </OverrideBar>

            <Form.Item {...createInspectorLabelProps(t("node.subtree"))} name="path">
                <AutoComplete
                    disabled={fieldEditDisabled || selectedNode.subtreeNode}
                    options={allFiles.map((path) => ({ label: path, value: path }))}
                    filterOption={filterOptionByLabel}
                    onBlur={onCommit}
                    onSelect={() => queueSubmit(form)}
                />
            </Form.Item>

            {nodeDef?.doc ? (
                <ReactMarkdown className="b3-v2-markdown">{nodeDef.doc}</ReactMarkdown>
            ) : null}
        </>
    );
};

const NodeVariableField: React.FC<{
    form: FormInstance;
    fieldName: SlotFieldName;
    slotDefs: string[];
    slot: string;
    index: number;
    usingVars: Record<string, VarDecl> | null;
    variableOptions: VariableOption[];
    fieldEditDisabled: boolean;
    isOverridden: (index: number, variadic?: boolean) => boolean;
    onReset: (index: number, variadic?: boolean) => void;
    onCommit: () => void;
    getRelatedArg?: (index: number) => NodeArg | null;
}> = ({
    form,
    fieldName,
    slotDefs,
    slot,
    index,
    usingVars,
    variableOptions,
    fieldEditDisabled,
    isOverridden,
    onReset,
    onCommit,
    getRelatedArg,
}) => {
    const { t } = useTranslation();
    const slotLabel = cleanSlotLabel(slot);
    const variadic = isVariadic(slotDefs, index);
    const relatedArg = getRelatedArg?.(index) ?? null;

    const validateSlotValue = async (_: unknown, value: string | undefined) => {
        const error = validateVariableValue(value, usingVars);
        if (error) {
            throw new Error(error);
        }
        if (
            relatedArg &&
            !checkOneof(relatedArg, form.getFieldValue(["args", relatedArg.name]), value)
        ) {
            throw new Error(
                t("validation.oneof", {
                    left: relatedArg.name,
                    right: slotLabel,
                })
            );
        }
    };

    if (variadic) {
        return (
            <OverrideBar active={isOverridden(index, true)} onReset={() => onReset(index, true)}>
                <Form.Item {...createInspectorLabelProps(slotLabel, !slot.includes("?"))}>
                    <Form.List name={[fieldName, index]}>
                        {(fields, { add, remove }, { errors }) => (
                            <div className="b3-v2-list-block">
                                {fields.map((field) => (
                                    <Flex key={field.key} gap={4} align="start">
                                        <Form.Item
                                            name={field.name}
                                            style={{ width: "100%", marginBottom: 2 }}
                                            validateTrigger={["onChange", "onBlur"]}
                                            rules={[{ validator: validateSlotValue }]}
                                        >
                                            <AutoComplete
                                                disabled={fieldEditDisabled}
                                                options={variableOptions}
                                                filterOption={filterOptionByLabel}
                                                onBlur={onCommit}
                                            />
                                        </Form.Item>
                                        <MinusCircleOutlined
                                            className="b3-v2-inline-remove"
                                            onClick={() => {
                                                remove(field.name);
                                                queueSubmit(form);
                                            }}
                                        />
                                    </Flex>
                                ))}
                                <Form.Item style={{ marginBottom: 0, marginTop: 4 }}>
                                    <Button
                                        type="dashed"
                                        block
                                        icon={<PlusOutlined />}
                                        onClick={() => add("")}
                                    >
                                        {t("add")}
                                    </Button>
                                    <Form.ErrorList errors={errors} />
                                </Form.Item>
                            </div>
                        )}
                    </Form.List>
                </Form.Item>
            </OverrideBar>
        );
    }

    return (
        <OverrideBar active={isOverridden(index)} onReset={() => onReset(index)}>
            <Form.Item
                {...createInspectorLabelProps(slotLabel, !slot.includes("?"))}
                name={[fieldName, index]}
                rules={[
                    {
                        required: !slot.includes("?"),
                        message: t("fieldRequired", {
                            field: slotLabel,
                        }),
                    },
                    {
                        validator: validateSlotValue,
                    },
                ]}
            >
                <AutoComplete
                    disabled={fieldEditDisabled}
                    options={variableOptions}
                    filterOption={filterOptionByLabel}
                    onBlur={onCommit}
                />
            </Form.Item>
        </OverrideBar>
    );
};

const NodeVariableSection: React.FC<{
    form: FormInstance;
    title: string;
    fieldName: SlotFieldName;
    slotDefs?: string[];
    usingVars: Record<string, VarDecl> | null;
    variableOptions: VariableOption[];
    fieldEditDisabled: boolean;
    isOverridden: (index: number, variadic?: boolean) => boolean;
    onReset: (index: number, variadic?: boolean) => void;
    onCommit: () => void;
    getRelatedArg?: (index: number) => NodeArg | null;
}> = ({
    form,
    title,
    fieldName,
    slotDefs,
    usingVars,
    variableOptions,
    fieldEditDisabled,
    isOverridden,
    onReset,
    onCommit,
    getRelatedArg,
}) => {
    if (!slotDefs?.length) {
        return null;
    }

    return (
        <>
            <SectionDivider>{title}</SectionDivider>
            {slotDefs.map((slot, index) => (
                <NodeVariableField
                    key={`${fieldName}-${index}`}
                    form={form}
                    fieldName={fieldName}
                    slotDefs={slotDefs}
                    slot={slot}
                    index={index}
                    usingVars={usingVars}
                    variableOptions={variableOptions}
                    fieldEditDisabled={fieldEditDisabled}
                    isOverridden={isOverridden}
                    onReset={onReset}
                    onCommit={onCommit}
                    getRelatedArg={getRelatedArg}
                />
            ))}
        </>
    );
};

const NodeStructuredArgsSection: React.FC<{
    form: FormInstance;
    nodeDef: NodeDef;
    args: NodeArg[];
    usingVars: Record<string, VarDecl> | null;
    checkExpr: boolean;
    fieldEditDisabled: boolean;
    isOverridden: (argName: string) => boolean;
    onReset: (arg: NodeArg) => void;
    onCommit: () => void;
}> = ({
    form,
    nodeDef,
    args,
    usingVars,
    checkExpr,
    fieldEditDisabled,
    isOverridden,
    onReset,
    onCommit,
}) => {
    const { t } = useTranslation();

    if (args.length === 0) {
        return null;
    }

    return (
        <>
            <SectionDivider>{t("node.args")}</SectionDivider>
            {args.map((arg) => (
                <OverrideBar
                    key={`arg-${arg.name}`}
                    active={isOverridden(arg.name)}
                    onReset={() => onReset(arg)}
                >
                    <NodeArgField
                        form={form}
                        arg={arg}
                        nodeDef={nodeDef}
                        usingVars={usingVars}
                        checkExpr={checkExpr}
                        disabled={fieldEditDisabled}
                        onCommit={onCommit}
                    />
                </OverrideBar>
            ))}
        </>
    );
};

const NodeRawJsonSection: React.FC<{ visible: boolean }> = ({ visible }) => {
    const { t } = useTranslation();

    if (!visible) {
        return null;
    }

    return (
        <>
            <SectionDivider>{t("node.jsonData")}</SectionDivider>
            <Form.Item {...createInspectorLabelProps(t("node.jsonData"))} name="rawNodeJson">
                <TextArea autoSize={{ minRows: 1 }} disabled />
            </Form.Item>
        </>
    );
};

export const NodeInspectorForm: React.FC = () => {
    const runtime = useRuntime();
    const { t } = useTranslation();
    const [form] = Form.useForm();
    const {
        selectedNode,
        nodeDefs,
        usingVars,
        usingGroups,
        allFiles,
        checkExpr,
        nodeDefMap,
        variableOptions,
        nodeDef,
        fieldEditDisabled,
        title,
        structuredArgs,
        hasStructuredArgs,
        shouldShowRawNodeJson,
        subtreeOriginal,
        canShowOverride,
    } = useNodeInspectorViewState(form);
    const inspectorTitle = title || t("node.unknown.title");

    useEffect(() => {
        if (!selectedNode) {
            return;
        }

        const currentNodeDef = nodeDefMap.get(selectedNode.data.name) ?? null;
        form.setFieldsValue(
            createNodeInspectorFormValues(currentNodeDef, selectedNode, t("node.unknownType"))
        );
    }, [form, nodeDefMap, selectedNode, t]);

    useEffect(() => {
        if (!selectedNode) {
            return;
        }

        const timer = window.setTimeout(() => {
            void form.validateFields({ recursive: true }).catch(() => undefined);
        }, 100);

        return () => window.clearTimeout(timer);
    }, [form, selectedNode, usingVars, usingGroups, checkExpr, nodeDef]);

    if (!selectedNode) {
        return null;
    }

    const submitNodeForm = () => {
        void form.submit();
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

    const resetSlotField = (
        fieldName: SlotFieldName,
        originalSlots: string[] | undefined,
        index: number,
        variadic = false
    ) => {
        form.setFieldValue([fieldName, index], getNodeSlotFormValue(originalSlots, index, variadic));
        queueSubmit(form);
    };

    const isInputOverridden = (index: number, variadic = false) =>
        isSlotOverridden(selectedNode.data.input, subtreeOriginal?.input, index, variadic);
    const isOutputOverridden = (index: number, variadic = false) =>
        isSlotOverridden(selectedNode.data.output, subtreeOriginal?.output, index, variadic);
    const isArgOverridden = (argName: string) =>
        canShowOverride &&
        !compareJsonValue(selectedNode.data.args?.[argName], subtreeOriginal?.args?.[argName]);

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
        queueSubmit(form);
    };

    const relatedArgForInput = (index: number) => {
        if (!nodeDef) {
            return null;
        }
        const slotName = cleanSlotLabel(nodeDef.input?.[index] ?? "");
        return nodeDef.args?.find((arg) => arg.oneof === slotName) ?? null;
    };

    return (
        <>
            <div className="b3-v2-inspector-header">
                <Typography.Title level={5} style={{ margin: 0 }}>
                    {inspectorTitle}
                </Typography.Title>
            </div>
            <div className="b3-v2-inspector-content">
                <Form
                    key={selectedNode.ref.instanceKey}
                    form={form}
                    className="b3-v2-inspector-form"
                    labelCol={{ span: "auto" }}
                    wrapperCol={{ span: "auto" }}
                    labelAlign="right"
                    requiredMark={false}
                    onFinish={(values) => {
                        try {
                            const currentNodeDef =
                                nodeDefs.find(
                                    (entry) => entry.name === String(values.name ?? "").trim()
                                ) ?? null;
                            const args = currentNodeDef
                                ? Object.fromEntries(
                                      (currentNodeDef.args ?? [])
                                          .map((arg) => [
                                              arg.name,
                                              parseArgSubmitValue(arg, values.args?.[arg.name]),
                                          ])
                                          .filter(([, value]) => value !== undefined)
                                  )
                                : selectedNode.data.args;

                            void runtime.controller.updateNode({
                                target: selectedNode.ref,
                                data: {
                                    name:
                                        String(values.name ?? selectedNode.data.name).trim() ||
                                        selectedNode.data.name,
                                    desc: values.desc?.trim() || undefined,
                                    path:
                                        selectedNode.subtreeNode || fieldEditDisabled
                                            ? selectedNode.data.path
                                            : values.path?.trim() || undefined,
                                    debug: Boolean(values.debug),
                                    disabled: Boolean(values.disabled),
                                    input: buildNodeSlotArray(
                                        currentNodeDef?.input,
                                        values.inputSlots,
                                        selectedNode.data.input
                                    ),
                                    output: buildNodeSlotArray(
                                        currentNodeDef?.output,
                                        values.outputSlots,
                                        selectedNode.data.output
                                    ),
                                    args,
                                },
                            });
                        } catch (error) {
                            runtime.hostAdapter.log(
                                "warn",
                                `[v2] node form submit failed: ${String(error)}`
                            );
                        }
                    }}
                >
                    <NodeMetaFields
                        form={form}
                        selectedNode={selectedNode}
                        nodeDefs={nodeDefs}
                        nodeDef={nodeDef}
                        nodeDefMap={nodeDefMap}
                        usingGroups={usingGroups}
                        allFiles={allFiles}
                        fieldEditDisabled={fieldEditDisabled}
                        canShowOverride={canShowOverride}
                        subtreeOriginal={subtreeOriginal}
                        onCommit={submitNodeForm}
                    />

                    <NodeVariableSection
                        form={form}
                        title={t("node.inputVariable")}
                        fieldName="inputSlots"
                        slotDefs={nodeDef?.input}
                        usingVars={usingVars}
                        variableOptions={variableOptions}
                        fieldEditDisabled={fieldEditDisabled}
                        isOverridden={isInputOverridden}
                        onReset={resetInputField}
                        onCommit={submitNodeForm}
                        getRelatedArg={relatedArgForInput}
                    />

                    {hasStructuredArgs && nodeDef ? (
                        <NodeStructuredArgsSection
                            form={form}
                            nodeDef={nodeDef}
                            args={structuredArgs}
                            usingVars={usingVars}
                            checkExpr={checkExpr}
                            fieldEditDisabled={fieldEditDisabled}
                            isOverridden={isArgOverridden}
                            onReset={resetArgField}
                            onCommit={submitNodeForm}
                        />
                    ) : (
                        <NodeRawJsonSection visible={shouldShowRawNodeJson} />
                    )}

                    <NodeVariableSection
                        form={form}
                        title={t("node.outputVariable")}
                        fieldName="outputSlots"
                        slotDefs={nodeDef?.output}
                        usingVars={usingVars}
                        variableOptions={variableOptions}
                        fieldEditDisabled={fieldEditDisabled}
                        isOverridden={isOutputOverridden}
                        onReset={resetOutputField}
                        onCommit={submitNodeForm}
                    />
                </Form>
            </div>
        </>
    );
};
