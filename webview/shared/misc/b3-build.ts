import { FsLike, getFs, hasFs } from "./b3fs";
import type { FileVarDecl, ImportDecl, NodeData, NodeDef, TreeData } from "./b3type";
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
type Env = {
    fs: FsLike;
    path: typeof b3path;
    workdir: string;
    nodeDefs: ReadonlyMap<string, NodeDef>;
    logger: Pick<typeof logger, "debug" | "info" | "warn" | "error" | "log">;
};

const SKIP_JSON_BASENAMES = new Set([
    "package.json",
    "package-lock.json",
    "jsconfig.json",
    "components.json",
]);

const isBehaviorTreeJsonPath = (filePath: string): boolean => {
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

export interface BatchScript {
    onProcessTree?(tree: TreeData, path: string, errors: string[]): TreeData | null;
    onProcessNode?(node: NodeData, errors: string[]): NodeData | null;
    onWriteFile?(path: string, tree: TreeData): void;
    onComplete?(status: "success" | "failure"): void;
}

type HookCtor = new (env: Env) => BatchScript;

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

const hasBatchHookMethod = (obj: unknown): obj is BatchScript => {
    if (!obj || typeof obj !== "object") {
        return false;
    }
    const candidate = obj as Partial<BatchScript>;
    return (
        typeof candidate.onProcessTree === "function" ||
        typeof candidate.onProcessNode === "function" ||
        typeof candidate.onWriteFile === "function" ||
        typeof candidate.onComplete === "function"
    );
};

const createBatchHooks = (moduleExports: unknown, env: Env): BatchScript | undefined => {
    /** Build scripts must expose one Hook-class entry so runtime behavior stays uniform. */
    if (!moduleExports || typeof moduleExports !== "object") {
        return undefined;
    }
    const moduleRecord = moduleExports as Record<string, unknown>;
    const ctor = (moduleRecord.Hook ?? moduleRecord.default) as HookCtor | undefined;
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

    logger.error("build script must export a Hook class (named export `Hook` or default export)");
    return undefined;
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
    batch: BatchScript,
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
            return await import(/* @vite-ignore */ `${modulePath}?t=${Date.now()}`);
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
        const result = await import(
            /* @vite-ignore */ `file:///${normalizedModulePath}?t=${Date.now()}`
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

    const scriptEnv: Env = {
        fs: getFs(),
        path: b3path,
        workdir: context.workdir,
        nodeDefs: context.nodeDefs,
        logger,
    };
    const buildScript = createBatchHooks(buildScriptModule, scriptEnv);
    if (buildSetting && (!buildScriptModule || !buildScript)) {
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
        if (buildScript) {
            tree = processBatchTree(tree, candidatePath, buildScript, errors);
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
        if (errors.length) {
            allErrors.push(`${candidatePath}:`);
            errors.forEach((message) => allErrors.push(`  ${message}`));
        }
        buildScript?.onWriteFile?.(buildPath, tree);
        getFs().mkdirSync(b3path.dirname(buildPath), { recursive: true });
        getFs().writeFileSync(buildPath, stringifyJson(tree, { indent: 2 }));
    }

    allErrors.forEach((message) => logger.error(message));
    buildScript?.onComplete?.(hasError ? "failure" : "success");
    flushDeferredRuntimeModuleCleanup();
    return hasError;
};
