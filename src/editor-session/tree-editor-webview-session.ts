import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import {
    normalizeTreeContentForWrite,
    readFileContentFromDisk,
    TreeEditorDocument,
} from "./document-sync";
import { getBehavior3OutputChannel } from "../output-channel";
import { formatConsoleArgs } from "../output-channel";
import { mapNodeDefsIconsForWebview } from "../node-def-icons";
import { ProjectIndex, type VarDeclResult } from "./project-index";
import {
    findB3WorkspacePath,
    getBehaviorProjectRootFsPath,
    getResolvedB3SettingDir,
    resolveNodeDefs,
    resolveWorkspaceNodeColors,
    watchSettingFile,
    watchWorkspaceFile,
} from "../setting-resolver";
import type {
    EditorToHostMessage,
    HostToEditorMessage,
    NodeDef,
} from "../../webview/shared/message-protocol";
import { isDocumentVersionNewer } from "../../webview/shared/document-version";
import { parseWorkdirRelativeJsonPath } from "../../webview/shared/protocol";
import { stringifyJson } from "../../webview/shared/misc/stringify";
import { parseWorkspaceModelContent } from "../../webview/shared/schema";
import b3path from "../../webview/shared/misc/b3path";
import { setFs } from "../../webview/shared/misc/b3fs";
import {
    collectNodeArgCheckDiagnostics,
    createBuildScriptRuntime,
    createBuildScriptRuntimeWithCheckModules,
    loadRuntimeModule,
    resolveCheckScriptPaths,
} from "../../webview/shared/misc/b3build";
import type { BuildEnv, CheckScriptModule } from "../../webview/shared/misc/b3build";
import type { NodeData, TreeData } from "../../webview/shared/misc/b3type";

setFs(fs);

/**
 * Per-webview extension-host session.
 * It serializes document mutations, bridges file/watcher events into the
 * webview protocol, and keeps project-level caches in sync with editor state.
 */
export interface ActiveTreeEditorWebview {
    workspaceFsPath: string;
    documentUri: string;
    postMessage: (message: HostToEditorMessage) => Thenable<boolean>;
}

interface EditorLiveSettings {
    checkExpr: boolean;
    subtreeEditable: boolean;
    language: "zh" | "en";
    nodeColors?: Record<string, string>;
}

interface TreeEditorSessionState {
    nodeDefs: NodeDef[];
    settingDir?: string;
    currentSettings: EditorLiveSettings;
    fileVersionIsNewer: boolean;
    newerFileVersion: string | null;
    cachedSubtreeRefs: Set<string> | null;
    subtreeRefreshTimer?: ReturnType<typeof setTimeout>;
}

interface ResolveTreeEditorSessionParams {
    document: TreeEditorDocument;
    webviewPanel: vscode.WebviewPanel;
    viewType: string;
    configureWebview(webview: vscode.Webview, workspaceFolderUri: vscode.Uri): void;
    persistMainDocumentToDisk(
        document: TreeEditorDocument,
        opts?: { notifyReload?: boolean }
    ): Promise<string>;
    writeDocumentContentToDisk(targetUri: vscode.Uri, content: string): Promise<string>;
    revertDocument(
        document: TreeEditorDocument,
        cancellation: vscode.CancellationToken
    ): Promise<void>;
    onDidChangeDocument(document: TreeEditorDocument): void;
    addActiveWebview(entry: ActiveTreeEditorWebview): void;
    removeActiveWebview(entry: ActiveTreeEditorWebview): void;
}

function getWorkdir(documentUri: vscode.Uri): vscode.Uri {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(documentUri);
    if (workspaceFolder) {
        return workspaceFolder.uri;
    }
    return vscode.Uri.file(path.dirname(documentUri.fsPath));
}

function createLiveSettingsResolver(
    workspaceFolderUri: vscode.Uri,
    documentUri: vscode.Uri
): () => Promise<EditorLiveSettings> {
    return async () => {
        const config = vscode.workspace.getConfiguration("behavior3");
        return {
            checkExpr: config.get<boolean>("checkExpr", true),
            subtreeEditable: config.get<boolean>("subtreeEditable", true),
            language: getEditorLanguage(config.get<string>("language", "auto")),
            nodeColors: await resolveWorkspaceNodeColors(workspaceFolderUri, documentUri),
        };
    };
}

function getTreeFileVersion(content: string): string | undefined {
    try {
        const fileData = JSON.parse(content) as { version?: unknown };
        return typeof fileData.version === "string" ? fileData.version : undefined;
    } catch {
        return undefined;
    }
}

