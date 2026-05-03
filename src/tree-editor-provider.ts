import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import {
    normalizeTreeContentForWrite,
    readFileContentFromDisk,
    TreeEditorDocument,
} from "./editor-session/document-sync";
import { getBehavior3OutputChannel } from "./output-channel";
import { mapNodeDefsIconsForWebview } from "./node-def-icons";
import { ProjectIndex, type VarDeclResult } from "./editor-session/project-index";
import {
    getBehaviorProjectRootFsPath,
    getResolvedB3SettingDir,
    resolveNodeDefs,
    resolveWorkspaceNodeColors,
    watchSettingFile,
    watchWorkspaceFile,
} from "./setting-resolver";
import type { EditorToHostMessage, HostToEditorMessage, NodeDef } from "./types";
import { isDocumentVersionNewer } from "../webview/shared/document-version";
import { normalizeWorkdirRelativePath } from "../webview/shared/protocol";
import { stringifyJson } from "../webview/shared/misc/stringify";
import { writeTree } from "../webview/shared/misc/util";

/**
 * Read the Vite-generated HTML for the active webview entry and rewrite all
 * asset references to proper vscode-webview-resource URIs.
 */
function buildWebviewHtml(
    webview: vscode.Webview,
    extensionUri: vscode.Uri,
    title?: string
): string {
    const htmlPath = vscode.Uri.joinPath(extensionUri, "dist", "webview", "index.html");
    let html = fs.readFileSync(htmlPath.fsPath, "utf-8");

    const webviewRootUri = webview.asWebviewUri(
        vscode.Uri.joinPath(extensionUri, "dist", "webview")
    );

    const assetsUri = `${webviewRootUri}/assets`;
    html = html.replace(/(?:\.\.\/|\.\/)assets\//g, `${assetsUri}/`);

    if (title) {
        html = html.replace(/<title>.*?<\/title>/, `<title>${title}</title>`);
    }

    const baseTag = `<base href="${webviewRootUri}/">`;

    const src = webview.cspSource;
    const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${src} data: blob:; style-src ${src} 'unsafe-inline'; script-src ${src} 'unsafe-inline'; font-src ${src} data:; worker-src blob:; connect-src ${src};">`;
    html = html.replace("<head>", `<head>\n  ${baseTag}\n  ${csp}`);

    return html;
}

function isFileVersionNewer(fileVersion: string): boolean {
    return isDocumentVersionNewer(fileVersion);
}

function getWorkdir(documentUri: vscode.Uri): vscode.Uri {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(documentUri);
    if (workspaceFolder) {
        return workspaceFolder.uri;
    }
    return vscode.Uri.file(path.dirname(documentUri.fsPath));
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

function configureEditorWebview(
    webview: vscode.Webview,
    extensionUri: vscode.Uri,
    workspaceFolderUri: vscode.Uri
): void {
    webview.options = {
        enableScripts: true,
        localResourceRoots: [
            vscode.Uri.joinPath(extensionUri, "dist", "webview"),
            vscode.Uri.joinPath(extensionUri, "public"),
            workspaceFolderUri,
        ],
    };
    webview.html = buildWebviewHtml(webview, extensionUri, "Behavior3 Editor");
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

export class TreeEditorProvider implements vscode.CustomEditorProvider<TreeEditorDocument> {
    public static readonly viewType = "behavior3.treeEditor";
    private static readonly activeWebviews = new Set<{
        workspaceFsPath: string;
        documentUri: string;
        postMessage: (message: HostToEditorMessage) => Thenable<boolean>;
    }>();
    private readonly _onDidChangeCustomDocument = new vscode.EventEmitter<
        vscode.CustomDocumentContentChangeEvent<TreeEditorDocument>
    >();
    public readonly onDidChangeCustomDocument = this._onDidChangeCustomDocument.event;

    public static postMessageToWorkspace(
        workspaceFsPath: string,
        message: HostToEditorMessage
    ): boolean {
        let delivered = false;
        for (const entry of TreeEditorProvider.activeWebviews) {
            if (entry.workspaceFsPath !== workspaceFsPath) {
                continue;
            }
            delivered = true;
            void entry.postMessage(message);
        }
        return delivered;
    }

    public static postMessageToDocument(
        documentUri: string,
        message: HostToEditorMessage
    ): boolean {
        let delivered = false;
        for (const entry of TreeEditorProvider.activeWebviews) {
            if (entry.documentUri !== documentUri) {
                continue;
            }
            delivered = true;
            void entry.postMessage(message);
        }
        return delivered;
    }

    constructor(private readonly _extensionUri: vscode.Uri) {}

    private async writeDocumentContentToDisk(targetUri: vscode.Uri, content: string): Promise<string> {
        const normalizedContent = normalizeTreeContentForWrite(content, targetUri.fsPath);
        await vscode.workspace.fs.writeFile(
            targetUri,
            Buffer.from(normalizedContent, "utf-8")
        );
        return normalizedContent;
    }

    private async persistMainDocumentToDisk(
        document: TreeEditorDocument,
        opts?: { notifyReload?: boolean }
    ): Promise<string> {
        const normalizedContent = await this.writeDocumentContentToDisk(document.uri, document.content);
        document.markSaved(normalizedContent);
        document.rememberOwnWrite(normalizedContent);

        if (opts?.notifyReload !== false) {
            TreeEditorProvider.postMessageToDocument(document.uri.toString(), {
                type: "documentReloaded",
                content: normalizedContent,
            });
        }

        return normalizedContent;
    }

    async openCustomDocument(
        uri: vscode.Uri,
        openContext: vscode.CustomDocumentOpenContext,
        _token: vscode.CancellationToken
    ): Promise<TreeEditorDocument> {
        let content = "";
        let dirty = false;

        if (openContext.backupId) {
            content = await readFileContentFromDisk(vscode.Uri.file(openContext.backupId));
            dirty = true;
        } else if (openContext.untitledDocumentData) {
            content = Buffer.from(openContext.untitledDocumentData).toString("utf-8");
            dirty = openContext.untitledDocumentData.length > 0;
        } else {
            content = await readFileContentFromDisk(uri);
        }

        return new TreeEditorDocument(uri, content, { dirty });
    }

    async saveCustomDocument(
        document: TreeEditorDocument,
        _cancellation: vscode.CancellationToken
    ): Promise<void> {
        await this.persistMainDocumentToDisk(document);
    }

    async saveCustomDocumentAs(
        document: TreeEditorDocument,
        destination: vscode.Uri,
        _cancellation: vscode.CancellationToken
    ): Promise<void> {
        await this.writeDocumentContentToDisk(destination, document.content);
    }

    async revertCustomDocument(
        document: TreeEditorDocument,
        _cancellation: vscode.CancellationToken
    ): Promise<void> {
        const content = await readFileContentFromDisk(document.uri);
        document.clearOwnWrites();
        document.updateContent(content, { markSaved: true, markDirty: false });
        TreeEditorProvider.postMessageToDocument(document.uri.toString(), {
            type: "documentReloaded",
            content,
        });
    }

    async backupCustomDocument(
        document: TreeEditorDocument,
        context: vscode.CustomDocumentBackupContext,
        _cancellation: vscode.CancellationToken
    ): Promise<vscode.CustomDocumentBackup> {
        await vscode.workspace.fs.writeFile(
            context.destination,
            Buffer.from(document.content, "utf-8")
        );

        return {
            id: context.destination.fsPath,
            delete: async () => {
                try {
                    await vscode.workspace.fs.delete(context.destination);
                } catch {
                    /* ignore backup cleanup failures */
                }
            },
        };
    }

    async resolveCustomEditor(
        document: TreeEditorDocument,
        webviewPanel: vscode.WebviewPanel,
        _token: vscode.CancellationToken
    ): Promise<void> {
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

        configureEditorWebview(webviewPanel.webview, this._extensionUri, workspaceFolderUri);

        const postMessage = (message: HostToEditorMessage) =>
            webviewPanel.webview.postMessage(message);
        const mapDefsForWebview = (defs: NodeDef[] = state.nodeDefs) =>
            mapNodeDefsIconsForWebview(
                webviewPanel.webview,
                workspaceFolderUri,
                state.settingDir,
                defs
            );

        const activeWebviewEntry = {
            workspaceFsPath: workspaceFolderUri.fsPath,
            documentUri: document.uri.toString(),
            postMessage,
        };
        TreeEditorProvider.activeWebviews.add(activeWebviewEntry);
        let mainDocumentOperationQueue: Promise<unknown> = Promise.resolve();

        const enqueueMainDocumentOperation = <T>(
            operation: () => Promise<T> | T
        ): Promise<T> => {
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

        const refreshTrackedSubtreeRefs = async () => {
            state.cachedSubtreeRefs = await projectIndex.getTransitiveSubtreeRelativePaths(
                document.content
            );
        };

        const updateFileVersionState = (
            content: string,
            opts?: { showWarning?: boolean }
        ): void => {
            state.fileVersionIsNewer = false;
            state.newerFileVersion = null;

            const fileVersion = getTreeFileVersion(content);
            if (!fileVersion || !isFileVersionNewer(fileVersion)) {
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
            this._onDidChangeCustomDocument.fire({ document });
            return true;
        };

        const blockEditingForNewerFile = (): string | null => {
            if (!state.fileVersionIsNewer) {
                return null;
            }

            const fileVersion = state.newerFileVersion ?? getTreeFileVersion(document.content) ?? "";
            const message = getNewerVersionMessage(
                state.currentSettings.language,
                fileVersion,
                "edit"
            );
            vscode.window.showErrorMessage(message);
            return message;
        };

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
                        savedContent = await this.persistMainDocumentToDisk(document, {
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
                    await this.revertCustomDocument(document, cancellation.token);
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
                getBehavior3OutputChannel().warn(
                    "readFile rejected: path outside workdir",
                    msg.path
                );
                return;
            }

            try {
                const content = await readWorkspaceFileContent(fileUri);
                if (msg.openIfSubtree) {
                    try {
                        await vscode.commands.executeCommand(
                            "vscode.openWith",
                            fileUri,
                            TreeEditorProvider.viewType,
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
                const error =
                    "Save path must be a .json file inside the behavior tree work directory.";
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
                await this.writeDocumentContentToDisk(fileUri, msg.content);
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
                const defaultUri = vscode.Uri.joinPath(
                    projectRootUri,
                    `${msg.suggestedBaseName}.json`
                );
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

                await this.writeDocumentContentToDisk(picked, msg.content);
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

        const sessionDisposables: vscode.Disposable[] = [
            watchSettingFile(workspaceFolderUri, () => {
                void refreshSettings({ refreshDefs: true });
            }),
            watchWorkspaceFile(workspaceFolderUri, () => {
                void refreshSettings();
            }),
            vscode.workspace.onDidChangeConfiguration((event) => {
                if (!event.affectsConfiguration("behavior3")) {
                    return;
                }
                void refreshSettings();
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
                });
            }),
        ];

        sessionDisposables.push(
            webviewPanel.webview.onDidReceiveMessage(async (msg: EditorToHostMessage) => {
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
                        void vscode.commands.executeCommand("behavior3.build");
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
            TreeEditorProvider.activeWebviews.delete(activeWebviewEntry);
            disposeAll(sessionDisposables);
        });
    }
}

function uriToWorkdirRelative(uri: vscode.Uri, workdir: vscode.Uri): string | undefined {
    if (uri.scheme !== "file") return undefined;
    const rel = path.relative(workdir.fsPath, uri.fsPath).replace(/\\/g, "/");
    if (rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
    return normalizeWorkdirRelativePath(rel);
}

function resolvePathInWorkdir(
    inputPath: string,
    workdir: vscode.Uri,
    options?: { mustBeJson?: boolean }
): vscode.Uri | undefined {
    if (!inputPath || typeof inputPath !== "string") {
        return undefined;
    }
    const normalized = path.normalize(inputPath);
    const candidate = path.isAbsolute(normalized)
        ? normalized
        : path.join(workdir.fsPath, normalized);
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
