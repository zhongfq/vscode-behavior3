import { getFs, hasFs } from "./b3fs";
import type { FileVarDecl, ImportDecl, NodeData, NodeDef, TreeData } from "./b3type";
import type { BuildEnv, BuildScript, NodeArgChecker, NodeArgCheckResult } from "./b3build-model";
import { logger } from "./logger";
import b3path from "./b3path";
import { stringifyJson } from "./stringify";
import { readWorkspace } from "./util";
import { loadSubtreeSourceCache } from "../subtree-source-cache";
import { materializePersistedTree, type MaterializedTreeNode } from "../tree-materializer";
import { parsePersistedTreeContent } from "../tree";

/**
 * Shared build pipeline helpers.
 * This module owns file discovery, subtree materialization, runtime hook
 * loading, and output serialization for offline/project builds.
 */
const SKIP_JSON_BASENAMES = new Set([
    "package.json",
    "package-lock.json",
    "jsconfig.json",
    "components.json",
]);

export const isBehaviorTreeJsonPath = (filePath: string): boolean => {
    const normalized = b3path.posixPath(filePath);
    if (!normalized.toLowerCase().endsWith(".json")) {
        return false;
    }

    const base = b3path.basename(normalized);
    const lowerBase = base.toLowerCase();
    if (SKIP_JSON_BASENAMES.has(lowerBase)) {
        return false;
    }

    if (lowerBase === "tsconfig.json" || /^tsconfig\..*\.json$/i.test(base)) {
        return false;
    }

    const lowerPath = `/${normalized.toLowerCase().replace(/^[/\\]+/, "")}`;
    return !["/.vscode/", "/.git/", "/node_modules/", "/dist/", "/build/"].some((marker) =>
        lowerPath.includes(marker)
    );
};

export type {
    BuildEnv,
    BuildLogger,
    BuildScript,
    FsLike,
    NodeArgCheckContext,
    NodeArgChecker,
    NodeArgCheckerClass,
    NodeArgCheckResult,
    PathLike,
} from "./b3build-model";

type HookCtor = new (env: BuildEnv) => BuildScript;
type NodeArgCheckerCtor = new (env: BuildEnv) => NodeArgChecker;

type OptionalRequire = {
    cache?: Record<string, unknown>;
    resolve?(id: string): string;
};

type TypeScriptApi = typeof import("typescript");
type TypeScriptNode = import("typescript").Node;
type TypeScriptSourceFile = import("typescript").SourceFile;
type TypeScriptTransformerFactory = import("typescript").TransformerFactory<TypeScriptSourceFile>;
type RuntimeProcess = {
    env?: Record<string, string | undefined>;
    type?: string;
    once?(event: string, listener: () => void): unknown;
    exit?(code?: number): unknown;
};
type RuntimeGlobals = typeof globalThis & {
    behavior3?: unknown;
};

interface BuildContext {
    workdir: string;
    nodeDefs: ReadonlyMap<string, NodeDef>;
    checkExprOverride?: boolean;
    buildScriptDebug?: boolean;
    files: Record<string, number>;
    parsedVarDecl: Record<string, ImportDecl>;
    dfs<T extends { children?: T[] }>(
        node: T,
        visitor: (node: T, depth: number) => unknown,
        depth?: number
    ): void;
    isSubtreeRoot(data: NodeData): boolean;
    refreshVarDecl(root: NodeData, group: string[], declare: FileVarDecl): boolean;
    checkNodeData(data: NodeData | null | undefined, printer: (message: string) => void): boolean;
    setCheckExpr(check: boolean): void;
}

const hasBatchHookMethod = (obj: unknown): obj is BuildScript => {
    if (!obj || typeof obj !== "object") {
        return false;
    }
    const candidate = obj as Partial<BuildScript>;
    return (
        typeof candidate.onProcessTree === "function" ||
        typeof candidate.onProcessNode === "function" ||
        typeof candidate.onWriteFile === "function" ||
        typeof candidate.onComplete === "function"
    );
};

const BUILD_HOOK_MARKER = "__behavior3BuildHook";
const CHECK_HOOK_MARKER = "__behavior3CheckHook";
const CHECK_HOOK_NAME = "__behavior3CheckName";

type MarkedHookCtor = HookCtor & {
    [BUILD_HOOK_MARKER]?: true;
};

type MarkedCheckCtor = NodeArgCheckerCtor & {
    [CHECK_HOOK_MARKER]?: true;
    [CHECK_HOOK_NAME]?: string;
};

