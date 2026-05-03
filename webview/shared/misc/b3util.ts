import "./array";
import { hasFs } from "./b3fs";
import {
    FileVarDecl,
    hasArgOptions,
    ImportDecl,
    isBoolType,
    isExprType,
    isFloatType,
    isIntType,
    isJsonType,
    isStringType,
    keyWords,
    NodeArg,
    NodeData,
    NodeDef,
    TreeData,
    VarDecl,
    VERSION,
} from "./b3type";
import { ExpressionEvaluator } from "behavior3";
import { logger } from "./logger";
import { nanoid, readJson, readTreeFromFile } from "./util";
import { buildProjectWithContext } from "./b3-build";
import { normalizeNodeDefCollection } from "../schema";

/**
 * Shared editor/runtime utilities plus the remaining mutable singleton state
 * that legacy build-time validation still depends on.
 */
export class NodeDefs extends Map<string, NodeDef> {
    override get(key: string): NodeDef {
        return super.get(key) ?? unknownNodeDef;
    }
}

export let calcSize: (d: NodeData) => number[] = () => [0, 0];
export let nodeDefs: NodeDefs = new NodeDefs();
export let groupDefs: string[] = [];
export let usingGroups: Record<string, boolean> | null = null;
export let usingVars: Record<string, VarDecl> | null = null;
export const files: Record<string, number> = {};

const parsedVarDecl: Record<string, ImportDecl> = {};
const parsedExprs: Record<string, string[]> = {};
let checkExpr: boolean = false;
let workdir: string = "";
let alertError: (msg: string, duration?: number) => void = () => {};

const unknownNodeDef: NodeDef = {
    name: "unknown",
    desc: "",
    type: "Action",
};

export const initWorkdir = (path: string, handler: typeof alertError) => {
    const posix = path.replace(/\\/g, "/");
    initWorkdirFromSettingFile(posix, `${posix}/node-config.b3-setting`, handler);
};

/** Load node defs from an explicit `.b3-setting` path (VS Code auto-discovered `*.b3-setting`). */
export const initWorkdirFromSettingFile = (
    workdirPath: string,
    settingFilePath: string,
    handler: typeof alertError
) => {
    workdir = workdirPath.replace(/\\/g, "/");
    alertError = handler;
    const nodeDefData = normalizeNodeDefCollection(readJson(settingFilePath) as unknown);
    const groups: Set<string> = new Set();
    nodeDefs = new NodeDefs();
    for (const node of nodeDefData) {
        node.args?.forEach((arg) => {
            if (arg.options && !arg.options[0].source) {
                arg.options = [
                    {
                        source: arg.options as unknown as Array<{ name: string; value: unknown }>,
                    },
                ];
            }
            arg.options?.forEach((option) => {
                Object.keys(option.match ?? {}).forEach((key) => {
                    if (!node.args?.find((v) => v.name === key)) {
                        logger.error(
                            `match key '${key}' in arg '${arg.name}' of ` +
                                `node '${node.name}' is not found in args`
                        );
                    }
                });
            });
        });
        nodeDefs.set(node.name, node);
        node.group?.forEach((g) => groups.add(g));
    }
    groupDefs = Array.from(groups).sort();
};

/** Webview: receive pre-loaded defs from extension host (no disk). */
export const initWithNodeDefs = (defs: NodeDef[], handler: typeof alertError, check: boolean) => {
    alertError = handler;
    checkExpr = check;
    const groups: Set<string> = new Set();
    nodeDefs = new NodeDefs();
    for (const node of normalizeNodeDefCollection(defs as unknown)) {
        node.args?.forEach((arg) => {
            if (
                arg.options &&
                !Array.isArray((arg.options as Array<{ source: unknown }>)[0]?.source)
            ) {
                arg.options = [
                    {
                        source: arg.options as unknown as Array<{ name: string; value: unknown }>,
                    },
                ];
            }
        });
        nodeDefs.set(node.name, node);
        node.group?.forEach((g) => groups.add(g));
    }
    groupDefs = Array.from(groups).sort();
};

