import { AimOutlined, MinusCircleOutlined } from "@ant-design/icons";
import { Divider, Flex, Input, Popconfirm, Space } from "antd";
import type { FormInstance } from "antd/es/form";
import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ExpressionEvaluator } from "../../../../behavior3/src/behavior3/evaluator";
import {
    hasArgOptions,
    isBoolType,
    isExprType,
    isFloatType,
    isIntType,
    isJsonType,
    type NodeArg,
    type NodeDef,
    type VarDecl,
} from "../../../shared/misc/b3type";
import {
    dfs,
    getNodeArgRawType,
    isNodeArgArray,
    isNodeArgOptional,
    isValidVariableName,
    isVariadic,
    parseExpr,
} from "../../../shared/misc/b3util";
import i18n from "../../../shared/misc/i18n";

export type VariableOption = {
    label: string;
    value: string;
};

export type VariableRowValue = VarDecl & {
    count?: number;
};

type VariableUsageNode = {
    name: string;
    args?: Record<string, unknown>;
    input?: string[];
    output?: string[];
    children?: VariableUsageNode[];
};

export const queueSubmit = (form: FormInstance) => {
    window.setTimeout(() => {
        void form.submit();
    }, 0);
};

export const cleanSlotLabel = (value: string) => value.replace(/\?$/, "").replace(/\.\.\.$/, "");

export const createNodeDefMap = (nodeDefs: NodeDef[]) => {
    const map = new Map<string, NodeDef>();
    for (const nodeDef of nodeDefs) {
        map.set(nodeDef.name, nodeDef);
    }
    return map;
};

export const buildVariableUsageCount = (
    root: VariableUsageNode | null,
    nodeDefMap: Map<string, NodeDef>
) => {
    const count: Record<string, number> = {};

    if (!root) {
        return count;
    }

    dfs(root, (node) => {
        const nodeDef = nodeDefMap.get(node.name);
        if (!nodeDef) {
            return;
        }

        node.input?.forEach((variable) => {
            if (!variable) {
                return;
            }
            count[variable] = (count[variable] ?? 0) + 1;
        });

        node.output?.forEach((variable) => {
            if (!variable) {
                return;
            }
            count[variable] = (count[variable] ?? 0) + 1;
        });

        nodeDef.args?.forEach((arg) => {
            if (!isExprType(getNodeArgRawType(arg))) {
                return;
            }
            const rawValue = node.args?.[arg.name];
            const entries = Array.isArray(rawValue) ? rawValue : [rawValue];
            entries.forEach((entry) => {
                if (typeof entry !== "string" || !entry) {
                    return;
                }
                parseExpr(entry).forEach((variable) => {
                    count[variable] = (count[variable] ?? 0) + 1;
                });
            });
        });
    });

    return count;
};

export const createVariableOptions = (
    usingVars: Record<string, VarDecl> | null,
    root: VariableUsageNode | null,
    nodeDefMap: Map<string, NodeDef>
): VariableOption[] => {
    const options: VariableOption[] = [];
    const seen = new Set<string>();

    if (usingVars) {
        Object.values(usingVars).forEach((variable) => {
            if (seen.has(variable.name)) {
                return;
            }
            seen.add(variable.name);
            options.push({
                label: `${variable.name} (${variable.desc})`,
                value: variable.name,
            });
        });
        return options;
    }

    if (!root) {
        return options;
    }

    dfs(root, (node) => {
        const nodeDef = nodeDefMap.get(node.name);

        node.input?.forEach((variable, index) => {
            if (!variable || seen.has(variable)) {
                return;
            }
            const rawLabel =
                nodeDef?.input?.length &&
                index >= nodeDef.input.length &&
                isVariadic(nodeDef.input, -1)
                    ? nodeDef.input[nodeDef.input.length - 1]
                    : (nodeDef?.input?.[index] ?? "input");
            seen.add(variable);
            options.push({
                label: `${variable} (${cleanSlotLabel(rawLabel)})`,
                value: variable,
            });
        });

        node.output?.forEach((variable, index) => {
            if (!variable || seen.has(variable)) {
                return;
            }
            const rawLabel =
                nodeDef?.output?.length &&
                index >= nodeDef.output.length &&
                isVariadic(nodeDef.output, -1)
                    ? nodeDef.output[nodeDef.output.length - 1]
                    : (nodeDef?.output?.[index] ?? "output");
            seen.add(variable);
            options.push({
                label: `${variable} (${cleanSlotLabel(rawLabel)})`,
                value: variable,
            });
        });
    });

    return options;
};

