import { ExpressionEvaluator } from "behavior3";
import { isExprType, keyWords, type NodeDef, type VarDecl } from "../shared/misc/b3type";
import type { ResolvedNodeModel } from "../shared/contracts";

export type TreeValidationDiagnostic =
    | { code: "missing-node-def"; nodeName: string }
    | { code: "group-not-enabled"; nodeName: string; groups: string[] }
    | { code: "invalid-variable-name"; field: "input" | "output"; variable: string }
    | { code: "undefined-variable"; field: "input" | "output" | "args"; variable: string }
    | { code: "invalid-expression"; field: "args"; expression: string }
    | { code: "required-input"; index: number; label: string }
    | { code: "required-output"; index: number; label: string }
    | { code: "custom-arg-check"; argName: string; checker: string; message: string }
    | { code: "invalid-children"; expected: number; actual: number };

export const hasDeclaredVars = (
    vars: Record<string, VarDecl> | null | undefined
): vars is Record<string, VarDecl> => {
    return Boolean(vars && Object.keys(vars).length > 0);
};

export const isValidVariableName = (name: string): boolean => {
    return /^[a-zA-Z_$][a-zA-Z_$0-9]*$/.test(name) && !keyWords.includes(name);
};

export const parseExpressionVariables = (expr: string): string[] => {
    return expr
        .split(/[^a-zA-Z0-9_.'"]/)
        .map((value) => value.split(".")[0])
        .filter((value) => isValidVariableName(value));
};

export const validateVariableReference = (
    value: string | undefined,
    usingVars: Record<string, VarDecl> | null,
    field: "input" | "output"
): TreeValidationDiagnostic | null => {
    if (!value) {
        return null;
    }
    if (!isValidVariableName(value)) {
        return { code: "invalid-variable-name", field, variable: value };
    }
    const declaredVars = hasDeclaredVars(usingVars) ? usingVars : null;
    if (declaredVars && !declaredVars[value]) {
        return { code: "undefined-variable", field, variable: value };
    }
    return null;
};

export const validateExpressionEntries = (
    entries: string[],
    usingVars: Record<string, VarDecl> | null,
    checkExpr: boolean
): TreeValidationDiagnostic | null => {
    const declaredVars = hasDeclaredVars(usingVars) ? usingVars : null;

    for (const entry of entries) {
        if (!entry) {
            continue;
        }

        for (const variable of parseExpressionVariables(entry)) {
            if (declaredVars && !declaredVars[variable]) {
                return { code: "undefined-variable", field: "args", variable };
            }
        }

        if (checkExpr) {
            try {
                if (!new ExpressionEvaluator(entry).dryRun()) {
                    return { code: "invalid-expression", field: "args", expression: entry };
                }
            } catch {
                return { code: "invalid-expression", field: "args", expression: entry };
            }
        }
    }

    return null;
};

const isVariadicSlot = (slots: string[], index: number): boolean => {
    const current = index < 0 ? slots[slots.length - 1] : slots[index];
    return Boolean(current?.endsWith("..."));
};

const isRequiredSlotMissing = (
    slots: string[] | undefined,
    values: string[] | undefined,
    index: number
): boolean => {
    const label = slots?.[index] ?? "";
    return !isVariadicSlot(slots ?? [], index) && !label.includes("?") && !(values?.[index] ?? "");
};

export const collectResolvedNodeDiagnostics = (params: {
    node: ResolvedNodeModel;
    def: NodeDef | null | undefined;
    usingVars: Record<string, VarDecl> | null;
    usingGroups: Record<string, boolean> | null;
    checkExpr: boolean;
}): TreeValidationDiagnostic[] => {
    const { node, def, usingVars, usingGroups, checkExpr } = params;
    const diagnostics: TreeValidationDiagnostic[] = [];

    if (node.resolutionError) {
        return diagnostics;
    }

    if (!def) {
        diagnostics.push({ code: "missing-node-def", nodeName: node.name });
        return diagnostics;
    }

    if (def.group) {
        const groups = Array.isArray(def.group) ? def.group : [def.group];
        if (!groups.some((group) => usingGroups?.[group])) {
            diagnostics.push({ code: "group-not-enabled", nodeName: node.name, groups });
        }
    }

    for (const value of node.input ?? []) {
        const diagnostic = validateVariableReference(value, usingVars, "input");
        if (diagnostic) {
            diagnostics.push(diagnostic);
        }
    }

    for (const value of node.output ?? []) {
        const diagnostic = validateVariableReference(value, usingVars, "output");
        if (diagnostic) {
            diagnostics.push(diagnostic);
        }
    }

    for (const arg of def.args ?? []) {
        const rawValue = node.args?.[arg.name];
        if (!isExprType(arg.type) || !rawValue) {
            continue;
        }
        const exprValues = (Array.isArray(rawValue) ? rawValue : [rawValue]).filter(
            (entry): entry is string => typeof entry === "string"
        );
        const diagnostic = validateExpressionEntries(exprValues, usingVars, checkExpr);
        if (diagnostic) {
            diagnostics.push(diagnostic);
        }
    }

    for (let index = 0; index < (def.input?.length ?? 0); index += 1) {
        if (isVariadicSlot(def.input ?? [], index)) {
            break;
        }
        if (isRequiredSlotMissing(def.input, node.input, index)) {
            diagnostics.push({
                code: "required-input",
                index,
                label: def.input?.[index] ?? "",
            });
        }
    }

    for (let index = 0; index < (def.output?.length ?? 0); index += 1) {
        if (isVariadicSlot(def.output ?? [], index)) {
            break;
        }
        if (isRequiredSlotMissing(def.output, node.output, index)) {
            diagnostics.push({
                code: "required-output",
                index,
                label: def.output?.[index] ?? "",
            });
        }
    }

    return diagnostics;
};