export const setSizeCalculator = (calc: (d: NodeData) => number[]) => {
    calcSize = calc;
};

export const updateUsingGroups = (group: string[]) => {
    usingGroups = null;
    for (const g of group) {
        usingGroups ??= {};
        usingGroups[g] = true;
    }
};

export const updateUsingVars = (vars: VarDecl[]) => {
    usingVars = null;
    for (const v of vars) {
        usingVars ??= {};
        usingVars[v.name] = v;
    }
};

export const setCheckExpr = (check: boolean) => {
    checkExpr = check;
};

export const parseExpr = (expr: string) => {
    if (parsedExprs[expr]) {
        return parsedExprs[expr];
    }
    const result = expr
        .split(/[^a-zA-Z0-9_.'"]/)
        .map((v) => v.split(".")[0])
        .filter((v) => isValidVariableName(v));
    parsedExprs[expr] = result;
    return result;
};

export const dfs = <T extends { children?: T[] }>(
    node: T,
    visitor: (node: T, depth: number) => unknown,
    depth: number = 0
) => {
    const traverse = (n: T, d: number) => {
        if (visitor(n, d) === false) {
            return false;
        }
        if (n.children) {
            for (const child of n.children) {
                if (traverse(child, d + 1) === false) {
                    return false;
                }
            }
        }
    };
    traverse(node, depth);
};

export const isNewVersion = (version: string) => {
    const [major, minor, patch] = version.split(".").map(Number);
    const [major2, minor2, patch2] = VERSION.split(".").map(Number);
    return (
        major > major2 ||
        (major === major2 && minor > minor2) ||
        (major === major2 && minor === minor2 && patch > patch2)
    );
};

export const isValidVariableName = (name: string) => {
    return /^[a-zA-Z_$][a-zA-Z_$0-9]*$/.test(name) && !keyWords.includes(name);
};

export const isSubtreeRoot = (data: NodeData) => {
    return Boolean(data.path) && data.id !== "1";
};

export const isNodeEqual = (node1: NodeData, node2: NodeData) => {
    if (
        node1.name === node2.name &&
        node1.desc === node2.desc &&
        node1.path === node2.path &&
        node1.debug === node2.debug &&
        node1.disabled === node2.disabled
    ) {
        const def = nodeDefs.get(node1.name);

        for (const arg of def.args ?? []) {
            if (node1.args?.[arg.name] !== node2.args?.[arg.name]) {
                return false;
            }
        }

        if (def.input?.length) {
            const len = Math.max(node1.input?.length ?? 0, node2.input?.length ?? 0);
            for (let i = 0; i < len; i++) {
                if (node1.input?.[i] !== node2.input?.[i]) {
                    return false;
                }
            }
        }

        if (def.output?.length) {
            const len = Math.max(node1.output?.length ?? 0, node2.output?.length ?? 0);
            for (let i = 0; i < len; i++) {
                if (node1.output?.[i] !== node2.output?.[i]) {
                    return false;
                }
            }
        }

        return true;
    }
    return false;
};

type ErrorPrinter = (msg: string) => void;

const formatError = (data: NodeData, msg: string) => {
    return `check ${data.id}|${data.name}: ${msg}`;
};

export const getNodeArgRawType = (arg: NodeArg) => {
    return arg.type.match(/^\w+/)![0] as NodeArg["type"];
};

export const isNodeArgArray = (arg: NodeArg) => {
    return arg.type.includes("[]");
};

export const isNodeArgOptional = (arg: NodeArg) => {
    return arg.type.includes("?");
};

/** Normalized shape after init (see initWorkdir / initWithNodeDefs). */
type ArgOptionBucket = {
    match?: Record<string, string[]>;
    source: Array<{ name: string; value: unknown }>;
};

function argOptionBuckets(arg: NodeArg): ArgOptionBucket[] | undefined {
    const o = arg.options;
    if (!Array.isArray(o)) {
        return undefined;
    }
    return o as ArgOptionBucket[];
}

export const getNodeArgOptions = (arg: NodeArg, args: Record<string, unknown>) => {
    const opts = argOptionBuckets(arg);
    if (!opts?.length) {
        return;
    }
    const defaultMatch = opts.find((option) => !option.match);
    if (defaultMatch) {
        return defaultMatch.source;
    }
    return opts.find((entry) =>
        Object.entries(entry.match!).every(([key, value]) => {
            const arr = value as unknown[];
            const a = args[key];
            return Array.isArray(arr) && arr.includes(a);
        })
    )?.source;
};

export const checkNodeArgValue = (
    data: NodeData,
    arg: NodeArg,
    value: unknown,
    printer?: ErrorPrinter
) => {
    let hasError = false;
    const type = getNodeArgRawType(arg);
    const error = !printer ? () => {} : (msg: string) => printer(formatError(data, msg));
    if (isFloatType(type)) {
        const isNumber = typeof value === "number";
        const isOptional = value === undefined && isNodeArgOptional(arg);
        if (!(isNumber || isOptional)) {
            error(`'${arg.name}=${JSON.stringify(value)}' is not a number`);
            hasError = true;
        }
    } else if (isIntType(type)) {
        const isInt = typeof value === "number" && value === Math.floor(value);
        const isOptional = value === undefined && isNodeArgOptional(arg);
        if (!(isInt || isOptional)) {
            error(`'${arg.name}=${JSON.stringify(value)}' is not a int`);
            hasError = true;
        }
    } else if (isStringType(type)) {
        const isString = typeof value === "string" && value;
        const isOptional = (value === undefined || value === "") && isNodeArgOptional(arg);
        if (!(isString || isOptional)) {
            error(`'${arg.name}=${JSON.stringify(value)}' is not a string`);
            hasError = true;
        }
    } else if (isExprType(type)) {
        const isExpr = typeof value === "string" && value;
        const isOptional = (value === undefined || value === "") && isNodeArgOptional(arg);
        if (!(isExpr || isOptional)) {
            error(`'${arg.name}=${JSON.stringify(value)}' is not an expr string`);
            hasError = true;
        }
    } else if (isJsonType(type)) {
        const isJson = value !== undefined && value !== "";
        const isOptional = isNodeArgOptional(arg);
        if (!(isJson || isOptional)) {
            error(`'${arg.name}=${value}' is not an invalid object`);
            hasError = true;
        }
    } else if (isBoolType(type)) {
        const isBool = typeof value === "boolean";
        const isOptional = value === undefined && isNodeArgOptional(arg);
        if (!(isBool || isOptional)) {
            error(`'${arg.name}=${JSON.stringify(value)}' is not a boolean`);
            hasError = true;
        }
    } else {
        hasError = true;
        error(`unknown arg type '${arg.type}'`);
    }

    if (hasArgOptions(arg)) {
        const options = getNodeArgOptions(arg, data.args ?? {});
        const found = !!options?.find(
            (option: { name: string; value: unknown }) => option.value === value
        );
        const isOptional = value === undefined && isNodeArgOptional(arg);
        if (!(found || isOptional)) {
            error(`'${arg.name}=${JSON.stringify(value)}' is not a one of the option values`);
            hasError = true;
        }
    }

    return !hasError;
};

export const checkNodeArg = (data: NodeData, conf: NodeDef, i: number, printer?: ErrorPrinter) => {
    let hasError = false;
    const arg = conf.args![i] as NodeArg;
    const value = data.args?.[arg.name];
    const error = !printer ? () => {} : (msg: string) => printer(formatError(data, msg));
    if (isNodeArgArray(arg)) {
        if (!Array.isArray(value) || value.length === 0) {
            if (!isNodeArgOptional(arg)) {
                error(`'${arg.name}=${JSON.stringify(value)}' is not an array or empty array`);
                hasError = true;
            }
        } else {
            for (let j = 0; j < value.length; j++) {
                if (!checkNodeArgValue(data, arg, value[j], printer)) {
                    hasError = true;
                }
            }
        }
    } else if (!checkNodeArgValue(data, arg, value, printer)) {
        hasError = true;
    }
    if (arg.oneof !== undefined) {
        const idx = conf.input?.findIndex((v) => v.startsWith(arg.oneof!)) ?? -1;
        if (!checkOneof(arg, data.args?.[arg.name], data.input?.[idx])) {
            error(
                `only one is allowed for between argument '${arg.name}' and input '${data.input?.[idx]}'`
            );

            hasError = true;
        }
    }

    return !hasError;
};

export const checkOneof = (arg: NodeArg, argValue: unknown, inputValue: unknown) => {
    if (isNodeArgArray(arg)) {
        if (argValue instanceof Array && argValue.length === 0) {
            argValue = undefined;
        }
    }
    argValue = argValue === undefined ? "" : argValue;
    inputValue = inputValue ?? "";
    return (argValue !== "" && inputValue === "") || (argValue === "" && inputValue !== "");
};

export const isValidNodeData = (data: NodeData) => {
    const def = nodeDefs.get(data.name);
    if (def.input) {
        for (let i = 0; i < def.input.length; i++) {
            if (!isValidInputOrOutput(def.input, data.input, i)) {
                return false;
            }
        }
    }
    if (def.output) {
        for (let i = 0; i < def.output.length; i++) {
            if (!isValidInputOrOutput(def.output, data.output, i)) {
                return false;
            }
        }
    }
    if (!isValidChildren(data)) {
        return false;
    }
    if (def.args) {
        for (let i = 0; i < def.args.length; i++) {
            if (!checkNodeArg(data, def, i)) {
                return false;
            }
        }
    }

    return true;
};

export const checkNodeData = (data: NodeData | null | undefined, printer: ErrorPrinter) => {
    if (!data) {
        return false;
    }
    const error = !printer ? () => {} : (msg: string) => printer(formatError(data, msg));
    const conf = nodeDefs.get(data.name);
    if (conf.name === unknownNodeDef.name) {
        error(`undefined node: ${data.name}`);
        return false;
    }

    let hasError = false;

    if (conf.group) {
        const groups = Array.isArray(conf.group) ? conf.group : [conf.group];
        if (!groups.some((g) => usingGroups?.[g])) {
            error(`node group '${conf.group}' is not enabled`);
            hasError = true;
        }
    }

    if (usingVars) {
        if (data.input) {
            for (const v of data.input) {
                if (v && !usingVars[v]) {
                    error(`input variable '${v}' is not defined`);
                    hasError = true;
                }
            }
        }
        if (data.output) {
            for (const v of data.output) {
                if (v && !usingVars[v]) {
                    error(`output variable '${v}' is not defined`);
                    hasError = true;
                }
            }
        }
    }

    if (data.args && conf.args) {
        for (const arg of conf.args) {
            const value = data.args?.[arg.name] as string | string[] | undefined;
            if (isExprType(arg.type) && value) {
                if (usingVars) {
                    const vars: string[] = [];
                    if (typeof value === "string") {
                        vars.push(...parseExpr(value));
                    } else if (Array.isArray(value)) {
                        for (const v of value) {
                            vars.push(...parseExpr(v));
                        }
                    }
                    for (const v of vars) {
                        if (v && !usingVars[v]) {
                            error(`expr variable '${arg.name}' is not defined`);
                            hasError = true;
                        }
                    }
                }
                if (checkExpr) {
                    const exprs: string[] = [];
                    if (typeof value === "string") {
                        exprs.push(value);
                    } else if (Array.isArray(value)) {
                        for (const v of value) {
                            exprs.push(v);
                        }
                    }
                    for (const expr of exprs) {
                        try {
                            if (!new ExpressionEvaluator(expr).dryRun()) {
                                error(`expr '${expr}' is not valid`);
                                hasError = true;
                            }
                        } catch (e) {
                            error(`expr '${expr}' is not valid`);
                            hasError = true;
                        }
                    }
                }
            }
        }
    }

    if (!isValidChildren(data)) {
        hasError = true;
        const count = data.children?.filter((c) => !c.disabled).length || 0;
        error(`expect ${conf.children} children, but got ${count}`);
    }

    let hasVaridicInput = false;
    if (conf.input) {
        for (let i = 0; i < conf.input.length; i++) {
            if (!data.input) {
                data.input = [];
            }
            if (!data.input[i]) {
                data.input[i] = "";
            }
            if (data.input[i] && !isValidVariableName(data.input[i])) {
                error(
                    `input field '${data.input[i]}' is not a valid variable name,` +
                        `should start with a letter or underscore`
                );
                hasError = true;
            }
            if (!isValidInputOrOutput(conf.input, data.input, i)) {
                error(`intput field '${conf.input[i]}' is required`);
                hasError = true;
            }
            const lastInput = conf.input[conf.input.length - 1];
            if (i === conf.input.length - 1 && lastInput?.endsWith("...")) {
                hasVaridicInput = true;
            }
        }
    }
    if (data.input && !hasVaridicInput) {
        data.input.length = conf.input?.length || 0;
    }

    let hasVaridicOutput = false;
    if (conf.output) {
        for (let i = 0; i < conf.output.length; i++) {
            if (!data.output) {
                data.output = [];
            }
            if (!data.output[i]) {
                data.output[i] = "";
            }
            if (data.output[i] && !isValidVariableName(data.output[i])) {
                error(
                    `output field '${data.output[i]}' is not a valid variable name,` +
                        `should start with a letter or underscore`
                );
                hasError = true;
            }
            if (!isValidInputOrOutput(conf.output, data.output, i)) {
                error(`output field '${conf.output[i]}' is required`);
                hasError = true;
            }
            const lastOutput = conf.output[conf.output.length - 1];
            if (i === conf.output.length - 1 && lastOutput?.endsWith("...")) {
                hasVaridicOutput = true;
            }
        }
    }
    if (data.output && !hasVaridicOutput) {
        data.output.length = conf.output?.length || 0;
    }
    if (conf.args) {
        const args: { [k: string]: unknown } = {};
        data.args ||= {};
        for (let i = 0; i < conf.args.length; i++) {
            const key = conf.args[i].name;
            if (data.args[key] === undefined && conf.args[i].default !== undefined) {
                data.args[key] = conf.args[i].default;
            }

            const value = data.args[key];
            if (value !== undefined) {
                args[key] = value;
            }

            if (!checkNodeArg(data, conf, i, printer)) {
                hasError = true;
            }
        }
        data.args = args;
    }

    if (data.children) {
        for (const child of data.children) {
            if (!checkNodeData(child, printer)) {
                hasError = true;
            }
        }
    } else {
        data.children = [];
    }

    return !hasError;
};

/** Align with extension `tree-editor-provider.normalizePathKey` for subtree path lookup. */
export const normalizeSubtreePathKey = (p: string) =>
    p
        .replace(/\\/g, "/")
        .replace(/^[/\\]+/, "")
        .replace(/^\.\//, "");

interface RefreshVarDeclContext {
    hasFs: boolean;
    files: Record<string, number>;
    workdir: string;
    usingGroups: Record<string, boolean> | null;
    usingVars: Record<string, VarDecl> | null;
    parsedVarDecl: Record<string, ImportDecl>;
    parsingStack: string[];
    dfs<T extends { children?: T[] }>(
        node: T,
        visitor: (node: T, depth: number) => unknown,
        depth?: number
    ): void;
    normalizeSubtreePathKey(path: string): string;
    updateUsingGroups(group: string[]): void;
    updateUsingVars(vars: VarDecl[]): void;
    readTreeFromFile(path: string): TreeData;
    alertError(message: string, duration?: number): void;
    logger: {
        warn(...args: unknown[]): void;
        debug(...args: unknown[]): void;
    };
}

const collectSubtreePaths = (data: NodeData, walk: RefreshVarDeclContext["dfs"]): string[] => {
    const list: string[] = [];
    walk(data, (node) => {
        if (node.path) {
            list.push(node.path);
        }
    });
    return list;
};

/**
 * Variable declaration refresh stays local to this module because it still
 * depends on the singleton caches above. Keeping it here avoids a thin
 * wrapper-only file around mutable shared state.
 */
const loadVarDecl = (
    list: ImportDecl[],
    arr: Array<VarDecl>,
    context: RefreshVarDeclContext
) => {
    for (const entry of list) {
        if (!context.files[entry.path]) {
            context.logger.warn(`file not found: ${context.workdir}/${entry.path}`);
            continue;
        }

        let changed = false;
        if (!entry.modified || context.files[entry.path] > entry.modified) {
            changed = true;
        }

        if (!changed) {
            changed = entry.depends.some(
                (dependency) =>
                    context.files[dependency.path] &&
                    context.files[dependency.path] > dependency.modified
            );
        }

        if (!changed) {
            continue;
        }

        entry.vars = [];
        entry.depends = [];
        entry.modified = context.files[entry.path];

        const vars: Set<VarDecl> = new Set();
        const depends: Set<string> = new Set();
        const load = (relativePath: string) => {
            if (context.parsingStack.includes(relativePath)) {
                return;
            }

            const parsedEntry: ImportDecl | undefined = context.parsedVarDecl[relativePath];
            if (parsedEntry && context.files[relativePath] === parsedEntry.modified) {
                parsedEntry.depends.forEach((dependency) => depends.add(dependency.path));
                parsedEntry.vars.forEach((variable) => vars.add(variable));
                return;
            }

            context.parsingStack.push(relativePath);
            try {
                const model: TreeData = context.readTreeFromFile(
                    `${context.workdir}/${relativePath}`
                );
                model.vars.forEach((variable) => vars.add(variable));
                model.import.forEach((importPath) => {
                    load(importPath);
                    depends.add(importPath);
                });
                collectSubtreePaths(model.root, context.dfs).forEach((subtreePath) => {
                    load(subtreePath);
                    depends.add(subtreePath);
                });
                context.logger.debug(`load var: ${relativePath}`);
            } catch {
                context.alertError(`parsing error: ${relativePath}`);
            }
            context.parsingStack.pop();
        };

        load(entry.path);
        entry.vars = Array.from(vars).sort((a, b) => a.name.localeCompare(b.name));
        entry.depends = Array.from(depends).map((dependencyPath) => ({
            path: dependencyPath,
            modified: context.files[dependencyPath],
        }));
        context.parsedVarDecl[entry.path] = {
            path: entry.path,
            vars: entry.vars.map((variable) => ({ name: variable.name, desc: variable.desc })),
            depends: entry.depends.slice(),
            modified: entry.modified,
        };
    }

    list.forEach((entry) => arr.push(...entry.vars));
};

const refreshVarDeclWebview = (
    root: NodeData,
    group: string[],
    declare: FileVarDecl,
    context: RefreshVarDeclContext
) => {
    const prevSubtreeByPath = new Map(
        declare.subtree.map((entry) => [context.normalizeSubtreePathKey(entry.path), entry])
    );
    declare.subtree = collectSubtreePaths(root, context.dfs).map((subtreePath) => {
        const previous = prevSubtreeByPath.get(context.normalizeSubtreePathKey(subtreePath));
        return {
            path: subtreePath,
            vars: previous?.vars?.length ? previous.vars.map((variable) => ({ ...variable })) : [],
            depends: previous?.depends ?? [],
        };
    });

    const lastGroup = Array.from(Object.keys(context.usingGroups ?? {})).sort();
    const sortedGroup = [...group].sort();
    if (
        lastGroup.length !== sortedGroup.length ||
        lastGroup.some((value, index) => value !== sortedGroup[index])
    ) {
        context.updateUsingGroups(group);
        return true;
    }

    return false;
};

const refreshVarDeclNode = (
    root: NodeData,
    group: string[],
    declare: FileVarDecl,
    context: RefreshVarDeclContext
) => {
    const filter: Record<string, boolean> = {};
    const vars: Array<VarDecl> = new (class extends Array<VarDecl> {
        override push(...items: VarDecl[]): number {
            for (const item of items) {
                if (filter[item.name]) {
                    continue;
                }
                filter[item.name] = true;
                super.push(item);
            }
            return this.length;
        }
    })();

    vars.push(...declare.vars);
    context.parsingStack.length = 0;
    declare.subtree = collectSubtreePaths(root, context.dfs).map((subtreePath) => ({
        path: subtreePath,
        vars: [],
        depends: [],
    }));
    loadVarDecl(declare.import, vars, context);
    loadVarDecl(declare.subtree, vars, context);

    let changed = false;
    const lastGroup = Array.from(Object.keys(context.usingGroups ?? {})).sort();
    group.sort();
    if (lastGroup.length !== group.length || lastGroup.some((value, index) => value !== group[index])) {
        changed = true;
        context.logger.debug("refresh group:", lastGroup, group);
        context.updateUsingGroups(group);
    }

    const lastVars = Array.from(Object.keys(context.usingVars ?? {})).sort();
    vars.sort((a, b) => a.name.localeCompare(b.name));
    if (lastVars.length !== vars.length || lastVars.some((value, index) => value !== vars[index].name)) {
        changed = true;
        context.logger.debug("refresh vars:", lastVars, vars);
        context.updateUsingVars(vars);
    }

    return changed;
};

const refreshVarDecl = (root: NodeData, group: string[], declare: FileVarDecl) => {
    const context: RefreshVarDeclContext = {
        hasFs: hasFs(),
        files,
        workdir,
        usingGroups,
        usingVars,
        parsedVarDecl,
        parsingStack,
        dfs,
        normalizeSubtreePathKey,
        updateUsingGroups,
        updateUsingVars,
        readTreeFromFile,
        alertError,
        logger,
    };

    if (context.hasFs) {
        return refreshVarDeclNode(root, group, declare, context);
    }
    return refreshVarDeclWebview(root, group, declare, context);
};

/**
 * Return true if any node in the subtree root (raw parsed JSON, before applyTreeDefaults)
 * is missing a `$id`. Used to decide whether to write-back $id to the subtree file.
 */
export const subtreeNeedsMissingIds = (root: unknown): boolean => {
    if (!root || typeof root !== "object") return false;
    const node = root as { $id?: string; children?: unknown[] };
    if (!node.$id) return true;
    if (node.children) {
        for (const child of node.children) {
            if (subtreeNeedsMissingIds(child)) return true;
        }
    }
    return false;
};

/**
 * Compute the diff between the original subtree node data and the edited node data.
 * Returns only the fields that differ (keyed by field name). Empty input/output arrays
 * are treated as "no data" (same as undefined).
 */
export const computeNodeOverride = (
    original: NodeData,
    edited: NodeData,
    def: ReturnType<typeof nodeDefs.get>
): Pick<NodeData, "desc" | "input" | "output" | "args" | "debug" | "disabled"> | null => {
    const diff: Pick<NodeData, "desc" | "input" | "output" | "args" | "debug" | "disabled"> = {};
    let hasDiff = false;

    if ((edited.desc || undefined) !== (original.desc || undefined)) {
        diff.desc = edited.desc || undefined;
        hasDiff = true;
    }

    if ((edited.debug || undefined) !== (original.debug || undefined)) {
        diff.debug = edited.debug || undefined;
        hasDiff = true;
    }

    if ((edited.disabled || undefined) !== (original.disabled || undefined)) {
        diff.disabled = edited.disabled || undefined;
        hasDiff = true;
    }

    // args: k/v comparison; only track keys defined in the node def
    if (def.args?.length) {
        let argsDiff = false;
        const diffArgs: { [key: string]: unknown } = {};
        for (const arg of def.args) {
            const origVal = original.args?.[arg.name];
            const editVal = edited.args?.[arg.name];
            if (JSON.stringify(origVal) !== JSON.stringify(editVal)) {
                diffArgs[arg.name] = editVal;
                argsDiff = true;
            }
        }
        if (argsDiff) {
            diff.args = diffArgs;
            hasDiff = true;
        }
    }

    // input: empty array [] treated as no data
    const origInput = (original.input ?? []).filter((v) => v);
    const editInput = (edited.input ?? []).filter((v) => v);
    if (JSON.stringify(origInput) !== JSON.stringify(editInput)) {
        diff.input = editInput.length ? edited.input : undefined;
        hasDiff = true;
    }

    // output: same as input
    const origOutput = (original.output ?? []).filter((v) => v);
    const editOutput = (edited.output ?? []).filter((v) => v);
    if (JSON.stringify(origOutput) !== JSON.stringify(editOutput)) {
        diff.output = editOutput.length ? edited.output : undefined;
        hasDiff = true;
    }

    return hasDiff ? diff : null;
};

const parsingStack: string[] = [];

export const createNode = (data: NodeData, includeChildren: boolean = true) => {
    const node: NodeData = {
        $id: data.$id,
        id: data.id,
        name: data.name,
        desc: data.desc,
        path: data.path,
        debug: data.debug,
        disabled: data.disabled,
    };
    if (data.input) {
        node.input = [];
        for (const v of data.input) {
            node.input.push(v ?? "");
        }
    }
    if (data.output) {
        node.output = [];
        for (const v of data.output) {
            node.output.push(v ?? "");
        }
    }
    if (data.args) {
        node.args = {};
        for (const k in data.args) {
            const v = data.args[k];
            if (v !== undefined) {
                node.args[k] = v;
            }
        }
    }
    if (data.children && !isSubtreeRoot(data) && includeChildren) {
        node.children = [];
        for (const child of data.children) {
            node.children.push(createNode(child));
        }
    }
    return node;
};

export const isValidChildren = (data: NodeData) => {
    const def = nodeDefs.get(data.name);
    if (def.children !== undefined && def.children !== -1) {
        return (data.children?.filter((c) => !c.disabled).length || 0) === def.children;
    }
    return true;
};

export const isVariadic = (def: string[], i: number) => {
    if (i === -1) {
        i = def.length - 1;
    }
    return def[i].endsWith("...") && i === def.length - 1;
};

const isValidInputOrOutput = (def: string[], data: string[] | undefined, index: number) => {
    return def[index].includes("?") || data?.[index] || isVariadic(def, index);
};

/** Single bridge from legacy singleton state into the extracted build pipeline. */
export const buildProject = async (project: string, buildDir: string) => {
    return buildProjectWithContext(project, buildDir, {
        workdir,
        nodeDefs,
        files,
        parsedVarDecl,
        dfs,
        isSubtreeRoot,
        refreshVarDecl,
        checkNodeData,
        setCheckExpr,
    });
};

export const createNewTree = (name: string) => {
    const tree: TreeData = {
        version: VERSION,
        name,
        prefix: "",
        group: [],
        import: [],
        vars: [],
        root: {
            id: "1",
            name: "Sequence",
            $id: nanoid(),
        },
        custom: {},
        $override: {},
    };
    return tree;
};

export const isTreeFile = (path: string) => {
    const lower = path.toLocaleLowerCase();
    return lower.endsWith(".json");
};

export { getFs, setFs, hasFs } from "./b3fs";