function getNewerVersionMessage(
    language: EditorLiveSettings["language"],
    fileVersion: string,
    mode: "warn" | "edit"
): string {
    if (mode === "warn") {
        return language === "zh"
            ? `此文件由新版本 Behavior3(${fileVersion}) 创建，请升级到最新版本。`
            : `This file is created by a newer version of Behavior3(${fileVersion}), please upgrade to the latest version.`;
    }

    return language === "zh"
        ? `此文件由新版本 Behavior3(${fileVersion}) 创建，请升级到最新版本后再编辑。`
        : `This file is created by a newer version of Behavior3(${fileVersion}). Please upgrade to the latest version.`;
}

async function parseUsingVarsFromContent(
    projectIndex: ProjectIndex,
    content: string
): Promise<VarDeclResult | undefined> {
    try {
        return (await projectIndex.buildUsingVars(content)) ?? undefined;
    } catch {
        return undefined;
    }
}

function postVarDeclLoaded(
    postMessage: (message: HostToEditorMessage) => Thenable<boolean>,
    result: VarDeclResult,
    allFiles?: string[]
): Thenable<boolean> {
    return postMessage({
        type: "varDeclLoaded",
        usingVars: Object.values(result.usingVars),
        allFiles,
        importDecls: result.importDecls,
        subtreeDecls: result.subtreeDecls,
    });
}

async function readWorkspaceFileContent(fileUri: vscode.Uri): Promise<string> {
    const openDoc = vscode.workspace.textDocuments.find(
        (doc) => doc.uri.fsPath === fileUri.fsPath || doc.uri.toString() === fileUri.toString()
    );

    if (openDoc) {
        return openDoc.getText();
    }

    const raw = await vscode.workspace.fs.readFile(fileUri);
    return Buffer.from(raw).toString("utf-8");
}

function clearRefreshTimer(timer: ReturnType<typeof setTimeout> | undefined): undefined {
    if (timer) {
        clearTimeout(timer);
    }
    return undefined;
}

function disposeAll(disposables: vscode.Disposable[]): void {
    for (const disposable of disposables) {
        disposable.dispose();
    }
}

function uriToWorkdirRelative(uri: vscode.Uri, workdir: vscode.Uri): string | undefined {
    if (uri.scheme !== "file") return undefined;
    const rel = path.relative(workdir.fsPath, uri.fsPath).replace(/\\/g, "/");
    if (rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
    return parseWorkdirRelativeJsonPath(rel) ?? undefined;
}

function resolvePathInWorkdir(
    inputPath: string,
    workdir: vscode.Uri,
    options?: { mustBeJson?: boolean }
): vscode.Uri | undefined {
    const parsedPath = parseWorkdirRelativeJsonPath(inputPath);
    if (!parsedPath) {
        return undefined;
    }
    const candidate = path.join(workdir.fsPath, parsedPath);
    if (options?.mustBeJson && path.extname(candidate).toLowerCase() !== ".json") {
        return undefined;
    }
    const rel = path.relative(workdir.fsPath, candidate).replace(/\\/g, "/");
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
        return undefined;
    }
    return vscode.Uri.file(candidate);
}

function getVSCodeTheme(): "dark" | "light" {
    const kind = vscode.window.activeColorTheme.kind;
    return kind === vscode.ColorThemeKind.Light || kind === vscode.ColorThemeKind.HighContrastLight
        ? "light"
        : "dark";
}

function getEditorLanguage(setting: string): "zh" | "en" {
    if (setting === "zh" || setting === "en") {
        return setting;
    }
    const envLanguage = vscode.env.language.toLowerCase();
    return envLanguage.startsWith("zh") ? "zh" : "en";
}

function formatRuntimeError(error: unknown): string {
    if (error instanceof Error) {
        return error.stack ?? error.message;
    }
    return String(error);
}

function logRuntimeError(scope: string, error: unknown): void {
    getBehavior3OutputChannel().error(`[${scope}] ${formatRuntimeError(error)}`);
}

function logAsyncRuntimeError(scope: string): (error: unknown) => void {
    return (error) => logRuntimeError(scope, error);
}

function createBuildScriptLogger(): BuildEnv["logger"] {
    const write =
        (level: "debug" | "info" | "warn" | "error") =>
        (...args: unknown[]) => {
            getBehavior3OutputChannel()[level](formatConsoleArgs(args));
        };

    return {
        log: write("info"),
        debug: write("debug"),
        info: write("info"),
        warn: write("warn"),
        error: write("error"),
    };
}