const markBuildHook = <T extends new (...args: unknown[]) => unknown>(ctor: T) => {
    Object.defineProperty(ctor, BUILD_HOOK_MARKER, {
        value: true,
        configurable: false,
    });
    return ctor;
};

const markCheckCtor = <T extends new (...args: unknown[]) => unknown>(
    ctor: T,
    explicitName?: string
) => {
    const name = explicitName?.trim() || ctor.name;
    Object.defineProperty(ctor, CHECK_HOOK_MARKER, {
        value: true,
        configurable: false,
    });
    Object.defineProperty(ctor, CHECK_HOOK_NAME, {
        value: name,
        configurable: false,
    });
    return ctor;
};

const markCheckHook = <T extends new (...args: unknown[]) => unknown>(
    nameOrCtor?: string | T,
    _context?: ClassDecoratorContext<T>
) => {
    if (typeof nameOrCtor === "function") {
        return markCheckCtor(nameOrCtor);
    }
    return (ctor: T) => markCheckCtor(ctor, nameOrCtor);
};

const isDecoratedHookCtor = (value: unknown): value is MarkedHookCtor =>
    typeof value === "function" && (value as MarkedHookCtor)[BUILD_HOOK_MARKER] === true;

const isDecoratedCheckCtor = (value: unknown): value is MarkedCheckCtor =>
    typeof value === "function" && (value as MarkedCheckCtor)[CHECK_HOOK_MARKER] === true;

const findDecoratedHookCtor = (moduleRecord: Record<string, unknown>): HookCtor | undefined => {
    const decorated = Array.from(new Set(Object.values(moduleRecord))).filter(isDecoratedHookCtor);
    if (decorated.length > 1) {
        logger.error("build script must decorate exactly one exported class with @behavior3.build");
        return undefined;
    }
    return decorated[0];
};

const findDecoratedCheckCtors = (moduleRecord: Record<string, unknown>): MarkedCheckCtor[] =>
    Array.from(new Set(Object.values(moduleRecord))).filter(isDecoratedCheckCtor);

const createBatchHooks = (
    moduleExports: unknown,
    env: BuildEnv,
    reportMissing = true
): BuildScript | undefined => {
    /** Build scripts must expose one class entry so runtime behavior stays uniform. */
    if (!moduleExports || typeof moduleExports !== "object") {
        return undefined;
    }
    const moduleRecord = moduleExports as Record<string, unknown>;
    const defaultExport = isDecoratedCheckCtor(moduleRecord.default)
        ? undefined
        : moduleRecord.default;
    const ctor = (moduleRecord.Hook ??
        findDecoratedHookCtor(moduleRecord) ??
        defaultExport) as HookCtor | undefined;
    if (typeof ctor === "function") {
        try {
            const instance = new ctor(env);
            if (hasBatchHookMethod(instance)) {
                return instance;
            }
            logger.error("build hook class instance has no supported hook methods");
        } catch (error) {
            logger.error("failed to instantiate build hook class", error);
        }
    }

    if (reportMissing) {
        logger.error(
            "build script must export a Hook class, default class, or one @behavior3.build-decorated class"
        );
    }
    return undefined;
};

const createNodeArgCheckers = (
    moduleExports: unknown,
    env: BuildEnv
): { checkers: Map<string, NodeArgChecker>; hasError: boolean; hasCheckers: boolean } => {
    const checkers = new Map<string, NodeArgChecker>();
    let hasError = false;
    if (!moduleExports || typeof moduleExports !== "object") {
        return { checkers, hasError, hasCheckers: false };
    }

    const moduleRecord = moduleExports as Record<string, unknown>;
    const decorated = findDecoratedCheckCtors(moduleRecord);
    for (const ctor of decorated) {
        const name = ctor[CHECK_HOOK_NAME]?.trim() || ctor.name;
        if (!name) {
            logger.error("checker class must have a non-empty @behavior3.check name");
            hasError = true;
            continue;
        }
        if (checkers.has(name)) {
            logger.error(`duplicate @behavior3.check registration: ${name}`);
            hasError = true;
            continue;
        }
        try {
            const instance = new ctor(env);
            if (typeof instance.validate !== "function") {
                logger.error(`checker '${name}' must provide a validate(value, ctx) method`);
                hasError = true;
                continue;
            }
            checkers.set(name, instance);
        } catch (error) {
            logger.error(`failed to instantiate checker '${name}'`, error);
            hasError = true;
        }
    }
    return { checkers, hasError, hasCheckers: decorated.length > 0 };
};

