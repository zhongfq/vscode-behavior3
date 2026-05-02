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

interface TreeEditorSessionState {
    nodeDefs: NodeDef[];
    settingDir?: string;
    currentSettings: EditorLiveSettings;
    fileVersionIsNewer: boolean;
    newerFileVersion: string | null;
    suppressNextMainDocumentContent: string | null;
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

function normalizeSavedSubtreeContent(content: string, fileUri: vscode.Uri): string {
    try {
        const parsed = JSON.parse(content) as { name?: string };
        parsed.name = path.basename(fileUri.fsPath, path.extname(fileUri.fsPath));
        return JSON.stringify(parsed, null, 2);
    } catch {
        return content;
    }
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

export class TreeEditorProvider implements vscode.CustomTextEditorProvider {
    public static readonly viewType = "behavior3.treeEditor";
    private static readonly activeWebviews = new Set<{
        workspaceFsPath: string;
        postMessage: (message: HostToEditorMessage) => Thenable<boolean>;
    }>();

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

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _context: vscode.ExtensionContext
    ) {}

    async resolveCustomTextEditor(
        document: vscode.TextDocument,
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
            suppressNextMainDocumentContent: null,
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
            postMessage,
        };
        TreeEditorProvider.activeWebviews.add(activeWebviewEntry);

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

        const getTrackedSubtreeRefs = (): Set<string> => {
            if (!state.cachedSubtreeRefs) {
                state.cachedSubtreeRefs = getTransitiveSubtreeRelativePaths(
                    projectRootUri.fsPath,
                    document.getText()
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

        const scheduleParentSubtreeRefresh = () => {
            state.subtreeRefreshTimer = clearRefreshTimer(state.subtreeRefreshTimer);
            state.subtreeRefreshTimer = setTimeout(() => {
                state.subtreeRefreshTimer = undefined;
                flushParentSubtreeRefresh();
            }, 450);
        };

        const applyContentFromWebview = async (content: string): Promise<boolean> => {
            if (document.getText() === content) {
                return true;
            }

            state.suppressNextMainDocumentContent = content;
            const edit = new vscode.WorkspaceEdit();
            edit.replace(document.uri, new vscode.Range(0, 0, document.lineCount, 0), content);
            const applied = await vscode.workspace.applyEdit(edit);
            if (!applied) {
                state.suppressNextMainDocumentContent = null;
            }
            return applied;
        };

        const blockEditingForNewerFile = (): string | null => {
            if (!state.fileVersionIsNewer) {
                return null;
            }

            const fileVersion =
                state.newerFileVersion ?? getTreeFileVersion(document.getText()) ?? "";
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
            const content = document.getText();

            state.fileVersionIsNewer = false;
            state.newerFileVersion = null;

            const fileVersion = getTreeFileVersion(content);
            if (fileVersion && isFileVersionNewer(fileVersion)) {
                state.fileVersionIsNewer = true;
                state.newerFileVersion = fileVersion;
                vscode.window.showWarningMessage(
                    getNewerVersionMessage(state.currentSettings.language, fileVersion, "warn")
                );
            }

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
                const applied = await applyContentFromWebview(msg.content);
                const saved = applied ? await document.save() : false;
                await postMessage({
                    type: "saveDocumentResult",
                    requestId: msg.requestId,
                    success: saved,
                    error: saved ? undefined : "Failed to save document",
                } satisfies HostToEditorMessage);
            } catch (error) {
                await postMessage({
                    type: "saveDocumentResult",
                    requestId: msg.requestId,
                    success: false,
                    error: String(error),
                } satisfies HostToEditorMessage);
            }
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
                await vscode.workspace.fs.writeFile(fileUri, Buffer.from(msg.content, "utf-8"));
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

                await vscode.workspace.fs.writeFile(
                    picked,
                    Buffer.from(normalizeSavedSubtreeContent(msg.content, picked), "utf-8")
                );
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
            vscode.workspace.onDidChangeTextDocument((event) => {
                if (event.document.uri.toString() === document.uri.toString()) {
                    invalidateSubtreeRefs();
                    if (event.contentChanges.length === 0) {
                        return;
                    }
                    if (
                        state.suppressNextMainDocumentContent !== null &&
                        document.getText() === state.suppressNextMainDocumentContent
                    ) {
                        state.suppressNextMainDocumentContent = null;
                        return;
                    }
                    void postMessage({
                        type: "fileChanged",
                        content: document.getText(),
                    });
                    return;
                }

                if (
                    event.contentChanges.length > 0 &&
                    isTrackedSubtreeDocument(event.document.uri)
                ) {
                    scheduleParentSubtreeRefresh();
                }
            }),
            vscode.workspace.onDidSaveTextDocument((savedDocument) => {
                if (savedDocument.uri.toString() === document.uri.toString()) {
                    return;
                }
                if (!isTrackedSubtreeDocument(savedDocument.uri)) {
                    return;
                }
                state.subtreeRefreshTimer = clearRefreshTimer(state.subtreeRefreshTimer);
                flushParentSubtreeRefresh();
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
                        if (blockEditingForNewerFile()) {
                            break;
                        }
                        await applyContentFromWebview(msg.content);
                        break;

                    case "saveDocument":
                        await handleSaveDocumentMessage(msg);
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
