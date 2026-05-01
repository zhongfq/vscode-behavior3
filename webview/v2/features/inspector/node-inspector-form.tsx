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
} from "../../../shared/misc/b3type";
import {
    checkOneof,
    getNodeArgOptions,
    getNodeArgRawType,
    isNodeArgArray,
    isNodeArgOptional,
    isVariadic,
} from "../../../shared/misc/b3util";
import {
    useDocumentStore,
    useRuntime,
    useSelectionStore,
    useWorkspaceStore,
} from "../../app/runtime";
import {
    OverrideBar,
    SectionDivider,
    cleanSlotLabel,
    compareJsonValue,
    createInspectorLabelProps,
    createNodeDefMap,
    createVariableOptions,
    filterOptionByLabel,
    formatArgInitialValue,
    formatChildrenLabel,
    parseArgSubmitValue,
    queueSubmit,
    validateExpressionValues,
    validateVariableValue,
} from "./inspector-shared";

const { TextArea } = Input;

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
                    options={options.map((option) => ({
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

export const NodeInspectorForm: React.FC = () => {
    const runtime = useRuntime();
    const { t } = useTranslation();
    const document = useDocumentStore((state) => state.persistedTree);
    const selectedNode = useSelectionStore((state) => state.selectedNodeSnapshot);
    const nodeDefs = useWorkspaceStore((state) => state.nodeDefs);
    const usingVars = useWorkspaceStore((state) => state.usingVars);
    const usingGroups = useWorkspaceStore((state) => state.usingGroups);
    const allFiles = useWorkspaceStore((state) => state.allFiles);
    const checkExpr = useWorkspaceStore((state) => state.settings.checkExpr);
    const [form] = Form.useForm();

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
    const title = nodeDef?.desc || effectiveName || t("node.unknown.title");
    const structuredArgs = nodeDef?.args ?? [];
    const hasStructuredArgs = structuredArgs.length > 0;
    const shouldShowRawNodeJson = nodeDef === null;

    useEffect(() => {
        if (!selectedNode) {
            return;
        }

        const currentNodeDef = nodeDefMap.get(selectedNode.data.name) ?? null;

        form.setFieldsValue({
            id: selectedNode.ref.displayId,
            type: currentNodeDef?.type ?? t("node.unknownType"),
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
                currentNodeDef?.input && isVariadic(currentNodeDef.input, index)
                    ? (selectedNode.data.input?.slice(index) ?? [])
                    : (selectedNode.data.input?.[index] ?? "")
            ),
            outputSlots: (currentNodeDef?.output ?? []).map((_, index) =>
                currentNodeDef?.output && isVariadic(currentNodeDef.output, index)
                    ? (selectedNode.data.output?.slice(index) ?? [])
                    : (selectedNode.data.output?.[index] ?? "")
            ),
            rawNodeJson: JSON.stringify(selectedNode.data ?? {}, null, 2),
        });
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

    const subtreeOriginal = selectedNode.subtreeOriginal;
    const canShowOverride = Boolean(selectedNode.subtreeNode && subtreeOriginal);

    const isInputOverridden = (index: number, variadic = false) => {
        if (!canShowOverride) {
            return false;
        }
        if (variadic) {
            return !compareJsonValue(
                selectedNode.data.input?.slice(index) ?? [],
                subtreeOriginal?.input?.slice(index) ?? []
            );
        }
        return (selectedNode.data.input?.[index] ?? "") !== (subtreeOriginal?.input?.[index] ?? "");
    };

    const isOutputOverridden = (index: number, variadic = false) => {
        if (!canShowOverride) {
            return false;
        }
        if (variadic) {
            return !compareJsonValue(
                selectedNode.data.output?.slice(index) ?? [],
                subtreeOriginal?.output?.slice(index) ?? []
            );
        }
        return (
            (selectedNode.data.output?.[index] ?? "") !== (subtreeOriginal?.output?.[index] ?? "")
        );
    };

    const isArgOverridden = (argName: string) => {
        if (!canShowOverride) {
            return false;
        }
        return !compareJsonValue(
            selectedNode.data.args?.[argName],
            subtreeOriginal?.args?.[argName]
        );
    };

    const submitNodeForm = () => {
        void form.submit();
    };

    const buildInputArray = (currentNodeDef: NodeDef | null, values: Record<string, unknown>) => {
        if (!currentNodeDef?.input?.length) {
            return selectedNode.data.input;
        }

        const slots = ((values.inputSlots ?? []) as Array<string | string[]>).slice();
        const nextValue: string[] = [];

        currentNodeDef.input.forEach((slot, index) => {
            const rawValue = slots[index];
            if (isVariadic(currentNodeDef.input!, index)) {
                const entries = Array.isArray(rawValue) ? rawValue : [];
                nextValue.push(
                    ...entries.filter((entry): entry is string => typeof entry === "string")
                );
            } else {
                nextValue.push(typeof rawValue === "string" ? rawValue : "");
            }
            if (
                slot === currentNodeDef.input![currentNodeDef.input!.length - 1] &&
                isVariadic(currentNodeDef.input!, index)
            ) {
                return;
            }
        });

        return nextValue;
    };

    const buildOutputArray = (currentNodeDef: NodeDef | null, values: Record<string, unknown>) => {
        if (!currentNodeDef?.output?.length) {
            return selectedNode.data.output;
        }

        const slots = ((values.outputSlots ?? []) as Array<string | string[]>).slice();
        const nextValue: string[] = [];

        currentNodeDef.output.forEach((slot, index) => {
            const rawValue = slots[index];
            if (isVariadic(currentNodeDef.output!, index)) {
                const entries = Array.isArray(rawValue) ? rawValue : [];
                nextValue.push(
                    ...entries.filter((entry): entry is string => typeof entry === "string")
                );
            } else {
                nextValue.push(typeof rawValue === "string" ? rawValue : "");
            }
            if (
                slot === currentNodeDef.output![currentNodeDef.output!.length - 1] &&
                isVariadic(currentNodeDef.output!, index)
            ) {
                return;
            }
        });

        return nextValue;
    };

    const resetInputField = (index: number, variadic = false) => {
        form.setFieldValue(
            ["inputSlots", index],
            variadic
                ? (subtreeOriginal?.input?.slice(index) ?? [])
                : (subtreeOriginal?.input?.[index] ?? "")
        );
        queueSubmit(form);
    };

    const resetOutputField = (index: number, variadic = false) => {
        form.setFieldValue(
            ["outputSlots", index],
            variadic
                ? (subtreeOriginal?.output?.slice(index) ?? [])
                : (subtreeOriginal?.output?.[index] ?? "")
        );
        queueSubmit(form);
    };

    const resetArgField = (arg: NodeArg) => {
        form.setFieldValue(
            ["args", arg.name],
            formatArgInitialValue(arg, subtreeOriginal?.args?.[arg.name])
        );
        queueSubmit(form);
    };

    const relatedArgForInput = (currentNodeDef: NodeDef, index: number) => {
        const slotName = cleanSlotLabel(currentNodeDef.input?.[index] ?? "");
        return currentNodeDef.args?.find((arg) => arg.oneof === slotName) ?? null;
    };

    return (
        <>
            <div className="b3-v2-inspector-header">
                <Typography.Title level={5} style={{ margin: 0 }}>
                    {title}
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
                                    input: buildInputArray(currentNodeDef, values),
                                    output: buildOutputArray(currentNodeDef, values),
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
                            onBlur={submitNodeForm}
                            onSelect={() => queueSubmit(form)}
                        />
                    </Form.Item>

                    <OverrideBar
                        active={
                            canShowOverride &&
                            (selectedNode.data.desc ?? "") !== (subtreeOriginal?.desc ?? "")
                        }
                        onReset={() => {
                            form.setFieldValue("desc", subtreeOriginal?.desc ?? "");
                            queueSubmit(form);
                        }}
                    >
                        <Form.Item {...createInspectorLabelProps(t("node.desc"))} name="desc">
                            <TextArea
                                autoSize={{ minRows: 1 }}
                                disabled={fieldEditDisabled}
                                onBlur={submitNodeForm}
                            />
                        </Form.Item>
                    </OverrideBar>

                    <OverrideBar
                        active={
                            canShowOverride &&
                            Boolean(selectedNode.data.debug) !== Boolean(subtreeOriginal?.debug)
                        }
                        onReset={() => {
                            form.setFieldValue("debug", Boolean(subtreeOriginal?.debug));
                            queueSubmit(form);
                        }}
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
                            Boolean(selectedNode.data.disabled) !==
                                Boolean(subtreeOriginal?.disabled)
                        }
                        onReset={() => {
                            form.setFieldValue("disabled", Boolean(subtreeOriginal?.disabled));
                            queueSubmit(form);
                        }}
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
                            onBlur={submitNodeForm}
                            onSelect={() => queueSubmit(form)}
                        />
                    </Form.Item>

                    {nodeDef?.doc ? (
                        <ReactMarkdown className="b3-v2-markdown">{nodeDef.doc}</ReactMarkdown>
                    ) : null}

                    {nodeDef?.input?.length ? (
                        <>
                            <SectionDivider>{t("node.inputVariable")}</SectionDivider>
                            {nodeDef.input.map((slot, index) => {
                                const slotLabel = cleanSlotLabel(slot);
                                const relatedArg = relatedArgForInput(nodeDef, index);

                                if (isVariadic(nodeDef.input!, index)) {
                                    return (
                                        <OverrideBar
                                            key={`input-slot-${index}`}
                                            active={isInputOverridden(index, true)}
                                            onReset={() => resetInputField(index, true)}
                                        >
                                            <Form.Item
                                                {...createInspectorLabelProps(
                                                    slotLabel,
                                                    !slot.includes("?")
                                                )}
                                            >
                                                <Form.List name={["inputSlots", index]}>
                                                    {(fields, { add, remove }, { errors }) => (
                                                        <div className="b3-v2-list-block">
                                                            {fields.map((field) => (
                                                                <Flex
                                                                    key={field.key}
                                                                    gap={4}
                                                                    align="start"
                                                                >
                                                                    <Form.Item
                                                                        name={field.name}
                                                                        style={{
                                                                            width: "100%",
                                                                            marginBottom: 2,
                                                                        }}
                                                                        validateTrigger={[
                                                                            "onChange",
                                                                            "onBlur",
                                                                        ]}
                                                                        rules={[
                                                                            {
                                                                                validator: async (
                                                                                    _,
                                                                                    value:
                                                                                        | string
                                                                                        | undefined
                                                                                ) => {
                                                                                    const error =
                                                                                        validateVariableValue(
                                                                                            value,
                                                                                            usingVars
                                                                                        );
                                                                                    if (error) {
                                                                                        throw new Error(
                                                                                            error
                                                                                        );
                                                                                    }
                                                                                    if (
                                                                                        relatedArg &&
                                                                                        !checkOneof(
                                                                                            relatedArg,
                                                                                            form.getFieldValue(
                                                                                                [
                                                                                                    "args",
                                                                                                    relatedArg.name,
                                                                                                ]
                                                                                            ),
                                                                                            value
                                                                                        )
                                                                                    ) {
                                                                                        throw new Error(
                                                                                            t(
                                                                                                "validation.oneof",
                                                                                                {
                                                                                                    left: relatedArg.name,
                                                                                                    right: slotLabel,
                                                                                                }
                                                                                            )
                                                                                        );
                                                                                    }
                                                                                },
                                                                            },
                                                                        ]}
                                                                    >
                                                                        <AutoComplete
                                                                            disabled={
                                                                                fieldEditDisabled
                                                                            }
                                                                            options={
                                                                                variableOptions
                                                                            }
                                                                            filterOption={
                                                                                filterOptionByLabel
                                                                            }
                                                                            onBlur={submitNodeForm}
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
                                                            <Form.Item
                                                                style={{
                                                                    marginBottom: 0,
                                                                    marginTop: 4,
                                                                }}
                                                            >
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
                                    <OverrideBar
                                        key={`input-slot-${index}`}
                                        active={isInputOverridden(index)}
                                        onReset={() => resetInputField(index)}
                                    >
                                        <Form.Item
                                            {...createInspectorLabelProps(
                                                slotLabel,
                                                !slot.includes("?")
                                            )}
                                            name={["inputSlots", index]}
                                            rules={[
                                                {
                                                    required: !slot.includes("?"),
                                                    message: t("fieldRequired", {
                                                        field: slotLabel,
                                                    }),
                                                },
                                                {
                                                    validator: async (
                                                        _,
                                                        value: string | undefined
                                                    ) => {
                                                        const error = validateVariableValue(
                                                            value,
                                                            usingVars
                                                        );
                                                        if (error) {
                                                            throw new Error(error);
                                                        }
                                                        if (
                                                            relatedArg &&
                                                            !checkOneof(
                                                                relatedArg,
                                                                form.getFieldValue([
                                                                    "args",
                                                                    relatedArg.name,
                                                                ]),
                                                                value
                                                            )
                                                        ) {
                                                            throw new Error(
                                                                t("validation.oneof", {
                                                                    left: relatedArg.name,
                                                                    right: slotLabel,
                                                                })
                                                            );
                                                        }
                                                    },
                                                },
                                            ]}
                                        >
                                            <AutoComplete
                                                disabled={fieldEditDisabled}
                                                options={variableOptions}
                                                filterOption={filterOptionByLabel}
                                                onBlur={submitNodeForm}
                                            />
                                        </Form.Item>
                                    </OverrideBar>
                                );
                            })}
                        </>
                    ) : null}

                    {hasStructuredArgs && nodeDef ? (
                        <>
                            <SectionDivider>{t("node.args")}</SectionDivider>
                            {structuredArgs.map((arg) => (
                                <OverrideBar
                                    key={`arg-${arg.name}`}
                                    active={isArgOverridden(arg.name)}
                                    onReset={() => resetArgField(arg)}
                                >
                                    <NodeArgField
                                        form={form}
                                        arg={arg}
                                        nodeDef={nodeDef}
                                        usingVars={usingVars}
                                        checkExpr={checkExpr}
                                        disabled={fieldEditDisabled}
                                        onCommit={submitNodeForm}
                                    />
                                </OverrideBar>
                            ))}
                        </>
                    ) : shouldShowRawNodeJson ? (
                        <>
                            <SectionDivider>{t("node.jsonData")}</SectionDivider>
                            <Form.Item
                                {...createInspectorLabelProps(t("node.jsonData"))}
                                name="rawNodeJson"
                            >
                                <TextArea autoSize={{ minRows: 1 }} disabled />
                            </Form.Item>
                        </>
                    ) : null}

                    {nodeDef?.output?.length ? (
                        <>
                            <SectionDivider>{t("node.outputVariable")}</SectionDivider>
                            {nodeDef.output.map((slot, index) => {
                                const slotLabel = cleanSlotLabel(slot);

                                if (isVariadic(nodeDef.output!, index)) {
                                    return (
                                        <OverrideBar
                                            key={`output-slot-${index}`}
                                            active={isOutputOverridden(index, true)}
                                            onReset={() => resetOutputField(index, true)}
                                        >
                                            <Form.Item
                                                {...createInspectorLabelProps(
                                                    slotLabel,
                                                    !slot.includes("?")
                                                )}
                                            >
                                                <Form.List name={["outputSlots", index]}>
                                                    {(fields, { add, remove }, { errors }) => (
                                                        <div className="b3-v2-list-block">
                                                            {fields.map((field) => (
                                                                <Flex
                                                                    key={field.key}
                                                                    gap={4}
                                                                    align="start"
                                                                >
                                                                    <Form.Item
                                                                        name={field.name}
                                                                        style={{
                                                                            width: "100%",
                                                                            marginBottom: 2,
                                                                        }}
                                                                        validateTrigger={[
                                                                            "onChange",
                                                                            "onBlur",
                                                                        ]}
                                                                        rules={[
                                                                            {
                                                                                validator: async (
                                                                                    _,
                                                                                    value:
                                                                                        | string
                                                                                        | undefined
                                                                                ) => {
                                                                                    const error =
                                                                                        validateVariableValue(
                                                                                            value,
                                                                                            usingVars
                                                                                        );
                                                                                    if (error) {
                                                                                        throw new Error(
                                                                                            error
                                                                                        );
                                                                                    }
                                                                                },
                                                                            },
                                                                        ]}
                                                                    >
                                                                        <AutoComplete
                                                                            disabled={
                                                                                fieldEditDisabled
                                                                            }
                                                                            options={
                                                                                variableOptions
                                                                            }
                                                                            filterOption={
                                                                                filterOptionByLabel
                                                                            }
                                                                            onBlur={submitNodeForm}
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
                                                            <Form.Item
                                                                style={{
                                                                    marginBottom: 0,
                                                                    marginTop: 4,
                                                                }}
                                                            >
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
                                    <OverrideBar
                                        key={`output-slot-${index}`}
                                        active={isOutputOverridden(index)}
                                        onReset={() => resetOutputField(index)}
                                    >
                                        <Form.Item
                                            {...createInspectorLabelProps(
                                                slotLabel,
                                                !slot.includes("?")
                                            )}
                                            name={["outputSlots", index]}
                                            rules={[
                                                {
                                                    required: !slot.includes("?"),
                                                    message: t("fieldRequired", {
                                                        field: slotLabel,
                                                    }),
                                                },
                                                {
                                                    validator: async (
                                                        _,
                                                        value: string | undefined
                                                    ) => {
                                                        const error = validateVariableValue(
                                                            value,
                                                            usingVars
                                                        );
                                                        if (error) {
                                                            throw new Error(error);
                                                        }
                                                    },
                                                },
                                            ]}
                                        >
                                            <AutoComplete
                                                disabled={fieldEditDisabled}
                                                options={variableOptions}
                                                filterOption={filterOptionByLabel}
                                                onBlur={submitNodeForm}
                                            />
                                        </Form.Item>
                                    </OverrideBar>
                                );
                            })}
                        </>
                    ) : null}
                </Form>
            </div>
        </>
    );
};
