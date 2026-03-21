import * as fs from "fs";
import * as vscode from "vscode";
import type { HostToInspectorMessage, InspectorToHostMessage } from "./types";

function buildWebviewHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  entry: "editor" | "inspector"
): string {
  const htmlPath = vscode.Uri.joinPath(extensionUri, "dist", "webview", entry, "index.html");
  let html = fs.readFileSync(htmlPath.fsPath, "utf-8");

  const webviewRootUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "dist", "webview")
  );
  const assetsUri = `${webviewRootUri}/assets`;
  html = html.replace(/\.\.\/assets\//g, `${assetsUri}/`);
  html = html.replace(/(?<!=")\.\/assets\//g, `${assetsUri}/`);

  const baseTag = `<base href="${webviewRootUri}/">`;
  const src = webview.cspSource;
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${src} data: blob:; style-src ${src} 'unsafe-inline'; script-src ${src} 'unsafe-inline'; font-src ${src} data:; worker-src blob:;">`;
  html = html.replace("</head>", `  ${baseTag}\n  ${csp}\n</head>`);

  return html;
}

/**
 * Provides the Inspector sidebar webview.
 * Receives node/tree selection events from the active TreeEditorProvider
 * and allows property editing, which is forwarded back to the editor.
 */
export class InspectorViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = "behavior3.inspector";

  private _view?: vscode.WebviewView;

  constructor(private readonly _extensionUri: vscode.Uri) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this._extensionUri, "dist", "webview"),
        vscode.Uri.joinPath(this._extensionUri, "public"),
      ],
    };

    webviewView.webview.html = this._getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((msg: InspectorToHostMessage) => {
      switch (msg.type) {
        case "ready":
          // Re-send last known state so the panel shows data immediately
          if (this._lastMessage) {
            this._view?.webview.postMessage(this._lastMessage);
          }
          this._onReady?.();
          break;
        case "propertyChanged":
          // Forward to active editor
          this._onPropertyChanged?.(msg.nodeId, msg.data);
          break;
        case "treePropertyChanged":
          this._onTreePropertyChanged?.(msg.data);
          break;
      }
    });
  }

  /** Callback set by TreeEditorProvider when editor becomes active */
  _onPropertyChanged?: (nodeId: string, data: Record<string, unknown>) => void;
  _onTreePropertyChanged?: (data: Record<string, unknown>) => void;
  /** Called when the inspector webview sends "ready" — allows re-sending current state */
  _onReady?: () => void;

  /** Cache of the last message sent, so we can replay it when webview reloads */
  private _lastMessage?: HostToInspectorMessage;

  /** Send a message to the Inspector webview */
  postMessage(message: HostToInspectorMessage) {
    this._lastMessage = message;
    this._view?.webview.postMessage(message);
  }

  private _getHtml(webview: vscode.Webview): string {
    return buildWebviewHtml(webview, this._extensionUri, "inspector");
  }
}