export type BuildScriptRuntime = {
    buildScript?: BuildScript;
    nodeArgCheckers: Map<string, NodeArgChecker>;
    hasError: boolean;
    hasEntries: boolean;
};

export const createBuildScriptRuntime = (
    moduleExports: unknown,
    env: BuildEnv
): BuildScriptRuntime => {
    if (!moduleExports || typeof moduleExports !== "object") {
        return {
            nodeArgCheckers: new Map(),
            hasError: false,
            hasEntries: false,
        };
    }

    const moduleRecord = moduleExports as Record<string, unknown>;
    const hasBuildHookCandidate =
        typeof moduleRecord.Hook === "function" ||
        Object.values(moduleRecord).some(isDecoratedHookCtor) ||
        (typeof moduleRecord.default === "function" && !isDecoratedCheckCtor(moduleRecord.default));
    const buildScript = createBatchHooks(moduleExports, env, false);
    const checkerResult = createNodeArgCheckers(moduleExports, env);
    const hasEntries = Boolean(buildScript) || checkerResult.hasCheckers;
    if (!hasEntries) {
        logger.error(
            "build script must export a Hook class, default build class, @behavior3.build class, or @behavior3.check class"
        );
    }
    return {
        buildScript,
        nodeArgCheckers: checkerResult.checkers,
        hasError: checkerResult.hasError || !hasEntries || (hasBuildHookCandidate && !buildScript),
        hasEntries,
    };
};

const materializedNodeToExpandedTreeData = (node: MaterializedTreeNode): NodeData => {
    const data = node.data;
    return {
        uuid: data.uuid,
        id: data.id,
        name: data.name,
        desc: data.desc,
        args: data.args ? { ...data.args } : undefined,
        input: data.input ? [...data.input] : undefined,
        output: data.output ? [...data.output] : undefined,
        debug: data.debug,
        disabled: data.disabled,
        path: data.path,
        $status: data.$status,
        children: node.children.map((child) => materializedNodeToExpandedTreeData(child)),
    };
};

const assignSequentialNodeIds = (node: NodeData, nextId = 1): number => {
    node.id = String(nextId);
    let currentId = nextId + 1;
    for (const child of node.children ?? []) {
        currentId = assignSequentialNodeIds(child, currentId);
    }
    return currentId;
};

const clearInternalKeys = (data: NodeData | TreeData) => {
    for (const key in data) {
        if (key === "uuid" || key === "overrides" || key.startsWith("$")) {
            delete data[key as keyof (NodeData | TreeData)];
        }
    }
};