export const formatChildrenLabel = (nodeDef: NodeDef | null) => {
    if (!nodeDef) {
        return "-";
    }
    if (nodeDef.children === undefined || nodeDef.children === -1) {
        return i18n.t("node.children.unlimited");
    }
    return String(nodeDef.children);
};

export const formatArgInitialValue = (arg: NodeArg, value: unknown) => {
    const type = getNodeArgRawType(arg);

    if (isNodeArgArray(arg)) {
        if (hasArgOptions(arg)) {
            return Array.isArray(value) ? value : [];
        }
        return value === undefined ? "" : JSON.stringify(value, null, 2);
    }

    if (hasArgOptions(arg)) {
        return value ?? (isNodeArgOptional(arg) ? "__unset__" : undefined);
    }

    if (isBoolType(type)) {
        if (value === undefined && isNodeArgOptional(arg)) {
            return "__unset__";
        }
        return value ?? false;
    }

    if (isJsonType(type)) {
        return value === undefined ? "" : JSON.stringify(value, null, 2);
    }

    return value ?? "";
};

export const parseArgSubmitValue = (arg: NodeArg, raw: unknown): unknown => {
    const type = getNodeArgRawType(arg);

    if (isNodeArgArray(arg)) {
        if (hasArgOptions(arg)) {
            const values = Array.isArray(raw) ? raw : [];
            return values.length === 0 && isNodeArgOptional(arg) ? undefined : values;
        }

        const text = String(raw ?? "").trim();
        if (!text) {
            return isNodeArgOptional(arg) ? undefined : [];
        }
        const parsed = JSON.parse(text);
        if (!Array.isArray(parsed)) {
            throw new Error(i18n.t("validation.jsonArray", { name: arg.name }));
        }
        return parsed;
    }

    if (hasArgOptions(arg)) {
        return raw === "__unset__" ? undefined : raw;
    }

    if (isBoolType(type)) {
        if (raw === "__unset__") {
            return undefined;
        }
        return Boolean(raw);
    }

    if (isIntType(type) || isFloatType(type)) {
        if (raw === "" || raw === undefined || raw === null) {
            return isNodeArgOptional(arg) ? undefined : raw;
        }
        return Number(raw);
    }

    if (isJsonType(type)) {
        const text = String(raw ?? "").trim();
        if (!text) {
            return isNodeArgOptional(arg) ? undefined : {};
        }
        return JSON.parse(text);
    }

    const text = String(raw ?? "");
    if (!text.trim() && isNodeArgOptional(arg)) {
        return undefined;
    }
    return text;
};

export const compareJsonValue = (left: unknown, right: unknown) =>
    JSON.stringify(left) === JSON.stringify(right);

export const validateVariableValue = (
    value: string | undefined,
    usingVars: Record<string, VarDecl> | null
): string | null => {
    if (!value) {
        return null;
    }
    if (!isValidVariableName(value)) {
        return i18n.t("node.invalidVariableName");
    }
    if (usingVars && !usingVars[value]) {
        return i18n.t("node.undefinedVariable", { variable: value });
    }
    return null;
};

export const validateExpressionValues = (
    entries: string[],
    usingVars: Record<string, VarDecl> | null,
    checkExpr: boolean
): string | null => {
    for (const entry of entries) {
        if (!entry) {
            continue;
        }

        const variables = parseExpr(entry);
        for (const variable of variables) {
            if (usingVars && !usingVars[variable]) {
                return i18n.t("node.undefinedVariable", { variable });
            }
        }

        if (checkExpr) {
            try {
                if (!new ExpressionEvaluator(entry).dryRun()) {
                    return i18n.t("node.invalidExpression");
                }
            } catch {
                return i18n.t("node.invalidExpression");
            }
        }
    }

    return null;
};

