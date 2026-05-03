import type * as Fs from "fs";
import { getFs, hasFs } from "./b3fs";
import type { FileVarDecl, ImportDecl, NodeData, NodeDef, TreeData } from "./b3type";
import { isBehaviorTreeJsonPath } from "./behavior-tree-files";
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
    fs: typeof Fs;
    path: typeof b3path;
    workdir: string;
    nodeDefs: ReadonlyMap<string, NodeDef>;
    logger: Pick<typeof logger, "debug" | "info" | "warn" | "error" | "log">;
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

interface BuildContext {
    workdir: string;
    nodeDefs: ReadonlyMap<string, NodeDef>;
    checkExprOverride?: boolean;
    files: Record<string, number>;
    parsedVarDecl: Record<string, ImportDecl>;
    dfs<T extends { children?: T[] }>(
        node: T,
        visitor: (node: T, depth: number) => unknown,
        depth?: number
    ): void;
    isSubtreeRoot(data: NodeData): boolean;
    refreshVarDecl(root: NodeData, group: string[], declare: FileVarDecl): boolean;
    checkNodeData(
        data: NodeData | null | undefined,
        printer: (message: string) => void
    ): boolean;
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
        $id: data.$id,
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
        if (key.startsWith("$")) {
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
            import: [...persistedTree.import],
            vars: persistedTree.vars.map((entry) => ({ ...entry })),
            custom: { ...persistedTree.custom },
            $override: { ...persistedTree.$override },
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

export const loadRuntimeModule = async (modulePath: string) => {
    let tempModulePath: string | null = null;
    try {
        /**
         * Build scripts may be TS/JS/MJS and can be edited between runs.
         * We evict require cache, transpile TS on the fly when needed, and load
         * through a timestamped ESM path so every build sees the latest script.
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
        if (typeof process !== "undefined" && (process as { type?: string }).type === "renderer") {
            return await import(/* @vite-ignore */ `${modulePath}?t=${Date.now()}`);
        }

        const ext = b3path.extname(modulePath).toLowerCase();
        if (ext === ".ts" || ext === ".mts") {
            const ts = await import("typescript");
            const source = getFs().readFileSync(modulePath, "utf8");
            const transpiled = ts.transpileModule(source, {
                compilerOptions: {
                    module: ts.ModuleKind.ESNext,
                    target: ts.ScriptTarget.ES2020,
                    sourceMap: false,
                    inlineSourceMap: false,
                    inlineSources: false,
                    removeComments: false,
                },
                fileName: modulePath,
            });
            const base = b3path.basenameWithoutExt(modulePath);
            tempModulePath = b3path.join(
                b3path.dirname(modulePath),
                `${base}.runtime.${Date.now()}.mjs`
            );
            getFs().writeFileSync(tempModulePath, transpiled.outputText, "utf8");
        } else if (ext === ".mjs") {
            tempModulePath = modulePath;
        } else if (ext === ".js") {
            tempModulePath = modulePath.replace(".js", `.runtime.${Date.now()}.mjs`);
            getFs().copyFileSync(modulePath, tempModulePath);
        } else {
            logger.error(
                `unsupported build script extension '${ext || "(none)"}': ${modulePath}`
            );
            return null;
        }

        const normalizedModulePath = b3path.posixPath(tempModulePath);
        const result = await import(
            /* @vite-ignore */ `file:///${normalizedModulePath}?t=${Date.now()}`
        );
        if (tempModulePath !== modulePath) {
            getFs().unlinkSync(tempModulePath);
        }
        return result;
    } catch (error) {
        logger.error(`failed to load module: ${modulePath}`, error);
        if (tempModulePath && tempModulePath !== modulePath) {
            try {
                getFs().unlinkSync(tempModulePath);
            } catch {
                /* ignore temp file cleanup failure */
            }
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
            buildScriptModule = await loadRuntimeModule(scriptPath);
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
            import: tree.import.map((importPath) => ({ path: importPath, vars: [], depends: [] })),
            vars: tree.vars.map((variable) => ({ name: variable.name, desc: variable.desc })),
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
    return hasError;
};
