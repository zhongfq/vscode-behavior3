import { FormOutlined, MinusCircleOutlined, PlusOutlined } from "@ant-design/icons";
import { AutoComplete, Button, Flex, Form, Input, Select, Switch, Typography } from "antd";
import type { FormInstance } from "antd/es/form";
import React, { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useRuntime } from "../../app/runtime";
import { isValidVariableName } from "../../shared/misc/b3util";
import {
    SectionDivider,
    VariableDeclRow,
    type VariableRowValue,
    createInspectorLabelProps,
    filterOptionByLabel,
    queueSubmit,
} from "./inspector-shared";
import {
    createTreeInspectorFormValues,
    createTreeMetaPayload,
    useTreeInspectorViewState,
} from "./inspector-state";

const { TextArea } = Input;

const TreeMetaFields: React.FC<{
    form: FormInstance;
    groupDefs: string[];
}> = ({ form, groupDefs }) => {
    const { t } = useTranslation();
    const submitTreeForm = () => {
        void form.submit();
    };

    return (
        <>
            <Form.Item {...createInspectorLabelProps(t("tree.name"))} name="name">
                <Input disabled />
            </Form.Item>
            <Form.Item {...createInspectorLabelProps(t("tree.desc"))} name="desc">
                <TextArea autoSize={{ minRows: 1 }} onBlur={submitTreeForm} />
            </Form.Item>
            <Form.Item {...createInspectorLabelProps(t("tree.prefix"))} name="prefix">
                <Input onBlur={submitTreeForm} />
            </Form.Item>
            <Form.Item
                {...createInspectorLabelProps(t("tree.export"))}
                name="export"
                valuePropName="checked"
            >
                <Switch onChange={() => queueSubmit(form)} />
            </Form.Item>

            {groupDefs.length > 0 ? (
                <>
                    <SectionDivider>{t("tree.group")}</SectionDivider>
                    <Form.Item name="group">
                        <Select
                            mode="multiple"
                            placeholder={t("tree.group.placeholder")}
                            options={groupDefs.map((group) => ({
                                label: group,
                                value: group,
                            }))}
                            onChange={() => queueSubmit(form)}
                        />
                    </Form.Item>
                </>
            ) : null}
        </>
    );
};

const LocalVariablesSection: React.FC<{
    form: FormInstance;
    onFocusVariable: (name: string) => void;
}> = ({ form, onFocusVariable }) => {
    const { t } = useTranslation();
    const submitTreeForm = () => {
        void form.submit();
    };

    return (
        <>
            <SectionDivider>{t("tree.vars.local")}</SectionDivider>
            <Form.List name="vars">
                {(fields, { add, remove }, { errors }) => (
                    <div className="b3-v2-list-block">
                        {fields.map((field) => (
                            <Form.Item
                                key={field.key}
                                name={field.name}
                                style={{ marginBottom: 2 }}
                                validateTrigger={["onChange", "onBlur"]}
                                rules={[
                                    {
                                        validator: async (_, value: VariableRowValue) => {
                                            if (!value?.name || !isValidVariableName(value.name)) {
                                                throw new Error(t("tree.vars.invalidName"));
                                            }
                                            if (!value.desc?.trim()) {
                                                throw new Error(
                                                    t("validation.variableDescriptionRequired")
                                                );
                                            }
                                        },
                                    },
                                ]}
                            >
                                <VariableDeclRow
                                    onSubmit={submitTreeForm}
                                    onRemove={() => {
                                        remove(field.name);
                                        queueSubmit(form);
                                    }}
                                    onFocusVariable={onFocusVariable}
                                />
                            </Form.Item>
                        ))}
                        <Form.Item style={{ marginBottom: 0, marginTop: 4 }}>
                            <Button
                                type="dashed"
                                block
                                icon={<PlusOutlined />}
                                onClick={() => add({ name: "", desc: "" })}
                            >
                                {t("tree.vars.add")}
                            </Button>
                            <Form.ErrorList errors={errors} />
                        </Form.Item>
                    </div>
                )}
            </Form.List>
        </>
    );
};

const SubtreeVariablesSection: React.FC<{
    rows: Array<{ path: string; vars: VariableRowValue[] }>;
    onOpenSubtree: (path: string) => void;
    onFocusVariable: (name: string) => void;
}> = ({ rows, onOpenSubtree, onFocusVariable }) => {
    const { t } = useTranslation();

    if (rows.length === 0) {
        return null;
    }

    return (
        <>
            <SectionDivider>{t("tree.vars.subtree")}</SectionDivider>
            <div className="b3-v2-list-block">
                {rows.map((entry) => (
                    <div key={entry.path} className="b3-v2-decl-group">
                        <Flex gap={4} align="center">
                            <Form.Item style={{ flex: 1, marginBottom: 2 }}>
                                <Input value={entry.path} disabled />
                            </Form.Item>
                            <FormOutlined
                                className="b3-v2-inline-action"
                                onClick={() => onOpenSubtree(entry.path)}
                            />
                        </Flex>
                        <div className="b3-v2-decl-vars">
                            {entry.vars.map((variable) => (
                                <VariableDeclRow
                                    key={`${entry.path}:${variable.name}`}
                                    value={variable}
                                    disabled
                                    onFocusVariable={onFocusVariable}
                                />
                            ))}
                        </div>
                    </div>
                ))}
            </div>
        </>
    );
};