export const filterOptionByLabel = (input: string, option?: { label?: React.ReactNode }) =>
    String(option?.label ?? "")
        .toUpperCase()
        .includes(input.toUpperCase());

const getOverridePopupContainer = (trigger: HTMLElement) => {
    return (trigger.closest(".b3-v2-inspector") as HTMLElement) ?? document.body;
};

export const OverrideBar: React.FC<{
    active: boolean;
    onReset: () => void;
    children: React.ReactNode;
}> = ({ active, onReset, children }) => {
    const { t } = useTranslation();

    if (!active) {
        return <>{children}</>;
    }

    return (
        <div className="b3-v2-override-bar">
            <Popconfirm
                title={t("override.resetTitle")}
                okText={t("reset")}
                cancelText={t("cancel")}
                placement="left"
                onConfirm={onReset}
                getPopupContainer={getOverridePopupContainer}
            >
                <div className="b3-v2-override-rail" />
            </Popconfirm>
            {children}
        </div>
    );
};

export const SectionDivider: React.FC<React.PropsWithChildren> = ({ children }) => {
    return (
        <Divider className="b3-v2-section-divider" titlePlacement="start" orientation="horizontal">
            <h4 className="b3-v2-section-title">{children}</h4>
        </Divider>
    );
};

export const InspectorLabel: React.FC<{ text: string; required?: boolean }> = ({
    text,
    required,
}) => {
    return (
        <span className="b3-v2-form-label">
            <span className="b3-v2-form-label-text">
                {required ? <span className="b3-v2-form-required-mark">*</span> : null}
                {text}
            </span>
            <span className="b3-v2-form-label-colon">:</span>
        </span>
    );
};

export const createInspectorLabelProps = (text: string, required = false) => ({
    label: <InspectorLabel text={text} required={required} />,
    colon: false as const,
});

export const VariableDeclRow: React.FC<{
    value?: VariableRowValue;
    disabled?: boolean;
    onChange?: (next: VariableRowValue) => void;
    onRemove?: () => void;
    onSubmit?: () => void;
    onFocusVariable?: (name: string) => void;
}> = ({ value, disabled = false, onChange, onRemove, onSubmit, onFocusVariable }) => {
    const { t } = useTranslation();
    const [localValue, setLocalValue] = useState<VariableRowValue>(value ?? { name: "", desc: "" });

    useEffect(() => {
        setLocalValue(value ?? { name: "", desc: "" });
    }, [value]);

    const commit = () => {
        onChange?.(localValue);
        onSubmit?.();
    };

    return (
        <Flex gap={4} align="start" className="b3-v2-var-row">
            <Space.Compact block className="b3-v2-var-row-compact">
                <div
                    className="b3-v2-var-counter"
                    onClick={() => {
                        if (localValue.name) {
                            onFocusVariable?.(localValue.name);
                        }
                    }}
                >
                    <AimOutlined />
                    <span>{localValue.count ?? 0}</span>
                </div>
                <Input
                    disabled={disabled}
                    value={localValue.name}
                    placeholder={t("tree.vars.name")}
                    onChange={(event) =>
                        setLocalValue((current) => ({
                            ...current,
                            name: event.target.value,
                        }))
                    }
                    onBlur={commit}
                />
                <Input
                    disabled={disabled}
                    value={localValue.desc}
                    placeholder={t("tree.vars.desc")}
                    onChange={(event) =>
                        setLocalValue((current) => ({
                            ...current,
                            desc: event.target.value,
                        }))
                    }
                    onBlur={commit}
                />
            </Space.Compact>
            {disabled ? (
                <div className="b3-v2-row-spacer" />
            ) : (
                <MinusCircleOutlined className="b3-v2-inline-remove" onClick={onRemove} />
            )}
        </Flex>
    );
};
