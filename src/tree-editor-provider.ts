import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { getBehavior3OutputChannel } from "./output-channel";
import { mapNodeDefsIconsForWebview } from "./node-def-icons";
import {
    getBehaviorProjectRootFsPath,
    getResolvedB3SettingDir,
    resolveNodeDefs,
    resolveWorkspaceNodeColors,
    watchSettingFile,
    watchWorkspaceFile,
} from "./setting-resolver";
import type { EditorToHostMessage, HostToEditorMessage, NodeDef } from "./types";
import { VERSION } from "../webview/shared/misc/b3type";
import { stringifyJson } from "../webview/shared/misc/stringify";
import { basenameWithoutExt, readTree, writeTree } from "../webview/shared/misc/util";

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
    const fParts = fileVersion.split(".").map(Number);
    const eParts = VERSION.split(".").map(Number);
    for (let i = 0; i < 3; i++) {
        const f = fParts[i] ?? 0;
        const e = eParts[i] ?? 0;
        if (f > e) return true;
        if (f < e) return false;
    }
    return false;
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

interface SuppressedDocumentChange {
    raw: string;
    normalizedLineEndings: string;
    canonicalJson: string | null;
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
    workdir: vscode.Uri,
    content: string
): Promise<VarDeclResult | undefined> {
    try {
        const treeJson = JSON.parse(content) as TreeLike;
        return (await buildUsingVars(workdir, treeJson)) ?? undefined;
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

async function readFileContentFromDisk(fileUri: vscode.Uri): Promise<string> {
    const raw = await vscode.workspace.fs.readFile(fileUri);
    return Buffer.from(raw).toString("utf-8");
}

function clearRefreshTimer(timer: ReturnType<typeof setTimeout> | undefined): undefined {
    if (timer) {
        clearTimeout(timer);
    }
    return undefined;
}

function normalizeLineEndings(content: string): string {
    return content.replace(/\r\n/g, "\n");
}

function normalizeJsonContent(content: string): string | null {
    try {
        return stringifyJson(JSON.parse(content), { indent: 2 });
    } catch {
        return null;
    }
}

function normalizeJsonContentForWrite(content: string): string {
    return normalizeJsonContent(content) ?? content;
}

function normalizeTreeContentForWrite(content: string, filePath: string): string {
    try {
        const tree = readTree(content);
        const name = basenameWithoutExt(filePath);
        tree.name = name;
        return writeTree(tree, name);
    } catch {
        return normalizeJsonContentForWrite(content);
    }
}

function buildSuppressedDocumentChange(content: string): SuppressedDocumentChange {
    return {
        raw: content,
        normalizedLineEndings: normalizeLineEndings(content),
        canonicalJson: normalizeJsonContent(content),
    };
}

function suppressedDocumentChangesMatch(
    left: SuppressedDocumentChange,
    right: SuppressedDocumentChange
): boolean {
    if (left.raw === right.raw) {
        return true;
    }

    if (left.normalizedLineEndings === right.normalizedLineEndings) {
        return true;
    }

    return (
        left.canonicalJson !== null &&
        right.canonicalJson !== null &&
        left.canonicalJson === right.canonicalJson
    );
}

class TreeEditorDocument implements vscode.CustomDocument {
    private _content: string;
    private _isDirty: boolean;
    private _ownFileWrites: SuppressedDocumentChange[] = [];

    constructor(
        public readonly uri: vscode.Uri,
        content: string,
        opts?: { dirty?: boolean }
    ) {
        this._content = content;
        this._isDirty = opts?.dirty ?? false;
    }

    get content(): string {
        return this._content;
    }

    get isDirty(): boolean {
        return this._isDirty;
    }

    updateContent(
        content: string,
        opts?: {
            markDirty?: boolean;
            markSaved?: boolean;
        }
    ): boolean {
        const changed = this._content !== content;
        this._content = content;

        if (opts?.markSaved) {
            this._isDirty = false;
        } else if (opts?.markDirty !== false && changed) {
            this._isDirty = true;
        }

        return changed;
    }

    markSaved(content = this._content): void {
        this._content = content;
        this._isDirty = false;
    }

    rememberOwnWrite(content: string): void {
        this._ownFileWrites.push(buildSuppressedDocumentChange(content));
    }

    consumeOwnWrite(content: string): boolean {
        const actualChange = buildSuppressedDocumentChange(content);
        const index = this._ownFileWrites.findIndex((change) =>
            suppressedDocumentChangesMatch(change, actualChange)
        );
        if (index < 0) {
            return false;
        }
        this._ownFileWrites.splice(index, 1);
        return true;
    }

    clearOwnWrites(): void {
        this._ownFileWrites = [];
    }

    dispose(): void {
        this.clearOwnWrites();
    }
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

        const getTrackedSubtreeRefs = (): Set<string> => {
            if (!state.cachedSubtreeRefs) {
                state.cachedSubtreeRefs = getTransitiveSubtreeRelativePaths(
                    projectRootUri.fsPath,
                    document.content
                );
            }
            return state.cachedSubtreeRefs;
        };

        const isTrackedSubtreeDocument = (uri: vscode.Uri): boolean => {
            const rel = uriToWorkdirRelative(uri, projectRootUri);
            return !!rel && getTrackedSubtreeRefs().has(rel);
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
                collectAllFiles(projectRootUri),
                parseUsingVarsFromContent(projectRootUri, content),
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
            const [allFiles, result] = await Promise.all([
                collectAllFiles(projectRootUri),
                buildUsingVars(projectRootUri, msg.tree as TreeLike | null),
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
                if (msg.requestId === "open-subtree") {
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
                if (event.contentChanges.length > 0) {
                    scheduleTrackedSubtreeRefresh(event.document.uri);
                }
            }),
            vscode.workspace.onDidSaveTextDocument((savedDocument) => {
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
                void handleMainDocumentFileChange();
            }),
            mainDocumentWatcher.onDidCreate(() => {
                void handleMainDocumentFileChange();
            }),
            subtreeFileWatcher.onDidChange((uri) => {
                scheduleTrackedSubtreeRefresh(uri);
            }),
            subtreeFileWatcher.onDidCreate((uri) => {
                scheduleTrackedSubtreeRefresh(uri);
            }),
            subtreeFileWatcher.onDidDelete((uri) => {
                scheduleTrackedSubtreeRefresh(uri);
            })
        );

        webviewPanel.onDidDispose(() => {
            state.subtreeRefreshTimer = clearRefreshTimer(state.subtreeRefreshTimer);
            TreeEditorProvider.activeWebviews.delete(activeWebviewEntry);
            disposeAll(sessionDisposables);
        });
    }
}

interface TreeLike {
    vars?: Array<{ name: string; desc?: string }>;
    import?: string[] | Array<{ path: string; vars?: Array<{ name: string; desc?: string }> }>;
    root?: TreeNodeLike;
}

interface TreeNodeLike {
    path?: string;
    children?: TreeNodeLike[];
}

interface TreeFileLike {
    vars?: Array<{ name: string; desc?: string }>;
    import?: string[];
    root?: TreeNodeLike;
}

/**
 * Collect all behavior tree .json files under the workspace directory.
 */
async function collectAllFiles(workdir: vscode.Uri): Promise<string[]> {
    const allFiles: string[] = [];
    try {
        const uris = await vscode.workspace.findFiles(
            new vscode.RelativePattern(workdir, "**/*.json"),
            "**/node_modules/**"
        );
        for (const uri of uris) {
            allFiles.push(path.relative(workdir.fsPath, uri.fsPath).replace(/\\/g, "/"));
        }
        allFiles.sort();
    } catch {
        // workspace may not be open
    }
    return allFiles;
}

function collectSubtreePaths(node: TreeNodeLike | undefined): string[] {
    if (!node) return [];
    const paths: string[] = [];
    const stack: TreeNodeLike[] = [node];
    while (stack.length) {
        const cur = stack.pop()!;
        if (cur.path) paths.push(cur.path);
        cur.children?.forEach((c) => stack.push(c));
    }
    return paths;
}

function normalizePathKey(p: string): string {
    return p.replace(/\\/g, "/").replace(/^[/\\]+/, "");
}

function readTreeFileCached(
    workdirFs: string,
    relativePath: string,
    cache: Map<string, TreeFileLike | null>
): TreeFileLike | null {
    const rel = normalizePathKey(relativePath);
    if (cache.has(rel)) {
        return cache.get(rel) ?? null;
    }
    try {
        const raw = fs.readFileSync(path.join(workdirFs, rel), "utf-8");
        const fileTree = JSON.parse(raw) as TreeFileLike;
        cache.set(rel, fileTree);
        return fileTree;
    } catch {
        cache.set(rel, null);
        return null;
    }
}

/** Top-level `vars` in one tree JSON file (for Inspector rows; no recursion). */
function getLocalVarsFromTreeFile(
    workdirFs: string,
    relativePath: string,
    cache: Map<string, TreeFileLike | null>
): Array<{ name: string; desc: string }> {
    const fileTree = readTreeFileCached(workdirFs, relativePath, cache);
    if (!fileTree) {
        return [];
    }
    return (fileTree.vars ?? [])
        .filter((v) => v.name)
        .map((v) => ({ name: v.name, desc: v.desc ?? "" }));
}

/**
 * All `import` JSON paths reachable from the main tree's import list (BFS), for Inspector "导入变量".
 */
function collectOrderedTransitiveImportPaths(
    workdirFs: string,
    seedImports: string[],
    cache: Map<string, TreeFileLike | null>
): string[] {
    const ordered: string[] = [];
    const seen = new Set<string>();
    const queue: string[] = [];
    for (const s of seedImports) {
        const n = normalizePathKey(s);
        if (!seen.has(n)) {
            seen.add(n);
            queue.push(n);
        }
    }
    while (queue.length) {
        const rel = queue.shift()!;
        ordered.push(rel);
        const fileTree = readTreeFileCached(workdirFs, rel, cache);
        if (!fileTree) {
            continue;
        }
        for (const imp of fileTree.import ?? []) {
            if (typeof imp === "string") {
                const n = normalizePathKey(imp);
                if (!seen.has(n)) {
                    seen.add(n);
                    queue.push(n);
                }
            }
        }
    }
    return ordered;
}

/**
 * All subtree JSON paths reachable from `root` (BFS), for Inspector "子树变量" (matches desktop transitive view).
 */
function collectOrderedTransitiveSubtreePaths(
    workdirFs: string,
    root: TreeNodeLike | undefined,
    cache: Map<string, TreeFileLike | null>
): string[] {
    const ordered: string[] = [];
    const seen = new Set<string>();
    const queue: string[] = [];
    for (const p of collectSubtreePaths(root)) {
        const n = normalizePathKey(p);
        if (!seen.has(n)) {
            seen.add(n);
            queue.push(n);
        }
    }
    while (queue.length) {
        const rel = queue.shift()!;
        ordered.push(rel);
        const sub = readTreeFileCached(workdirFs, rel, cache);
        if (!sub) {
            continue;
        }
        for (const p of collectSubtreePaths(sub.root)) {
            const n = normalizePathKey(p);
            if (!seen.has(n)) {
                seen.add(n);
                queue.push(n);
            }
        }
    }
    return ordered;
}

/**
 * Subtree paths referenced by the main tree JSON, transitively (nested subtree files).
 */
function getTransitiveSubtreeRelativePaths(workdirFs: string, mainContent: string): Set<string> {
    const pending = new Set<string>();
    const loaded = new Set<string>();
    let tree: TreeLike;
    try {
        tree = JSON.parse(mainContent) as TreeLike;
    } catch {
        return loaded;
    }
    const collectFromMemory = (node: TreeNodeLike | undefined) => {
        if (!node) return;
        if (node.path) pending.add(normalizePathKey(node.path));
        node.children?.forEach(collectFromMemory);
    };
    collectFromMemory(tree.root);
    while (pending.size > 0) {
        const relPath = pending.values().next().value as string;
        pending.delete(relPath);
        if (loaded.has(relPath)) continue;
        loaded.add(relPath);
        try {
            const fullPath = path.join(workdirFs, relPath);
            const raw = fs.readFileSync(fullPath, "utf-8");
            const sub = JSON.parse(raw) as TreeLike;
            const discover = (n: TreeNodeLike | undefined) => {
                if (!n) return;
                if (n.path) {
                    const q = normalizePathKey(n.path);
                    if (!loaded.has(q)) pending.add(q);
                }
                n.children?.forEach(discover);
            };
            discover(sub.root);
        } catch {
            /* missing or invalid subtree file */
        }
    }
    return loaded;
}

function uriToWorkdirRelative(uri: vscode.Uri, workdir: vscode.Uri): string | undefined {
    if (uri.scheme !== "file") return undefined;
    const rel = path.relative(workdir.fsPath, uri.fsPath).replace(/\\/g, "/");
    if (rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
    return normalizePathKey(rel);
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

interface VarDeclResult {
    usingVars: Record<string, { name: string; desc: string }>;
    importDecls: Array<{ path: string; vars: Array<{ name: string; desc: string }> }>;
    subtreeDecls: Array<{ path: string; vars: Array<{ name: string; desc: string }> }>;
}

/**
 * Read vars from a single file, returning them as a list (without merging into global map).
 */
function readVarsFromFile(
    relativePath: string,
    workdirFs: string,
    visitedForGlobal: Set<string>,
    globalVars: Record<string, { name: string; desc: string }>,
    cache: Map<string, TreeFileLike | null>
): Array<{ name: string; desc: string }> {
    const localVars: Array<{ name: string; desc: string }> = [];
    const relKey = normalizePathKey(relativePath);
    if (visitedForGlobal.has(relKey)) return localVars;
    visitedForGlobal.add(relKey);

    const fileTree = readTreeFileCached(workdirFs, relKey, cache);
    if (!fileTree) {
        return localVars;
    }
    for (const v of fileTree.vars ?? []) {
        if (v.name) {
            localVars.push({ name: v.name, desc: v.desc ?? "" });
            if (!globalVars[v.name]) globalVars[v.name] = { name: v.name, desc: v.desc ?? "" };
        }
    }
    // Also recurse into transitive imports for global vars
    for (const imp of fileTree.import ?? []) {
        if (typeof imp === "string") {
            readVarsFromFile(imp, workdirFs, visitedForGlobal, globalVars, cache);
        }
    }
    // Nested subtree files referenced inside this tree (same as collectSubtreePaths on main doc)
    for (const subPath of collectSubtreePaths(fileTree.root)) {
        readVarsFromFile(subPath, workdirFs, visitedForGlobal, globalVars, cache);
    }
    return localVars;
}

/**
 * Build the usingVars dictionary + full ImportDecl data for display in Inspector.
 */
async function buildUsingVars(
    workdir: vscode.Uri,
    tree: TreeLike | null
): Promise<VarDeclResult | null> {
    if (!tree) return null;

    const usingVars: Record<string, { name: string; desc: string }> = {};
    const readCache = new Map<string, TreeFileLike | null>();

    for (const v of tree.vars ?? []) {
        if (v.name) usingVars[v.name] = { name: v.name, desc: v.desc ?? "" };
    }

    const visited = new Set<string>();

    const importSeeds = (tree.import ?? []).filter((x): x is string => typeof x === "string");
    for (const imp of importSeeds) {
        readVarsFromFile(imp, workdir.fsPath, visited, usingVars, readCache);
    }

    for (const subtreePath of collectSubtreePaths(tree.root)) {
        readVarsFromFile(subtreePath, workdir.fsPath, visited, usingVars, readCache);
    }

    const importDecls = collectOrderedTransitiveImportPaths(
        workdir.fsPath,
        importSeeds,
        readCache
    ).map((p) => ({
        path: p,
        vars: getLocalVarsFromTreeFile(workdir.fsPath, p, readCache),
    }));

    const subtreeDecls = collectOrderedTransitiveSubtreePaths(
        workdir.fsPath,
        tree.root,
        readCache
    ).map((p) => ({
        path: p,
        vars: getLocalVarsFromTreeFile(workdir.fsPath, p, readCache),
    }));

    return { usingVars, importDecls, subtreeDecls };
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