const toNodeData = (node: unknown): NodeData => node as NodeData;

export async function resolveTreeEditorSession({
    document,
    webviewPanel,
    viewType,
    configureWebview,
    persistMainDocumentToDisk,
    writeDocumentContentToDisk,
    revertDocument,
    onDidChangeDocument,
    addActiveWebview,
    removeActiveWebview,
}: ResolveTreeEditorSessionParams): Promise<void> {
    const workspaceFolderUri = getWorkdir(document.uri);
    const projectRootUri = vscode.Uri.file(
        getBehaviorProjectRootFsPath(document.uri, workspaceFolderUri)
    );
    const projectIndex = new ProjectIndex(projectRootUri);
    const resolveLiveSettings = createLiveSettingsResolver(workspaceFolderUri, document.uri);
    const [nodeDefs, settingDir, currentSettings] = await Promise.all([
        resolveNodeDefs(workspaceFolderUri, document.uri),
        getResolvedB3SettingDir(workspaceFolderUri, document.uri),
        resolveLiveSettings(),
    ]);

    const state: TreeEditorSessionState = {
        nodeDefs,
        settingDir,
        currentSettings,
        fileVersionIsNewer: false,
        newerFileVersion: null,
        cachedSubtreeRefs: null,
    };

    configureWebview(webviewPanel.webview, workspaceFolderUri);

    const postMessage = (message: HostToEditorMessage) => webviewPanel.webview.postMessage(message);
    const mapDefsForWebview = (defs: NodeDef[] = state.nodeDefs) =>
        mapNodeDefsIconsForWebview(
            webviewPanel.webview,
            workspaceFolderUri,
            state.settingDir,
            defs
        );

    const activeWebviewEntry: ActiveTreeEditorWebview = {
        workspaceFsPath: workspaceFolderUri.fsPath,
        documentUri: document.uri.toString(),
        postMessage,
    };
    addActiveWebview(activeWebviewEntry);
    let mainDocumentOperationQueue: Promise<unknown> = Promise.resolve();
    const createNodeCheckRuntime = async () => {
        const workspaceFile = findB3WorkspacePath(document.uri, workspaceFolderUri);
        if (!workspaceFile) {
            return {
                buildScriptRuntime: createBuildScriptRuntime(null, {
                    fs,
                    path: b3path,
                    workdir: workspaceFolderUri.fsPath,
                    nodeDefs: new Map(state.nodeDefs.map((def) => [def.name, def] as const)),
                    logger: createBuildScriptLogger(),
                }),
                treePath: workspaceFolderUri.fsPath,
            };
        }

        const workspaceText = await readWorkspaceFileContent(vscode.Uri.file(workspaceFile));
        const workspaceModel = parseWorkspaceModelContent(workspaceText);
        const buildScript = workspaceModel.settings.buildScript;
        const checkScripts = workspaceModel.settings.checkScripts ?? [];
        const workdir = path.dirname(workspaceFile).replace(/\\/g, "/");
        const env: BuildEnv = {
            fs,
            path: b3path,
            workdir,
            nodeDefs: new Map(state.nodeDefs.map((def) => [def.name, def] as const)),
            logger: createBuildScriptLogger(),
        };

        let buildScriptModule: unknown = null;
        let hasRuntimeLoadError = false;
        if (buildScript) {
            const scriptPath = path.join(workdir, buildScript);
            buildScriptModule = await loadRuntimeModule(scriptPath, { debug: false });
            hasRuntimeLoadError = !buildScriptModule;
        }

        const checkScriptModules: CheckScriptModule[] = [];
        const checkScriptPaths = resolveCheckScriptPaths(workdir, checkScripts);
        hasRuntimeLoadError = hasRuntimeLoadError || checkScriptPaths.missingPatterns.length > 0;
        for (const pattern of checkScriptPaths.missingPatterns) {
            env.logger.error(`checkScripts pattern matched no files: ${pattern}`);
        }
        for (const scriptPath of checkScriptPaths.paths) {
            const moduleExports = await loadRuntimeModule(scriptPath, { debug: false });
            if (!moduleExports) {
                env.logger.error(`'${scriptPath}' is not a valid check script`);
                hasRuntimeLoadError = true;
                continue;
            }
            checkScriptModules.push({ path: scriptPath, moduleExports });
        }

        const buildScriptRuntime = createBuildScriptRuntimeWithCheckModules(
            buildScriptModule,
            checkScriptModules,
            env
        );
        return {
            buildScriptRuntime: {
                ...buildScriptRuntime,
                hasError: buildScriptRuntime.hasError || hasRuntimeLoadError,
            },
            treePath: workdir,
        };
    };

    const handleValidateNodeChecksMessage = async (
        msg: Extract<EditorToHostMessage, { type: "validateNodeChecks" }>
    ) => {
        try {
            const runtimeResult = await createNodeCheckRuntime();
            const tree = JSON.parse(msg.content) as TreeData;
            const diagnostics = collectNodeArgCheckDiagnostics({
                tree,
                treePath: msg.treePath || runtimeResult.treePath,
                env: {
                    fs,
                    path: b3path,
                    workdir: runtimeResult.treePath,
                    nodeDefs: new Map(state.nodeDefs.map((def) => [def.name, def] as const)),
                    logger: createBuildScriptLogger(),
                },
                checkers: runtimeResult.buildScriptRuntime.nodeArgCheckers,
                targets: msg.nodes.map((entry) => ({
                    instanceKey: entry.instanceKey,
                    treePath: entry.treePath,
                    node: toNodeData(entry.node),
                })),
            });
            await postMessage({
                type: "validateNodeChecksResult",
                requestId: msg.requestId,
                diagnostics: diagnostics
                    .filter(
                        (
                            diagnostic
                        ): diagnostic is typeof diagnostic & { instanceKey: string } =>
                            typeof diagnostic.instanceKey === "string"
                    )
                    .map((diagnostic) => ({
                        instanceKey: diagnostic.instanceKey,
                        argName: diagnostic.argName,
                        checker: diagnostic.checker,
                        message: diagnostic.message,
                    })),
                error: runtimeResult.buildScriptRuntime.hasError
                    ? "checker runtime has errors"
                    : undefined,
            });
        } catch (error) {
            await postMessage({
                type: "validateNodeChecksResult",
                requestId: msg.requestId,
                diagnostics: [],
                error: String(error),
            });
        }
    };

    /**
     * Main-document writes, reloads, and revert/save flows all funnel through a
     * single queue so watcher callbacks and webview messages cannot race each
     * other and leave the in-memory document in an impossible state.
     */
    const enqueueMainDocumentOperation = <T>(operation: () => Promise<T> | T): Promise<T> => {
        const task = mainDocumentOperationQueue.then(operation, operation);
        mainDocumentOperationQueue = task.then(
            () => undefined,
            () => undefined
        );
        return task;
    };

    const refreshSettings = async ({
        refreshDefs = false,
    }: { refreshDefs?: boolean } = {}): Promise<void> => {
        if (refreshDefs) {
            const [freshDefs, freshSettingDir] = await Promise.all([
                resolveNodeDefs(workspaceFolderUri, document.uri),
                getResolvedB3SettingDir(workspaceFolderUri, document.uri),
            ]);
            state.nodeDefs = freshDefs;
            state.settingDir = freshSettingDir;
        }

        state.currentSettings = await resolveLiveSettings();
        await postMessage({
            type: "settingLoaded",
            nodeDefs: mapDefsForWebview(),
            settings: state.currentSettings,
        });
    };

    const invalidateSubtreeRefs = () => {
        state.cachedSubtreeRefs = null;
    };

    /** Cache the transitive subtree closure of the current main document. */
    const refreshTrackedSubtreeRefs = async () => {
        state.cachedSubtreeRefs = await projectIndex.getTransitiveSubtreeRelativePaths(
            document.content
        );
    };

    const updateFileVersionState = (content: string, opts?: { showWarning?: boolean }): void => {
        state.fileVersionIsNewer = false;
        state.newerFileVersion = null;

        const fileVersion = getTreeFileVersion(content);
        if (!fileVersion || !isDocumentVersionNewer(fileVersion)) {
            return;
        }

        state.fileVersionIsNewer = true;
        state.newerFileVersion = fileVersion;
        if (opts?.showWarning) {
            vscode.window.showWarningMessage(
                getNewerVersionMessage(state.currentSettings.language, fileVersion, "warn")
            );
        }
    };

    const isTrackedSubtreeDocument = (uri: vscode.Uri): boolean => {
        const rel = uriToWorkdirRelative(uri, projectRootUri);
        return !!rel && Boolean(state.cachedSubtreeRefs?.has(rel));
    };

    const flushParentSubtreeRefresh = () => {
        void postMessage({ type: "subtreeFileChanged" });
    };

    const isMainDocumentUri = (uri: vscode.Uri): boolean =>
        uri.toString() === document.uri.toString();

    const scheduleParentSubtreeRefresh = () => {
        state.subtreeRefreshTimer = clearRefreshTimer(state.subtreeRefreshTimer);
        state.subtreeRefreshTimer = setTimeout(() => {
            state.subtreeRefreshTimer = undefined;
            flushParentSubtreeRefresh();
        }, 450);
    };

    const scheduleTrackedSubtreeRefresh = (uri: vscode.Uri): void => {
        if (isMainDocumentUri(uri) || !isTrackedSubtreeDocument(uri)) {
            return;
        }
        scheduleParentSubtreeRefresh();
    };

    const flushTrackedSubtreeRefresh = (uri: vscode.Uri): void => {
        if (isMainDocumentUri(uri) || !isTrackedSubtreeDocument(uri)) {
            return;
        }
        state.subtreeRefreshTimer = clearRefreshTimer(state.subtreeRefreshTimer);
        flushParentSubtreeRefresh();
    };

    /**
     * Normalize webview JSON before it becomes the document source of truth.
     * This is the earliest point where we can refresh subtree tracking and
     * file-version state for subsequent watcher/save logic.
     */
    const applyContentFromWebview = (content: string): boolean => {
        const normalizedContent = normalizeTreeContentForWrite(content, document.uri.fsPath);
        if (document.content === normalizedContent) {
            return false;
        }

        const changed = document.updateContent(normalizedContent, { markDirty: true });
        if (!changed) {
            return false;
        }

        invalidateSubtreeRefs();
        void refreshTrackedSubtreeRefs();
        updateFileVersionState(normalizedContent);
        onDidChangeDocument(document);
        return true;
    };

    const getActiveNewerFileEditMessage = (): string | null => {
        updateFileVersionState(document.content);
        if (!state.fileVersionIsNewer) {
            return null;
        }

        const fileVersion = state.newerFileVersion ?? getTreeFileVersion(document.content) ?? "";
        return getNewerVersionMessage(state.currentSettings.language, fileVersion, "edit");
    };

    const blockEditingForNewerFile = (): string | null => {
        const message = getActiveNewerFileEditMessage();
        if (!message) {
            return null;
        }

        vscode.window.showErrorMessage(message);
        return message;
    };

    const getExistingNewerFileEditMessage = async (fileUri: vscode.Uri): Promise<string | null> => {
        let content: string;
        try {
            content = await readWorkspaceFileContent(fileUri);
        } catch {
            return null;
        }

        const fileVersion = getTreeFileVersion(content);
        if (!fileVersion || !isDocumentVersionNewer(fileVersion)) {
            return null;
        }

        const message = getNewerVersionMessage(state.currentSettings.language, fileVersion, "edit");
        return message;
    };

    /**
     * Handshake entry point: send immutable bootstrap state first, then follow
     * up with computed var/subtree metadata that depends on project indexing.
     */
    const handleReadyMessage = async (): Promise<void> => {
        const theme = getVSCodeTheme();
        const content = document.content;

        updateFileVersionState(content, { showWarning: true });

        const [allFiles, initUsingVars] = await Promise.all([
            projectIndex.getAllFiles(),
            parseUsingVarsFromContent(projectIndex, content),
            refreshTrackedSubtreeRefs(),
        ]);

        await postMessage({
            type: "init",
            content,
            filePath: document.uri.fsPath,
            workdir: projectRootUri.fsPath,
            nodeDefs: mapDefsForWebview(),
            checkExpr: state.currentSettings.checkExpr,
            subtreeEditable: state.currentSettings.subtreeEditable,
            language: state.currentSettings.language,
            theme,
            allFiles,
            nodeColors: state.currentSettings.nodeColors,
        });

        if (initUsingVars) {
            await postVarDeclLoaded(postMessage, initUsingVars);
        }
    };

    /**
     * Save requests reuse the serialized main-document queue so an external file
     * change cannot interleave between "apply webview content" and "persist to disk".
     */
    const handleSaveDocumentMessage = async (
        msg: Extract<EditorToHostMessage, { type: "saveDocument" }>
    ): Promise<void> => {
        await enqueueMainDocumentOperation(async () => {
            const editBlockedMessage = blockEditingForNewerFile();
            if (editBlockedMessage) {
                await postMessage({
                    type: "saveDocumentResult",
                    requestId: msg.requestId,
                    success: false,
                    error: editBlockedMessage,
                } satisfies HostToEditorMessage);
                return;
            }

            try {
                const changed = applyContentFromWebview(msg.content);
                let savedContent: string | null = null;
                if (changed || document.isDirty) {
                    savedContent = await persistMainDocumentToDisk(document, {
                        notifyReload: false,
                    });
                }
                const success = !document.isDirty;
                if (!success) {
                    getBehavior3OutputChannel().warn(
                        `[saveDocument] save failed for ${document.uri.fsPath}; isDirty=${document.isDirty}`
                    );
                }
                await postMessage({
                    type: "saveDocumentResult",
                    requestId: msg.requestId,
                    success,
                    error: success ? undefined : "Failed to save document",
                } satisfies HostToEditorMessage);

                if (success && savedContent !== null) {
                    await postMessage({
                        type: "documentReloaded",
                        content: savedContent,
                    } satisfies HostToEditorMessage);
                }
            } catch (error) {
                getBehavior3OutputChannel().error(
                    `[saveDocument] exception for ${document.uri.fsPath}: ${String(error)}`
                );
                await postMessage({
                    type: "saveDocumentResult",
                    requestId: msg.requestId,
                    success: false,
                    error: String(error),
                } satisfies HostToEditorMessage);
            }
        });
    };

    const handleRevertDocumentMessage = async (
        msg: Extract<EditorToHostMessage, { type: "revertDocument" }>
    ): Promise<void> => {
        await enqueueMainDocumentOperation(async () => {
            const cancellation = new vscode.CancellationTokenSource();
            try {
                await revertDocument(document, cancellation.token);
                await postMessage({
                    type: "revertDocumentResult",
                    requestId: msg.requestId,
                    success: true,
                } satisfies HostToEditorMessage);
            } catch (error) {
                await postMessage({
                    type: "revertDocumentResult",
                    requestId: msg.requestId,
                    success: false,
                    error: String(error),
                } satisfies HostToEditorMessage);
            } finally {
                cancellation.dispose();
            }
        });
    };

    const handleMainDocumentFileChange = async (): Promise<void> => {
        await enqueueMainDocumentOperation(async () => {
            let content: string;
            try {
                content = await readFileContentFromDisk(document.uri);
            } catch {
                return;
            }

            invalidateSubtreeRefs();

            if (document.consumeOwnWrite(content)) {
                return;
            }

            if (document.content === content) {
                return;
            }

            /**
             * Clean external reloads apply silently when the webview has no
             * unsaved edits; otherwise we surface a conflict payload and let the
             * webview decide when/how to merge or reload.
             */
            if (!document.isDirty) {
                document.updateContent(content, { markSaved: true, markDirty: false });
                void refreshTrackedSubtreeRefs();
                updateFileVersionState(content, { showWarning: true });
                await postMessage({
                    type: "documentReloaded",
                    content,
                } satisfies HostToEditorMessage);
                return;
            }

            await postMessage({
                type: "fileChanged",
                content,
            } satisfies HostToEditorMessage);
        });
    };

    const handleTreeSelectedMessage = async (
        msg: Extract<EditorToHostMessage, { type: "treeSelected" }>
    ): Promise<void> => {
        const content = stringifyJson(msg.tree, { indent: 2 });
        const [allFiles, result] = await Promise.all([
            projectIndex.getAllFiles(),
            parseUsingVarsFromContent(projectIndex, content),
        ]);

        if (result) {
            await postVarDeclLoaded(postMessage, result, allFiles);
        }
    };

    const handleReadFileMessage = async (
        msg: Extract<EditorToHostMessage, { type: "readFile" }>
    ): Promise<void> => {
        const fileUri = resolvePathInWorkdir(msg.path, projectRootUri);
        if (!fileUri) {
            await postMessage({
                type: "readFileResult",
                requestId: msg.requestId,
                content: null,
            });
            getBehavior3OutputChannel().warn("readFile rejected: path outside workdir", msg.path);
            return;
        }

        try {
            const content = await readWorkspaceFileContent(fileUri);
            if (msg.openIfSubtree) {
                try {
                    await vscode.commands.executeCommand(
                        "vscode.openWith",
                        fileUri,
                        viewType,
                        vscode.ViewColumn.Active
                    );
                } catch {
                    /* ignore open failure */
                }
            }

            await postMessage({
                type: "readFileResult",
                requestId: msg.requestId,
                content,
            });
        } catch {
            await postMessage({
                type: "readFileResult",
                requestId: msg.requestId,
                content: null,
            });
            getBehavior3OutputChannel().warn("readFile failed", msg.path);
        }
    };

    const handleSaveSubtreeMessage = async (
        msg: Extract<EditorToHostMessage, { type: "saveSubtree" }>
    ): Promise<void> => {
        const fileUri = resolvePathInWorkdir(msg.path, projectRootUri, {
            mustBeJson: true,
        });
        if (!fileUri) {
            const error = "Save path must be a .json file inside the behavior tree work directory.";
            await postMessage({
                type: "saveSubtreeResult",
                requestId: msg.requestId,
                success: false,
                error,
            });
            getBehavior3OutputChannel().warn("saveSubtree rejected", msg.path);
            return;
        }

        try {
            const activeFileBlockMessage = getActiveNewerFileEditMessage();
            if (activeFileBlockMessage) {
                await postMessage({
                    type: "saveSubtreeResult",
                    requestId: msg.requestId,
                    success: false,
                    error: activeFileBlockMessage,
                });
                getBehavior3OutputChannel().warn(
                    `saveSubtree blocked: active file was created by a newer Behavior3 version`
                );
                return;
            }

            const targetFileBlockMessage = await getExistingNewerFileEditMessage(fileUri);
            if (targetFileBlockMessage) {
                await postMessage({
                    type: "saveSubtreeResult",
                    requestId: msg.requestId,
                    success: false,
                    error: targetFileBlockMessage,
                });
                getBehavior3OutputChannel().warn(
                    `saveSubtree blocked: ${fileUri.fsPath} was created by a newer Behavior3 version`
                );
                return;
            }

            await writeDocumentContentToDisk(fileUri, msg.content);
            await postMessage({
                type: "saveSubtreeResult",
                requestId: msg.requestId,
                success: true,
            });
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to save subtree: ${error}`);
            await postMessage({
                type: "saveSubtreeResult",
                requestId: msg.requestId,
                success: false,
                error: String(error),
            });
        }
    };

    const handleSaveSubtreeAsMessage = async (
        msg: Extract<EditorToHostMessage, { type: "saveSubtreeAs" }>
    ): Promise<void> => {
        try {
            const activeFileBlockMessage = getActiveNewerFileEditMessage();
            if (activeFileBlockMessage) {
                vscode.window.showErrorMessage(activeFileBlockMessage);
                await postMessage({
                    type: "saveSubtreeAsResult",
                    requestId: msg.requestId,
                    savedPath: null,
                    error: activeFileBlockMessage,
                });
                return;
            }

            const defaultUri = vscode.Uri.joinPath(projectRootUri, `${msg.suggestedBaseName}.json`);
            const picked = await vscode.window.showSaveDialog({
                defaultUri,
                filters: { JSON: ["json"] },
            });
            if (!picked) {
                await postMessage({
                    type: "saveSubtreeAsResult",
                    requestId: msg.requestId,
                    savedPath: null,
                });
                return;
            }

            const rel = uriToWorkdirRelative(picked, projectRootUri);
            if (!rel) {
                const error = "Save location must be inside the behavior tree work directory.";
                vscode.window.showErrorMessage(error);
                await postMessage({
                    type: "saveSubtreeAsResult",
                    requestId: msg.requestId,
                    savedPath: null,
                    error,
                });
                return;
            }

            const targetFileBlockMessage = await getExistingNewerFileEditMessage(picked);
            if (targetFileBlockMessage) {
                vscode.window.showErrorMessage(targetFileBlockMessage);
                await postMessage({
                    type: "saveSubtreeAsResult",
                    requestId: msg.requestId,
                    savedPath: null,
                    error: targetFileBlockMessage,
                });
                return;
            }

            await writeDocumentContentToDisk(picked, msg.content);
            await postMessage({
                type: "saveSubtreeAsResult",
                requestId: msg.requestId,
                savedPath: rel,
            });
        } catch (error) {
            const message = String(error);
            vscode.window.showErrorMessage(`Failed to save subtree: ${message}`);
            await postMessage({
                type: "saveSubtreeAsResult",
                requestId: msg.requestId,
                savedPath: null,
                error: message,
            });
        }
    };

    const handleWebviewLogMessage = (
        msg: Extract<EditorToHostMessage, { type: "webviewLog" }>
    ): void => {
        const out = getBehavior3OutputChannel();
        switch (msg.level) {
            case "debug":
                out.debug(msg.message);
                break;
            case "warn":
                out.warn(msg.message);
                break;
            case "error":
                out.error(msg.message);
                break;
            case "log":
            case "info":
            default:
                out.info(msg.message);
                break;
        }
    };

    const mainDocumentWatcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(
            path.dirname(document.uri.fsPath),
            path.basename(document.uri.fsPath)
        )
    );
    const subtreeFileWatcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(projectRootUri.fsPath, "**/*.json")
    );

    /**
     * Watchers keep the project index warm and notify the current editor only
     * when affected files belong to the active document's transitive subtree set.
     */
    const sessionDisposables: vscode.Disposable[] = [
        watchSettingFile(workspaceFolderUri, () => {
            void refreshSettings({ refreshDefs: true }).catch(
                logAsyncRuntimeError("watch setting")
            );
        }),
        watchWorkspaceFile(workspaceFolderUri, () => {
            void refreshSettings().catch(logAsyncRuntimeError("watch workspace"));
        }),
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (!event.affectsConfiguration("behavior3")) {
                return;
            }
            void refreshSettings().catch(logAsyncRuntimeError("configuration changed"));
        }),
        mainDocumentWatcher,
        subtreeFileWatcher,
        vscode.workspace.onDidChangeTextDocument((event) => {
            projectIndex.invalidateFile(event.document.uri);
            if (event.contentChanges.length > 0) {
                scheduleTrackedSubtreeRefresh(event.document.uri);
            }
        }),
        vscode.workspace.onDidSaveTextDocument((savedDocument) => {
            projectIndex.invalidateFile(savedDocument.uri);
            flushTrackedSubtreeRefresh(savedDocument.uri);
        }),
        vscode.window.onDidChangeActiveColorTheme(() => {
            void postMessage({
                type: "themeChanged",
                theme: getVSCodeTheme(),
            }).then(undefined, logAsyncRuntimeError("theme changed"));
        }),
    ];

    sessionDisposables.push(
        /**
         * Webview messages are intentionally thin here: route, serialize when
         * needed, and keep protocol branching close to the session lifecycle.
         */
        webviewPanel.webview.onDidReceiveMessage(async (msg: EditorToHostMessage) => {
            try {
                switch (msg.type) {
                    case "ready":
                        await handleReadyMessage();
                        break;

                    case "update":
                        await enqueueMainDocumentOperation(async () => {
                            if (blockEditingForNewerFile()) {
                                return;
                            }
                            applyContentFromWebview(msg.content);
                        });
                        break;

                    case "saveDocument":
                        await handleSaveDocumentMessage(msg);
                        break;

                    case "revertDocument":
                        await handleRevertDocumentMessage(msg);
                        break;

                    case "treeSelected":
                        await handleTreeSelectedMessage(msg);
                        break;

                    case "requestSetting":
                        await refreshSettings({ refreshDefs: true });
                        break;

                    case "build":
                        void vscode.commands
                            .executeCommand("behavior3.build", {
                                buildScriptDebug: msg.buildScriptDebug,
                            })
                            .then(undefined, logAsyncRuntimeError("command:behavior3.build"));
                        break;

                    case "validateNodeChecks":
                        await handleValidateNodeChecksMessage(msg);
                        break;

                    case "webviewLog":
                        handleWebviewLogMessage(msg);
                        break;

                    case "readFile":
                        await handleReadFileMessage(msg);
                        break;

                    case "saveSubtree":
                        await handleSaveSubtreeMessage(msg);
                        break;

                    case "saveSubtreeAs":
                        await handleSaveSubtreeAsMessage(msg);
                        break;
                }
            } catch (error) {
                logRuntimeError(`webview message:${msg.type}`, error);
            }
        })
    );

    sessionDisposables.push(
        mainDocumentWatcher.onDidChange(() => {
            projectIndex.invalidateFile(document.uri);
            void handleMainDocumentFileChange();
        }),
        mainDocumentWatcher.onDidCreate(() => {
            projectIndex.invalidateFile(document.uri);
            void handleMainDocumentFileChange();
        }),
        subtreeFileWatcher.onDidChange((uri) => {
            projectIndex.invalidateFile(uri);
            scheduleTrackedSubtreeRefresh(uri);
        }),
        subtreeFileWatcher.onDidCreate((uri) => {
            projectIndex.invalidateFile(uri);
            scheduleTrackedSubtreeRefresh(uri);
        }),
        subtreeFileWatcher.onDidDelete((uri) => {
            projectIndex.invalidateFile(uri);
            scheduleTrackedSubtreeRefresh(uri);
        })
    );

    webviewPanel.onDidDispose(() => {
        state.subtreeRefreshTimer = clearRefreshTimer(state.subtreeRefreshTimer);
        projectIndex.clear();
        removeActiveWebview(activeWebviewEntry);
        disposeAll(sessionDisposables);
    });
}
