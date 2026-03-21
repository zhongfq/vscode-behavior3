// Adapted from original b3util.ts for webview (browser) environment.
// Removed: fs, Node.js path, readTree/readWorkspace/buildProject/loadModule.
// initWorkdir → initWithNodeDefs (receives pre-loaded defs from extension host).
// refreshNodeData: subtree file loading replaced by a readFile callback.
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
import { stringifyJson } from "./stringify";
import { basenameWithoutExt, nanoid, readTree } from "./util";

// Import ExpressionEvaluator from behavior3 submodule (resolved via vite alias @behavior3)
// If the submodule isn't available, the expression check degrades gracefully.
let ExpressionEvaluator: { new (expr: string): { dryRun(): boolean } } | undefined;
try {
  // Dynamic import attempt; bundler will resolve @behavior3/evaluator
  // This is resolved at build time via vite alias
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  ExpressionEvaluator = require("@behavior3/evaluator").ExpressionEvaluator;
} catch {
  // no-op: expression validation will be skipped
}

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

const parsedExprs: Record<string, string[]> = {};
let checkExpr: boolean = false;
let alertError: (msg: string, duration?: number) => void = () => {};

const unknownNodeDef: NodeDef = {
  name: "unknown",
  desc: "",
  type: "Action",
};

/** Replace initWorkdir: receive pre-loaded defs from extension host */
export const initWithNodeDefs = (
  defs: NodeDef[],
  handler: typeof alertError,
  check: boolean
) => {
  alertError = handler;
  checkExpr = check;
  const groups: Set<string> = new Set();
  nodeDefs = new NodeDefs();
  for (const node of defs) {
    node.args?.forEach((arg) => {
      if (arg.options && !Array.isArray((arg.options as Array<{ source: unknown }>)[0]?.source)) {
        arg.options = [
          {
            source: arg.options as unknown as Array<{ name: string; value: unknown }>,
          },
        ];
      }
    });
    nodeDefs.set(node.name, node);
    (node as NodeDef & { group?: string[] }).group?.forEach((g: string) => groups.add(g));
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
  return data.path && data.id !== "1";
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

export const getNodeArgOptions = (arg: NodeArg, args: Record<string, unknown>) => {
  if (!arg.options) {
    return;
  }
  const opts = arg.options as Array<{
    match?: Record<string, unknown[]>;
    source?: Array<{ name: string; value: unknown }>;
  }>;
  const defaultMatch = opts.find((option) => !option.match);
  if (defaultMatch) {
    return defaultMatch.source;
  }
  return opts.find((entry) =>
    Object.entries(entry.match!).every(([key, value]) => (value as unknown[]).includes(args[key]))
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
    const found = !!options?.find((option) => option.value === value);
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

  if ((conf as NodeDef & { group?: string[] }).group) {
    const group = (conf as NodeDef & { group?: string[] }).group!;
    if (!group.some((g) => usingGroups?.[g])) {
      error(`node group '${group}' is not enabled`);
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
        if (checkExpr && ExpressionEvaluator) {
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
            } catch {
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
        error(`input field '${data.input[i]}' is not a valid variable name`);
        hasError = true;
      }
      if (!isValidInputOrOutput(conf.input, data.input, i)) {
        error(`input field '${conf.input[i]}' is required`);
        hasError = true;
      }
      if (i === conf.input.length - 1 && conf.input.at(-1)?.endsWith("...")) {
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
        error(`output field '${data.output[i]}' is not a valid variable name`);
        hasError = true;
      }
      if (!isValidInputOrOutput(conf.output, data.output, i)) {
        error(`output field '${conf.output[i]}' is required`);
        hasError = true;
      }
      if (i === conf.output.length - 1 && conf.output.at(-1)?.endsWith("...")) {
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
    node.input = data.input.map((v) => v ?? "");
  }
  if (data.output) {
    node.output = data.output.map((v) => v ?? "");
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
    node.children = data.children.map((child) => createNode(child));
  }
  return node;
};

const enum StatusFlag {
  SUCCESS = 2,
  FAILURE = 1,
  RUNNING = 0,
  SUCCESS_ZERO = 5,
  FAILURE_ZERO = 4,
}

const toStatusFlag = (data: NodeData) => {
  let status = 0;
  const def = nodeDefs.get(data.name) as NodeDef & { status?: string[] };
  def.status?.forEach((s) => {
    switch (s) {
      case "success":
        status |= 1 << StatusFlag.SUCCESS;
        break;
      case "failure":
        status |= 1 << StatusFlag.FAILURE;
        break;
      case "running":
        status |= 1 << StatusFlag.RUNNING;
        break;
    }
  });
  return status;
};

const appendStatusFlag = (status: number, childStatus: number) => {
  const childSuccess = (childStatus >> StatusFlag.SUCCESS) & 1;
  const childFailure = (childStatus >> StatusFlag.FAILURE) & 1;
  if (childSuccess === 0) {
    status |= 1 << StatusFlag.SUCCESS_ZERO;
  }
  if (childFailure === 0) {
    status |= 1 << StatusFlag.FAILURE_ZERO;
  }
  status |= childStatus;
  return status;
};

const buildStatusFlag = (data: NodeData, childStatus: number) => {
  let status = data.$status!;
  const def = nodeDefs.get(data.name) as NodeDef & { status?: string[] };
  if (def.status?.length) {
    const childSuccess = (childStatus >> StatusFlag.SUCCESS) & 1;
    const childFailure = (childStatus >> StatusFlag.FAILURE) & 1;
    const childRunning = (childStatus >> StatusFlag.RUNNING) & 1;
    const childHasZeroSuccess = (childStatus >> StatusFlag.SUCCESS_ZERO) & 1;
    const childHasZeroFailure = (childStatus >> StatusFlag.FAILURE_ZERO) & 1;
    def.status?.forEach((s) => {
      switch (s) {
        case "!success":
          status |= childFailure << StatusFlag.SUCCESS;
          break;
        case "!failure":
          status |= childSuccess << StatusFlag.FAILURE;
          break;
        case "|success":
          status |= childSuccess << StatusFlag.SUCCESS;
          break;
        case "|failure":
          status |= childFailure << StatusFlag.FAILURE;
          break;
        case "|running":
          status |= childRunning << StatusFlag.RUNNING;
          break;
        case "&success":
          if (childHasZeroSuccess) {
            status &= ~(1 << StatusFlag.SUCCESS);
          } else {
            status |= childSuccess << StatusFlag.SUCCESS;
          }
          break;
        case "&failure":
          if (childHasZeroFailure) {
            status &= ~(1 << StatusFlag.FAILURE);
          } else {
            status |= childFailure << StatusFlag.FAILURE;
          }
          break;
      }
    });
    data.$status = status;
  } else {
    data.$status = status | childStatus;
  }
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

/**
 * Adapter: subtree file reader for refreshNodeData.
 * The webview calls the extension host to read files via postMessage.
 * This sync version is a best-effort; async subtree loading is handled
 * by the editor webview's vscodeApi.readFile.
 */
let subtreeCache: Record<string, TreeData> = {};

export const setSubtreeCache = (path: string, text: string) => {
  try {
    subtreeCache[path] = readTree(text);
  } catch {
    // ignore
  }
};

export const clearSubtreeCache = () => {
  subtreeCache = {};
};

const parsingStack: string[] = [];

export const refreshNodeData = (tree: TreeData, node: NodeData, id: number): number => {
  node.id = (id++).toString();
  node.$size = calcSize(node);

  const def = nodeDefs.get(node.name);
  if (def.args) {
    node.args ||= {};
    def.args.forEach((arg) => {
      if (node.args![arg.name] === undefined && arg.default !== undefined) {
        node.args![arg.name] = arg.default;
      }
    });
  }

  if (node.path) {
    if (parsingStack.indexOf(node.path) >= 0) {
      alertError(`循环引用节点：${node.path}`);
      return id;
    }
    delete node.$mtime;
    parsingStack.push(node.path);
    try {
      const subtree = subtreeCache[node.path];
      if (subtree) {
        id = refreshNodeData(subtree, subtree.root, --id);
        node.name = subtree.root.name;
        node.desc = subtree.root.desc;
        node.args = subtree.root.args;
        node.input = subtree.root.input;
        node.output = subtree.root.output;
        node.children = subtree.root.children;
        node.$size = calcSize(node);
      }
    } catch (e) {
      alertError(`解析子树失败：${node.path}`);
    }
    parsingStack.pop();
  } else if (node.children?.length) {
    for (let i = 0; i < node.children.length; i++) {
      id = refreshNodeData(tree, node.children[i], id);
    }
  }

  node.$status = toStatusFlag(node);
  if (node.children) {
    let childStatus = 0;
    node.children.forEach((child) => {
      if (child.$status && !child.disabled) {
        childStatus = appendStatusFlag(childStatus, child.$status);
      }
    });
    buildStatusFlag(node, childStatus);
  }

  return id;
};

export const createFileData = (data: NodeData, includeSubtree?: boolean) => {
  const nodeData: NodeData = {
    $id: data.$id,
    id: data.id,
    name: data.name,
    desc: data.desc || undefined,
    args: data.args || undefined,
    input: data.input || undefined,
    output: data.output || undefined,
    debug: data.debug || undefined,
    disabled: data.disabled || undefined,
    path: data.path || undefined,
  };
  const conf = nodeDefs.get(data.name);
  if (!conf.input?.length) {
    nodeData.input = undefined;
  }
  if (!conf.output?.length) {
    nodeData.output = undefined;
  }
  if (!conf.args?.length) {
    nodeData.args = undefined;
  }
  if (data.children?.length && (includeSubtree || !isSubtreeRoot(data))) {
    nodeData.children = data.children.map((child) => createFileData(child, includeSubtree));
  }
  return nodeData;
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
  return lower.endsWith(".json") || lower.endsWith(".b3tree");
};

/**
 * Simplified refreshVarDecl for webview: only updates group/var state
 * without reading subtree files (file reading handled by extension host).
 */
export const refreshVarDecl = (root: NodeData, group: string[], declare: FileVarDecl) => {
  const vars: VarDecl[] = [...declare.vars];

  declare.import.forEach((entry) => {
    entry.vars.forEach((v) => {
      if (!vars.find((x) => x.name === v.name)) {
        vars.push(v);
      }
    });
  });

  declare.subtree = collectSubtree(root).map((v) => ({
    path: v,
    vars: [],
    depends: [],
  }));

  let changed = false;
  const lastGroup = Array.from(Object.keys(usingGroups ?? {})).sort();
  const sortedGroup = [...group].sort();
  if (
    lastGroup.length !== sortedGroup.length ||
    lastGroup.some((v, i) => v !== sortedGroup[i])
  ) {
    changed = true;
    updateUsingGroups(group);
  }

  const lastVars = Array.from(Object.keys(usingVars ?? {})).sort();
  vars.sort((a, b) => a.name.localeCompare(b.name));
  if (lastVars.length !== vars.length || lastVars.some((v, i) => v !== vars[i].name)) {
    changed = true;
    updateUsingVars(vars);
  }
  return changed;
};

const collectSubtree = (data: NodeData) => {
  const list: string[] = [];
  dfs(data, (node) => {
    if (node.path) {
      list.push(node.path);
    }
  });
  return list;
};

export const stringifyTree = (data: TreeData, name: string): string => {
  return stringifyJson(
    {
      version: VERSION,
      name,
      desc: data.desc,
      prefix: data.prefix,
      export: data.export,
      group: data.group,
      import: data.import,
      vars: data.vars,
      root: data.root,
      custom: data.custom,
      $override: data.$override,
    },
    { indent: 2 }
  );
};