export const createFileDataWithContext = (
    data: NodeData,
    includeSubtree: boolean | undefined,
    context: Pick<BuildContext, "nodeDefs" | "isSubtreeRoot">
): NodeData => {
    const nodeData: NodeData = {
        uuid: data.uuid,
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
    const conf = context.nodeDefs.get(data.name);
    if (!conf?.input?.length) {
        nodeData.input = undefined;
    }
    if (!conf?.output?.length) {
        nodeData.output = undefined;
    }
    if (!conf?.args?.length) {
        nodeData.args = undefined;
    }

    if (data.children?.length && (includeSubtree || !context.isSubtreeRoot(data))) {
        nodeData.children = [];
        data.children.forEach((child) => {
            nodeData.children!.push(createFileDataWithContext(child, includeSubtree, context));
        });
    }
    return nodeData;
};

export const createBuildDataWithContext = async (
    treePath: string,
    context: Pick<BuildContext, "workdir" | "nodeDefs" | "dfs" | "isSubtreeRoot">
): Promise<TreeData | null> => {
    try {
        /**
         * Build output always expands subtree references into one concrete tree
         * snapshot first, then strips editor-only metadata before script hooks
         * and file writes see the result.
         */
        const content = getFs().readFileSync(treePath, "utf-8");
        const persistedTree = parsePersistedTreeContent(content, treePath);
        const subtreeSources = await loadSubtreeSourceCache({
            root: persistedTree.root,
            readContent: async (relativePath) => {
                try {
                    return getFs().readFileSync(`${context.workdir}/${relativePath}`, "utf-8");
                } catch {
                    return null;
                }
            },
        });

        const materializedRoot = materializePersistedTree({
            persistedTree,
            subtreeSources,
            nodeDefs: Array.from(context.nodeDefs.values()),
            subtreeEditable: true,
        });

        const treeModel: TreeData = {
            version: persistedTree.version,
            name: persistedTree.name,
            desc: persistedTree.desc,
            prefix: persistedTree.prefix,
            export: persistedTree.export,
            group: [...persistedTree.group],
            variables: {
                imports: [...persistedTree.variables.imports],
                locals: persistedTree.variables.locals.map((entry) => ({ ...entry })),
            },
            custom: { ...persistedTree.custom },
            overrides: { ...persistedTree.overrides },
            root: materializedNodeToExpandedTreeData(materializedRoot),
        };

        assignSequentialNodeIds(treeModel.root);
        context.dfs(treeModel.root, (node) => {
            node.id = treeModel.prefix + node.id;
        });
        treeModel.name = b3path.basenameWithoutExt(treePath);
        treeModel.root = createFileDataWithContext(treeModel.root, true, context);
        context.dfs(treeModel.root, (node) => clearInternalKeys(node));
        clearInternalKeys(treeModel);
        return treeModel;
    } catch (error) {
        logger.log("build error:", treePath, error);
    }
    return null;
};

export const processBatchTree = (
    tree: TreeData | null,
    treePath: string,
    batch: BuildScript,
    errors: string[]
) => {
    /** Tree hook runs before node recursion so it can replace or skip the root. */
    if (!tree) {
        return null;
    }
    if (batch.onProcessTree) {
        tree = batch.onProcessTree(tree, treePath, errors);
    }
    if (!tree) {
        return null;
    }
    if (batch.onProcessNode) {
        const processNode = (node: NodeData) => {
            if (node.children) {
                const children: NodeData[] = [];
                node.children.forEach((child) => {
                    const nextChild = processNode(child);
                    if (nextChild) {
                        children.push(nextChild);
                    }
                });
                node.children = children;
            }
            return batch.onProcessNode?.(node, errors);
        };
        tree.root = processNode(tree.root) ?? ({} as NodeData);
    }
    return tree;
};

export type NodeArgCheckTarget = {
    node: NodeData;
    instanceKey?: string;
    treePath?: string | null;
};

export type NodeArgCheckDiagnostic = {
    instanceKey?: string;
    nodeId: string;
    nodeName: string;
    argName: string;
    checker: string;
    message: string;
};

const normalizeNodeArgCheckResult = (result: NodeArgCheckResult): string[] => {
    if (Array.isArray(result)) {
        return result.filter((entry) => typeof entry === "string" && entry.trim());
    }
    return typeof result === "string" && result.trim() ? [result] : [];
};

const formatRuntimeError = (error: unknown): string => {
    if (error instanceof Error) {
        return error.message;
    }
    return String(error);
};

const walkTreeNodes = (node: NodeData, visit: (node: NodeData) => void): void => {
    visit(node);
    for (const child of node.children ?? []) {
        walkTreeNodes(child, visit);
    }
};

export const collectNodeArgCheckDiagnostics = (params: {
    tree: TreeData;
    treePath: string;
    env: BuildEnv;
    checkers: ReadonlyMap<string, NodeArgChecker>;
    targets?: NodeArgCheckTarget[];
}): NodeArgCheckDiagnostic[] => {
    const diagnostics: NodeArgCheckDiagnostic[] = [];
    const targets = params.targets ?? [];
    const entries = targets.length
        ? targets
        : (() => {
              const collected: NodeArgCheckTarget[] = [];
              walkTreeNodes(params.tree.root, (node) => collected.push({ node }));
              return collected;
          })();

    for (const target of entries) {
        const node = target.node;
        const nodeDef = params.env.nodeDefs.get(node.name);
        if (!nodeDef) {
            continue;
        }
        for (const arg of nodeDef.args ?? []) {
            const checkerName = arg.checker?.trim();
            if (!checkerName) {
                continue;
            }
            const pushDiagnostic = (message: string) => {
                diagnostics.push({
                    instanceKey: target.instanceKey,
                    nodeId: node.id,
                    nodeName: node.name,
                    argName: arg.name,
                    checker: checkerName,
                    message,
                });
            };
            const checker = params.checkers.get(checkerName);
            if (!checker) {
                pushDiagnostic(`checker '${checkerName}' is not registered`);
                continue;
            }
            try {
                const messages = normalizeNodeArgCheckResult(
                    checker.validate(node.args?.[arg.name], {
                        node,
                        tree: params.tree,
                        nodeDef,
                        arg,
                        argName: arg.name,
                        treePath: target.treePath ?? params.treePath,
                        env: params.env,
                    })
                );
                messages.forEach(pushDiagnostic);
            } catch (error) {
                pushDiagnostic(`checker '${checkerName}' failed: ${formatRuntimeError(error)}`);
            }
        }
    }

    return diagnostics;
};

export const formatNodeArgCheckBuildDiagnostic = (diagnostic: NodeArgCheckDiagnostic): string =>
    `check ${diagnostic.nodeId}|${diagnostic.nodeName}: ${diagnostic.argName}: ${diagnostic.message}`;

export const syncFilesFromDiskWithContext = (
    files: Record<string, number>,
    parsedVarDecl: Record<string, unknown>,
    workdir: string
) => {
    /**
     * Rebuild the file mtime index from scratch before batch builds.
     * Var-decl caches key off these mtimes, so stale entries are worse than a
     * full refresh.
     */
    if (!hasFs()) {
        return;
    }
    for (const key of Object.keys(files)) {
        delete files[key];
    }
    for (const key of Object.keys(parsedVarDecl)) {
        delete parsedVarDecl[key];
    }

    const fsApi = getFs();
    const normalizedWorkdir = workdir.replace(/[/\\]+$/, "");
    if (!normalizedWorkdir) {
        return;
    }

    for (const absPath of b3path.lsdir(normalizedWorkdir, true)) {
        if (!absPath.endsWith(".json")) {
            continue;
        }
        const rel = b3path.posixPath(
            absPath.slice(normalizedWorkdir.length + 1).replace(/^[\\/]+/, "")
        );
        try {
            files[rel] = fsApi.statSync(absPath).mtimeMs;
        } catch {
            /* ignore */
        }
    }
};

const getOptionalRequire = (): OptionalRequire | undefined => {
    const candidate = (globalThis as typeof globalThis & { require?: unknown }).require;
    return candidate && typeof candidate === "function"
        ? (candidate as OptionalRequire)
        : undefined;
};

const runtimeTypeScriptExts = new Set([".ts", ".mts"]);

const isLocalRuntimeImport = (specifier: string) =>
    specifier.startsWith(".") || specifier.startsWith("/") || b3path.isAbsolute(specifier);

const hasFile = (filePath: string) => {
    try {
        return getFs().statSync(filePath).isFile();
    } catch {
        return false;
    }
};

const replaceFileExt = (filePath: string, ext: string) => {
    const currentExt = b3path.extname(filePath);
    return currentExt ? filePath.slice(0, -currentExt.length) + ext : filePath + ext;
};

const resolveRuntimeTypeScriptImport = (specifier: string, containingPath: string) => {
    if (!isLocalRuntimeImport(specifier)) {
        return null;
    }

    const resolvedPath = b3path.posixPath(
        b3path.resolve(b3path.dirname(containingPath), specifier)
    );
    const ext = b3path.extname(resolvedPath).toLowerCase();
    if (runtimeTypeScriptExts.has(ext)) {
        return hasFile(resolvedPath) ? resolvedPath : null;
    }

    if (ext === ".js") {
        const tsPath = replaceFileExt(resolvedPath, ".ts");
        return !hasFile(resolvedPath) && hasFile(tsPath) ? tsPath : null;
    }

    if (ext === ".mjs") {
        const mtsPath = replaceFileExt(resolvedPath, ".mts");
        return !hasFile(resolvedPath) && hasFile(mtsPath) ? mtsPath : null;
    }

    if (ext) {
        return null;
    }

    for (const candidate of [
        `${resolvedPath}.ts`,
        `${resolvedPath}.mts`,
        `${resolvedPath}/index.ts`,
        `${resolvedPath}/index.mts`,
    ]) {
        if (hasFile(candidate)) {
            return candidate;
        }
    }
    return null;
};

const toRuntimeImportSpecifier = (fromPath: string, toPath: string) => {
    let relativePath = b3path.posixPath(b3path.relative(b3path.dirname(fromPath), toPath));
    if (!relativePath.startsWith(".")) {
        relativePath = `./${relativePath}`;
    }
    return relativePath;
};

const cleanupRuntimeModules = (paths: string[]) => {
    for (const filePath of [...paths].reverse()) {
        try {
            getFs().unlinkSync(filePath);
        } catch {
            /* ignore temp file cleanup failure */
        }
    }
};

const runtimeModuleBaseName = (sourcePath: string) =>
    b3path.basenameWithoutExt(sourcePath).replace(/[^a-zA-Z0-9._-]/g, "_") || "module";

const cleanupStaleRuntimeModulesForSource = (sourcePath: string) => {
    const fsApi = getFs();
    const dir = b3path.dirname(sourcePath);
    const base = runtimeModuleBaseName(sourcePath);
    let entries: string[];
    try {
        entries = fsApi.readdirSync(dir);
    } catch {
        return;
    }

    cleanupRuntimeModules(
        entries
            .filter((entry) => entry.startsWith(`${base}.runtime.`) && entry.endsWith(".mjs"))
            .map((entry) => b3path.join(dir, entry))
    );
};

const deferredRuntimeModuleCleanup = new Set<string>();
let runtimeModuleExitCleanupRegistered = false;

const getRuntimeProcess = (): RuntimeProcess | undefined => {
    const candidate = (globalThis as typeof globalThis & { process?: unknown }).process;
    return candidate && typeof candidate === "object" ? (candidate as RuntimeProcess) : undefined;
};

const withBehavior3BuildDecoratorGlobal = async <T>(loader: () => Promise<T>): Promise<T> => {
    const runtimeGlobal = globalThis as RuntimeGlobals;
    const hadBehavior3 = Object.prototype.hasOwnProperty.call(runtimeGlobal, "behavior3");
    const previousBehavior3 = runtimeGlobal.behavior3;
    runtimeGlobal.behavior3 = {
        ...(previousBehavior3 && typeof previousBehavior3 === "object"
            ? (previousBehavior3 as Record<string, unknown>)
            : {}),
        build: markBuildHook,
        check: markCheckHook,
    };
    try {
        return await loader();
    } finally {
        if (hadBehavior3) {
            runtimeGlobal.behavior3 = previousBehavior3;
        } else {
            delete runtimeGlobal.behavior3;
        }
    }
};

const deferRuntimeModuleCleanup = (paths: string[]) => {
    paths.forEach((filePath) => deferredRuntimeModuleCleanup.add(filePath));
    const runtimeProcess = getRuntimeProcess();
    if (!runtimeModuleExitCleanupRegistered && typeof runtimeProcess?.once === "function") {
        runtimeModuleExitCleanupRegistered = true;
        runtimeProcess.once("exit", flushDeferredRuntimeModuleCleanup);
        runtimeProcess.once("beforeExit", flushDeferredRuntimeModuleCleanup);
        const signalExitCodes: Record<string, number> = {
            SIGHUP: 129,
            SIGINT: 130,
            SIGTERM: 143,
        };
        Object.entries(signalExitCodes).forEach(([signal, exitCode]) => {
            runtimeProcess.once?.(signal, () => {
                flushDeferredRuntimeModuleCleanup();
                runtimeProcess.exit?.(exitCode);
            });
        });
    }
};

const flushDeferredRuntimeModuleCleanup = () => {
    const paths = Array.from(deferredRuntimeModuleCleanup);
    deferredRuntimeModuleCleanup.clear();
    cleanupRuntimeModules(paths);
};

const isBuildScriptDebugEnabled = () => {
    const value = getRuntimeProcess()?.env?.BEHAVIOR3_BUILD_DEBUG?.toLowerCase();
    return value === "1" || value === "true" || value === "yes";
};

const createRuntimeTypeScriptModuleGraph = (
    ts: TypeScriptApi,
    entryPath: string,
    debug: boolean
): { modulePath: string; cleanupPaths: string[] } => {
    const cleanupPaths: string[] = [];
    const emitted = new Map<string, string>();
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let moduleIndex = 0;

    const createTempModulePath = (sourcePath: string) => {
        cleanupStaleRuntimeModulesForSource(sourcePath);
        const base = runtimeModuleBaseName(sourcePath);
        const tempPath = b3path.join(
            b3path.dirname(sourcePath),
            `${base || "module"}.runtime.${runId}.${moduleIndex++}.mjs`
        );
        cleanupPaths.push(tempPath);
        return tempPath;
    };

    const emitModule = (sourcePath: string): string => {
        const normalizedSourcePath = b3path.posixPath(sourcePath);
        const existing = emitted.get(normalizedSourcePath);
        if (existing) {
            return existing;
        }

        const tempModulePath = createTempModulePath(normalizedSourcePath);
        emitted.set(normalizedSourcePath, tempModulePath);

        const rewriteImports: TypeScriptTransformerFactory = (context) => {
            const rewriteSpecifier = (specifier: string) => {
                const importedPath = resolveRuntimeTypeScriptImport(
                    specifier,
                    normalizedSourcePath
                );
                return importedPath
                    ? toRuntimeImportSpecifier(tempModulePath, emitModule(importedPath))
                    : null;
            };

            const visit = (node: TypeScriptNode): TypeScriptNode => {
                if (
                    ts.isImportDeclaration(node) &&
                    !node.importClause?.isTypeOnly &&
                    ts.isStringLiteral(node.moduleSpecifier)
                ) {
                    const nextSpecifier = rewriteSpecifier(node.moduleSpecifier.text);
                    if (nextSpecifier) {
                        return ts.factory.updateImportDeclaration(
                            node,
                            node.modifiers,
                            node.importClause,
                            ts.factory.createStringLiteral(nextSpecifier),
                            node.attributes
                        );
                    }
                }

                if (
                    ts.isExportDeclaration(node) &&
                    !node.isTypeOnly &&
                    node.moduleSpecifier &&
                    ts.isStringLiteral(node.moduleSpecifier)
                ) {
                    const nextSpecifier = rewriteSpecifier(node.moduleSpecifier.text);
                    if (nextSpecifier) {
                        return ts.factory.updateExportDeclaration(
                            node,
                            node.modifiers,
                            node.isTypeOnly,
                            node.exportClause,
                            ts.factory.createStringLiteral(nextSpecifier),
                            node.attributes
                        );
                    }
                }

                return ts.visitEachChild(node, visit, context);
            };

            return (sourceFile) => ts.visitNode(sourceFile, visit) as TypeScriptSourceFile;
        };

        const source = getFs().readFileSync(normalizedSourcePath, "utf8");
        const transpiled = ts.transpileModule(source, {
            compilerOptions: {
                module: ts.ModuleKind.ESNext,
                target: ts.ScriptTarget.ES2020,
                sourceMap: false,
                inlineSourceMap: debug,
                inlineSources: debug,
                removeComments: false,
                experimentalDecorators: true,
            },
            transformers: {
                before: [rewriteImports],
            },
            fileName: normalizedSourcePath,
        });
        getFs().writeFileSync(tempModulePath, transpiled.outputText, "utf8");
        return tempModulePath;
    };

    return {
        modulePath: emitModule(entryPath),
        cleanupPaths,
    };
};

export const loadRuntimeModule = async (modulePath: string, options?: { debug?: boolean }) => {
    let tempModulePath: string | null = null;
    let cleanupPaths: string[] = [];
    const debugBuildScript = options?.debug ?? isBuildScriptDebugEnabled();
    try {
        /**
         * Build scripts may be TS/JS/MJS and can be edited between runs.
         * We evict require cache, transpile TS module graphs when needed, and
         * load through a timestamped ESM path so every build sees the latest script.
         */
        const optionalRequire = getOptionalRequire();
        if (optionalRequire?.cache) {
            try {
                const resolvedPath = optionalRequire.resolve?.(modulePath);
                if (resolvedPath) {
                    delete optionalRequire.cache[resolvedPath];
                }
            } catch {
                /* path may not be in require cache */
            }
        }
        if (getRuntimeProcess()?.type === "renderer") {
            return await withBehavior3BuildDecoratorGlobal(() =>
                import(/* @vite-ignore */ `${modulePath}?t=${Date.now()}`)
            );
        }

        const ext = b3path.extname(modulePath).toLowerCase();
        if (ext === ".ts" || ext === ".mts") {
            const ts = await import("typescript");
            const runtimeModule = createRuntimeTypeScriptModuleGraph(
                ts,
                modulePath,
                debugBuildScript
            );
            tempModulePath = runtimeModule.modulePath;
            cleanupPaths = runtimeModule.cleanupPaths;
        } else if (ext === ".mjs") {
            tempModulePath = modulePath;
        } else if (ext === ".js") {
            tempModulePath = modulePath.replace(".js", `.runtime.${Date.now()}.mjs`);
            getFs().copyFileSync(modulePath, tempModulePath);
            cleanupPaths = [tempModulePath];
        } else {
            logger.error(`unsupported build script extension '${ext || "(none)"}': ${modulePath}`);
            return null;
        }

        const normalizedModulePath = b3path.posixPath(tempModulePath);
        const result = await withBehavior3BuildDecoratorGlobal(() =>
            import(/* @vite-ignore */ `file:///${normalizedModulePath}?t=${Date.now()}`)
        );
        if (debugBuildScript && cleanupPaths.length) {
            logger.info(
                `build script debug: keeping runtime modules until build completes:\n${cleanupPaths.join(
                    "\n"
                )}`
            );
            deferRuntimeModuleCleanup(cleanupPaths);
        } else {
            cleanupRuntimeModules(cleanupPaths);
        }
        return result;
    } catch (error) {
        logger.error(`failed to load module: ${modulePath}`, error);
        if (debugBuildScript && cleanupPaths.length) {
            logger.info(
                `build script debug: keeping runtime modules after load failure:\n${cleanupPaths.join(
                    "\n"
                )}`
            );
        } else {
            cleanupRuntimeModules(cleanupPaths);
        }
        return null;
    }
};

export const buildProjectWithContext = async (
    project: string,
    buildDir: string,
    context: BuildContext
) => {
    /**
     * Batch build walks every tree file under the project, materializes it with
     * current subtree/import context, validates the result, then writes the
     * exported JSON into the mirrored build directory.
     */
    if (hasFs()) {
        syncFilesFromDiskWithContext(context.files, context.parsedVarDecl, context.workdir);
    }

    let hasError = false;
    const settings = readWorkspace(project).settings;
    const buildSetting = settings.buildScript;
    let buildScriptModule: unknown;
    context.setCheckExpr(context.checkExprOverride ?? settings.checkExpr ?? true);
    if (buildSetting) {
        const scriptPath = context.workdir + "/" + buildSetting;
        try {
            buildScriptModule = await loadRuntimeModule(scriptPath, {
                debug: context.buildScriptDebug,
            });
        } catch {
            logger.error(`'${scriptPath}' is not a valid build script`);
        }
    }

    const scriptEnv: BuildEnv = {
        fs: getFs(),
        path: b3path,
        workdir: context.workdir,
        nodeDefs: context.nodeDefs,
        logger,
    };
    const buildRuntime = createBuildScriptRuntime(buildScriptModule, scriptEnv);
    if (buildSetting && (!buildScriptModule || buildRuntime.hasError)) {
        hasError = true;
    }

    const allErrors: string[] = [];
    for (const candidatePath of b3path.lsdir(b3path.dirname(project), true)) {
        if (!isBehaviorTreeJsonPath(candidatePath)) {
            continue;
        }

        const buildPath = buildDir + "/" + candidatePath.substring(context.workdir.length + 1);
        let tree = await createBuildDataWithContext(candidatePath, context);
        const errors: string[] = [];
        if (buildRuntime.buildScript) {
            tree = processBatchTree(tree, candidatePath, buildRuntime.buildScript, errors);
        }
        if (!tree) {
            continue;
        }
        if (tree.export === false) {
            logger.log("skip:", buildPath);
            continue;
        }
        logger.log("build:", buildPath);
        if (errors.length) {
            hasError = true;
        }
        const declare: FileVarDecl = {
            import: tree.variables.imports.map((importPath) => ({
                path: importPath,
                vars: [],
                depends: [],
            })),
            vars: tree.variables.locals.map((variable) => ({
                name: variable.name,
                desc: variable.desc,
            })),
            subtree: [],
        };
        context.refreshVarDecl(tree.root, tree.group, declare);
        if (!context.checkNodeData(tree.root, (message) => errors.push(message))) {
            hasError = true;
        }
        const checkDiagnostics = collectNodeArgCheckDiagnostics({
            tree,
            treePath: candidatePath,
            env: scriptEnv,
            checkers: buildRuntime.nodeArgCheckers,
        });
        if (checkDiagnostics.length) {
            hasError = true;
            checkDiagnostics.forEach((diagnostic) =>
                errors.push(formatNodeArgCheckBuildDiagnostic(diagnostic))
            );
        }
        if (errors.length) {
            allErrors.push(`${candidatePath}:`);
            errors.forEach((message) => allErrors.push(`  ${message}`));
        }
        buildRuntime.buildScript?.onWriteFile?.(buildPath, tree);
        getFs().mkdirSync(b3path.dirname(buildPath), { recursive: true });
        getFs().writeFileSync(buildPath, stringifyJson(tree, { indent: 2 }));
    }

    allErrors.forEach((message) => logger.error(message));
    buildRuntime.buildScript?.onComplete?.(hasError ? "failure" : "success");
    flushDeferredRuntimeModuleCleanup();
    return hasError;
};
