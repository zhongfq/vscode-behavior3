import * as fs from "fs";
import * as vscode from "vscode";
import {
    normalizeTreeContentForWrite,
    readFileContentFromDisk,
    TreeEditorDocument,
} from "./editor-session/document-sync";
import type { ActiveTreeEditorWebview } from "./editor-session/tree-editor-webview-session";
import { resolveTreeEditorSession } from "./editor-session/tree-editor-webview-session";
import type { HostToEditorMessage } from "./types";

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

export class TreeEditorProvider implements vscode.CustomEditorProvider<TreeEditorDocument> {
    public static readonly viewType = "behavior3.treeEditor";
    private static readonly activeWebviews = new Set<ActiveTreeEditorWebview>();
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
        await vscode.workspace.fs.writeFile(targetUri, Buffer.from(normalizedContent, "utf-8"));
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
        await vscode.workspace.fs.writeFile(context.destination, Buffer.from(document.content, "utf-8"));

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
        await resolveTreeEditorSession({
            document,
            webviewPanel,
            viewType: TreeEditorProvider.viewType,
            configureWebview: (webview, workspaceFolderUri) => {
                configureEditorWebview(webview, this._extensionUri, workspaceFolderUri);
            },
            persistMainDocumentToDisk: (currentDocument, opts) =>
                this.persistMainDocumentToDisk(currentDocument, opts),
            writeDocumentContentToDisk: (targetUri, content) =>
                this.writeDocumentContentToDisk(targetUri, content),
            revertDocument: (currentDocument, cancellation) =>
                this.revertCustomDocument(currentDocument, cancellation),
            onDidChangeDocument: (currentDocument) => {
                this._onDidChangeCustomDocument.fire({ document: currentDocument });
            },
            addActiveWebview: (entry) => {
                TreeEditorProvider.activeWebviews.add(entry);
            },
            removeActiveWebview: (entry) => {
                TreeEditorProvider.activeWebviews.delete(entry);
            },
        });
    }
}