const ImportRefsSection: React.FC<{
    form: FormInstance;
    allFiles: string[];
    currentImportRefs: Array<{ path?: string }>;
    importDeclByPath: Map<string, VariableRowValue[]>;
    onFocusVariable: (name: string) => void;
}> = ({ form, allFiles, currentImportRefs, importDeclByPath, onFocusVariable }) => {
    const { t } = useTranslation();
    const submitTreeForm = () => {
        void form.submit();
    };

    return (
        <>
            <SectionDivider>{t("tree.vars.imports")}</SectionDivider>
            <Form.List name="importRefs">
                {(fields, { add, remove }, { errors }) => (
                    <div className="b3-v2-list-block">
                        {fields.map((field) => {
                            const currentPath = currentImportRefs[field.name]?.path?.trim() ?? "";
                            const importVars = currentPath
                                ? (importDeclByPath.get(currentPath) ?? [])
                                : [];

                            return (
                                <div key={field.key} className="b3-v2-decl-group">
                                    <Flex gap={4} align="center">
                                        <Form.Item
                                            name={[field.name, "path"]}
                                            style={{ flex: 1, marginBottom: 2 }}
                                        >
                                            <AutoComplete
                                                options={allFiles.map((path) => ({
                                                    label: path,
                                                    value: path,
                                                }))}
                                                filterOption={filterOptionByLabel}
                                                onBlur={submitTreeForm}
                                                onSelect={() => queueSubmit(form)}
                                            />
                                        </Form.Item>
                                        <MinusCircleOutlined
                                            className="b3-v2-inline-remove-compact"
                                            onClick={() => {
                                                remove(field.name);
                                                queueSubmit(form);
                                            }}
                                        />
                                    </Flex>
                                    <div className="b3-v2-decl-vars">
                                        {importVars.map((variable) => (
                                            <VariableDeclRow
                                                key={`${currentPath}:${variable.name}`}
                                                value={variable}
                                                disabled
                                                onFocusVariable={onFocusVariable}
                                            />
                                        ))}
                                    </div>
                                </div>
                            );
                        })}
                        <Form.Item style={{ marginBottom: 0, marginTop: 4 }}>
                            <Button
                                type="dashed"
                                block
                                icon={<PlusOutlined />}
                                onClick={() => add({ path: "" })}
                            >
                                {t("tree.import.add")}
                            </Button>
                            <Form.ErrorList errors={errors} />
                        </Form.Item>
                    </div>
                )}
            </Form.List>
        </>
    );
};

export const TreeInspectorForm: React.FC = () => {
    const runtime = useRuntime();
    const { t } = useTranslation();
    const [form] = Form.useForm();
    const {
        document,
        groupDefs,
        allFiles,
        variableUsageCount,
        currentImportRefs,
        subtreeRows,
        importDeclByPath,
    } = useTreeInspectorViewState(form);

    useEffect(() => {
        if (!document) {
            return;
        }

        form.setFieldsValue(createTreeInspectorFormValues(document, variableUsageCount));
    }, [document, form, variableUsageCount]);

    if (!document) {
        return null;
    }

    const focusVariable = (name: string) => {
        void runtime.controller.focusVariable([name]);
    };

    const openSubtree = (path: string) => {
        void runtime.controller.openSubtreePath(path);
    };

    return (
        <>
            <div className="b3-v2-inspector-header">
                <Typography.Title level={5} style={{ margin: 0 }}>
                    {t("tree.overview")}
                </Typography.Title>
            </div>
            <div className="b3-v2-inspector-content">
                <Form
                    form={form}
                    className="b3-v2-inspector-form"
                    labelCol={{ span: "auto" }}
                    wrapperCol={{ span: "auto" }}
                    labelAlign="right"
                    requiredMark={false}
                    onFinish={(values) => {
                        void runtime.controller.updateTreeMeta(createTreeMetaPayload(values));
                    }}
                >
                    <TreeMetaFields form={form} groupDefs={groupDefs} />
                    <LocalVariablesSection form={form} onFocusVariable={focusVariable} />
                    <SubtreeVariablesSection
                        rows={subtreeRows}
                        onOpenSubtree={openSubtree}
                        onFocusVariable={focusVariable}
                    />
                    <ImportRefsSection
                        form={form}
                        allFiles={allFiles}
                        currentImportRefs={currentImportRefs}
                        importDeclByPath={importDeclByPath}
                        onFocusVariable={focusVariable}
                    />
                </Form>
            </div>
        </>
    );
};
