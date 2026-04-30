import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { getBehavior3OutputChannel } from "./outputChannel";
import { mapNodeDefsIconsForWebview } from "./nodeDefIcons";
import {
    getBehaviorProjectRootFsPath,
    getResolvedB3SettingDir,
    resolveNodeDefs,
    resolveWorkspaceNodeColors,
    watchSettingFile,
} from "./settingResolver";
import type { EditorToHostMessage, HostToEditorMessage, NodeDef } from "./types";
import { VERSION, type NodeLayout } from "../webview/shared/misc/b3type";

/**
 * Read the Vite-generated HTML for the editor webview entry,
 * and rewrite all asset references to proper vscode-webview-resource: URIs.
 */
function buildWebviewHtml(
    webview: vscode.Webview,
    extensionUri: vscode.Uri,
    title?: string,
    entry: "editor" | "v2" = "editor"
): string {
    const htmlPath = vscode.Uri.joinPath(extensionUri, "dist", "webview", entry, "index.html");
    let html = fs.readFileSync(htmlPath.fsPath, "utf-8");

    const webviewRootUri = webview.asWebviewUri(
        vscode.Uri.joinPath(extensionUri, "dist", "webview")
    );

    const assetsUri = `${webviewRootUri}/assets`;
    html = html.replace(/\.\.\/assets\//g, `${assetsUri}/`);
    html = html.replace(/(?<!=")\.\/assets\//g, `${assetsUri}/`);

    if (title) {
        html = html.replace(/<title>.*?<\/title>/, `<title>${title}</title>`);
    }

    const baseTag = `<base href="${webviewRootUri}/">`;

    const src = webview.cspSource;
    const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${src} data: blob:; style-src ${src} 'unsafe-inline'; script-src ${src} 'unsafe-inline'; font-src ${src} data:; worker-src blob:; connect-src ${src};">`;
    html = html.replace("</head>", `  ${baseTag}\n  ${csp}\n</head>`);

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
    return vscode.Uri.file(require("path").dirname(documentUri.fsPath));
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
        const nodeDefs = await resolveNodeDefs(workspaceFolderUri, document.uri);
        const settingDir = await getResolvedB3SettingDir(workspaceFolderUri, document.uri);
        let nodeColors = await resolveWorkspaceNodeColors(workspaceFolderUri, document.uri);
        const config = vscode.workspace.getConfiguration("behavior3");
        const checkExpr = config.get<boolean>("checkExpr", true);
        const editSubtreeNodeProps = config.get<boolean>("editSubtreeNodeProps", true);
        const language = getEditorLanguage(config.get<string>("language", "auto"));
        const nlayout = getNodeLayout(config.get<string>("layout", "normal"));

        const mapDefsForWebview = (defs: NodeDef[]) =>
            mapNodeDefsIconsForWebview(webviewPanel.webview, workspaceFolderUri, settingDir, defs);

        webviewPanel.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this._extensionUri, "dist", "webview"),
                vscode.Uri.joinPath(this._extensionUri, "public"),
                workspaceFolderUri,
            ],
        };

        webviewPanel.webview.html = this._getEditorHtml(webviewPanel.webview);

        const activeWebviewEntry = {
            workspaceFsPath: workspaceFolderUri.fsPath,
            postMessage: (message: HostToEditorMessage) =>
                webviewPanel.webview.postMessage(message),
        };
        TreeEditorProvider.activeWebviews.add(activeWebviewEntry);

        let fileVersionIsNewer = false;

        let cachedSubtreeRefs: Set<string> | null = null;
        const invalidateSubtreeRefs = () => {
            cachedSubtreeRefs = null;
        };
        const getSubtreeRefSet = (): Set<string> => {
            if (!cachedSubtreeRefs) {
                cachedSubtreeRefs = getTransitiveSubtreeRelativePaths(
                    projectRootUri.fsPath,
                    document.getText()
                );
            }
            return cachedSubtreeRefs;
        };

        let subtreeRefreshTimer: ReturnType<typeof setTimeout> | undefined;
        const flushParentSubtreeRefresh = () => {
            const msg: HostToEditorMessage = { type: "subtreeFileChanged" };
            webviewPanel.webview.postMessage(msg);
        };
        const scheduleParentSubtreeRefresh = () => {
            if (subtreeRefreshTimer) {
                clearTimeout(subtreeRefreshTimer);
            }
            subtreeRefreshTimer = setTimeout(() => {
                subtreeRefreshTimer = undefined;
                flushParentSubtreeRefresh();
            }, 450);
        };

        // Watch .b3-setting for changes
        const settingWatcher = watchSettingFile(workspaceFolderUri, document.uri, (newDefs) => {
            nodeDefs.splice(0, nodeDefs.length, ...newDefs);
            const msg: HostToEditorMessage = {
                type: "settingLoaded",
                nodeDefs: mapDefsForWebview(newDefs),
                nodeColors,
            };
            webviewPanel.webview.postMessage(msg);
        });

        // Main document → webview; subtree documents → debounced refresh parent canvas
        const docChangeDisposable = vscode.workspace.onDidChangeTextDocument((e) => {
            if (e.document.uri.toString() === document.uri.toString()) {
                invalidateSubtreeRefs();
                if (e.contentChanges.length > 0) {
                    const msg: HostToEditorMessage = {
                        type: "fileChanged",
                        content: document.getText(),
                    };
                    webviewPanel.webview.postMessage(msg);
                }
                return;
            }
            const rel = uriToWorkdirRelative(e.document.uri, projectRootUri);
            if (!rel || !getSubtreeRefSet().has(rel)) {
                return;
            }
            if (e.contentChanges.length > 0) {
                scheduleParentSubtreeRefresh();
            }
        });

        const subtreeSaveDisposable = vscode.workspace.onDidSaveTextDocument((saved) => {
            if (saved.uri.toString() === document.uri.toString()) {
                return;
            }
            const rel = uriToWorkdirRelative(saved.uri, projectRootUri);
            if (!rel || !getSubtreeRefSet().has(rel)) {
                return;
            }
            if (subtreeRefreshTimer) {
                clearTimeout(subtreeRefreshTimer);
                subtreeRefreshTimer = undefined;
            }
            flushParentSubtreeRefresh();
        });

        const themeChangeDisposable = vscode.window.onDidChangeActiveColorTheme(() => {
            const msg: HostToEditorMessage = {
                type: "themeChanged",
                theme: getVSCodeTheme(),
            };
            webviewPanel.webview.postMessage(msg);
        });

        // Handle messages from the editor webview
        webviewPanel.webview.onDidReceiveMessage(async (msg: EditorToHostMessage) => {
            switch (msg.type) {
                case "ready": {
                    const theme = getVSCodeTheme();
                    const content = document.getText();

                    // Check if file version is newer than the editor version
                    try {
                        const fileData = JSON.parse(content) as { version?: string };
                        const fv = fileData.version ?? "";
                        if (fv && isFileVersionNewer(fv)) {
                            fileVersionIsNewer = true;
                            const warnMsg =
                                language === "zh"
                                    ? `此文件由新版本 Behavior3(${fv}) 创建，请升级到最新版本。`
                                    : `This file is created by a newer version of Behavior3(${fv}), please upgrade to the latest version.`;
                            vscode.window.showWarningMessage(warnMsg);
                        }
                    } catch {
                        // ignore parse errors
                    }

                    // Compute allFiles and initial usingVars
                    const allFiles = await collectAllFiles(projectRootUri);
                    let initUsingVars: VarDeclResult | undefined;
                    try {
                        const treeJson = JSON.parse(content) as TreeLike;
                        const uv = await buildUsingVars(projectRootUri, treeJson);
                        if (uv) initUsingVars = uv;
                    } catch {
                        // parse error — send init without usingVars
                    }

                    const initMsg: HostToEditorMessage = {
                        type: "init",
                        content,
                        filePath: document.uri.fsPath,
                        workdir: projectRootUri.fsPath,
                        nodeDefs: mapDefsForWebview(nodeDefs),
                        checkExpr,
                        editSubtreeNodeProps,
                        language,
                        layout: nlayout,
                        theme,
                        allFiles,
                        nodeColors,
                    };
                    webviewPanel.webview.postMessage(initMsg);

                    if (initUsingVars) {
                        const varMsg: HostToEditorMessage = {
                            type: "varDeclLoaded",
                            usingVars: initUsingVars.usingVars
                                ? Object.values(initUsingVars.usingVars)
                                : [],
                            importDecls: initUsingVars.importDecls,
                            subtreeDecls: initUsingVars.subtreeDecls,
                        };
                        webviewPanel.webview.postMessage(varMsg);
                    }
                    break;
                }

                case "update": {
                    if (fileVersionIsNewer) {
                        const fileData = JSON.parse(document.getText()) as { version?: string };
                        const errMsg =
                            language === "zh"
                                ? `此文件由新版本 Behavior3(${fileData.version}) 创建，请升级到最新版本后再编辑。`
                                : `This file is created by a newer version of Behavior3(${fileData.version}). Please upgrade to the latest version.`;
                        vscode.window.showErrorMessage(errMsg);
                        break;
                    }
                    const edit = new vscode.WorkspaceEdit();
                    edit.replace(
                        document.uri,
                        new vscode.Range(0, 0, document.lineCount, 0),
                        msg.content
                    );
                    await vscode.workspace.applyEdit(edit);
                    break;
                }

                case "treeSelected": {
                    // Recompute usingVars (and optionally refresh allFiles) and send back
                    const allFiles = await collectAllFiles(projectRootUri);
                    const result = await buildUsingVars(
                        projectRootUri,
                        msg.tree as TreeLike | null
                    );
                    if (result) {
                        const varMsg: HostToEditorMessage = {
                            type: "varDeclLoaded",
                            usingVars: Object.values(result.usingVars),
                            allFiles,
                            importDecls: result.importDecls,
                            subtreeDecls: result.subtreeDecls,
                        };
                        webviewPanel.webview.postMessage(varMsg);
                    }
                    break;
                }

                case "requestSetting": {
                    const freshDefs = await resolveNodeDefs(workspaceFolderUri, document.uri);
                    nodeColors = await resolveWorkspaceNodeColors(workspaceFolderUri, document.uri);
                    nodeDefs.splice(0, nodeDefs.length, ...freshDefs);
                    const replyMsg: HostToEditorMessage = {
                        type: "settingLoaded",
                        nodeDefs: mapDefsForWebview(freshDefs),
                        nodeColors,
                    };
                    webviewPanel.webview.postMessage(replyMsg);
                    break;
                }

                case "build": {
                    vscode.commands.executeCommand("behavior3.build");
                    break;
                }

                case "webviewLog": {
                    const out = getBehavior3OutputChannel();
                    const text = msg.message;
                    switch (msg.level) {
                        case "log":
                            out.info(text);
                            break;
                        case "info":
                            out.info(text);
                            break;
                        case "debug":
                            out.debug(text);
                            break;
                        case "warn":
                            out.warn(text);
                            break;
                        case "error":
                            out.error(text);
                            break;
                        default:
                            out.info(text);
                    }
                    break;
                }

                case "readFile": {
                    const fileUri = resolvePathInWorkdir(msg.path, projectRootUri);
                    if (!fileUri) {
                        const reply: HostToEditorMessage = {
                            type: "readFileResult",
                            requestId: msg.requestId,
                            content: null,
                        };
                        webviewPanel.webview.postMessage(reply);
                        getBehavior3OutputChannel().warn(
                            "readFile rejected: path outside workdir",
                            msg.path
                        );
                        break;
                    }
                    try {
                        const openDoc = vscode.workspace.textDocuments.find(
                            (d) =>
                                d.uri.fsPath === fileUri.fsPath ||
                                d.uri.toString() === fileUri.toString()
                        );
                        const content = openDoc
                            ? openDoc.getText()
                            : Buffer.from(await vscode.workspace.fs.readFile(fileUri)).toString(
                                  "utf-8"
                              );
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
                        const reply: HostToEditorMessage = {
                            type: "readFileResult",
                            requestId: msg.requestId,
                            content,
                        };
                        webviewPanel.webview.postMessage(reply);
                    } catch {
                        const reply: HostToEditorMessage = {
                            type: "readFileResult",
                            requestId: msg.requestId,
                            content: null,
                        };
                        webviewPanel.webview.postMessage(reply);
                        getBehavior3OutputChannel().warn("readFile failed", msg.path);
                    }
                    break;
                }

                case "saveSubtree": {
                    const reply = (r: HostToEditorMessage) => webviewPanel.webview.postMessage(r);
                    const fileUri = resolvePathInWorkdir(msg.path, projectRootUri, {
                        mustBeJson: true,
                    });
                    if (!fileUri) {
                        const err =
                            "Save path must be a .json file inside the behavior tree work directory.";
                        reply({
                            type: "saveSubtreeResult",
                            requestId: msg.requestId,
                            success: false,
                            error: err,
                        });
                        getBehavior3OutputChannel().warn("saveSubtree rejected", msg.path);
                        break;
                    }
                    try {
                        await vscode.workspace.fs.writeFile(
                            fileUri,
                            Buffer.from(msg.content, "utf-8")
                        );
                        reply({
                            type: "saveSubtreeResult",
                            requestId: msg.requestId,
                            success: true,
                        });
                    } catch (e) {
                        vscode.window.showErrorMessage(`Failed to save subtree: ${e}`);
                        reply({
                            type: "saveSubtreeResult",
                            requestId: msg.requestId,
                            success: false,
                            error: String(e),
                        });
                    }
                    break;
                }

                case "saveSubtreeAs": {
                    const workdirUri = projectRootUri;
                    const reply = (r: HostToEditorMessage) => webviewPanel.webview.postMessage(r);
                    try {
                        const defaultUri = vscode.Uri.joinPath(
                            workdirUri,
                            `${msg.suggestedBaseName}.json`
                        );
                        const picked = await vscode.window.showSaveDialog({
                            defaultUri,
                            filters: { JSON: ["json"] },
                        });
                        if (!picked) {
                            reply({
                                type: "saveSubtreeAsResult",
                                requestId: msg.requestId,
                                savedPath: null,
                            });
                            break;
                        }
                        const rel = uriToWorkdirRelative(picked, workdirUri);
                        if (!rel) {
                            const err =
                                "Save location must be inside the behavior tree work directory.";
                            vscode.window.showErrorMessage(err);
                            reply({
                                type: "saveSubtreeAsResult",
                                requestId: msg.requestId,
                                savedPath: null,
                                error: err,
                            });
                            break;
                        }
                        let body = msg.content;
                        try {
                            const parsed = JSON.parse(msg.content) as { name?: string };
                            const base = path.basename(picked.fsPath, path.extname(picked.fsPath));
                            parsed.name = base;
                            body = JSON.stringify(parsed, null, 2);
                        } catch {
                            /* keep original */
                        }
                        await vscode.workspace.fs.writeFile(picked, Buffer.from(body, "utf-8"));
                        reply({
                            type: "saveSubtreeAsResult",
                            requestId: msg.requestId,
                            savedPath: rel,
                        });
                    } catch (e) {
                        const err = String(e);
                        vscode.window.showErrorMessage(`Failed to save subtree: ${err}`);
                        reply({
                            type: "saveSubtreeAsResult",
                            requestId: msg.requestId,
                            savedPath: null,
                            error: err,
                        });
                    }
                    break;
                }
            }
        });

        webviewPanel.onDidDispose(() => {
            if (subtreeRefreshTimer) {
                clearTimeout(subtreeRefreshTimer);
            }
            TreeEditorProvider.activeWebviews.delete(activeWebviewEntry);
            settingWatcher.dispose();
            docChangeDisposable.dispose();
            subtreeSaveDisposable.dispose();
            themeChangeDisposable.dispose();
        });
    }

    private _getEditorHtml(webview: vscode.Webview): string {
        return buildWebviewHtml(webview, this._extensionUri, "Behavior3 Editor V2", "v2");
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
    const path = require("path") as typeof import("path");
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

function getNodeLayout(setting: string): NodeLayout {
    return setting === "compact" ? "compact" : "normal";
}
