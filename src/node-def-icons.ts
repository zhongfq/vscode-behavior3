import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import type { NodeDef } from "./types";

/** True if `candidate` is inside `root` (same volume). */
function filePathIsUnderRoot(root: string, candidate: string): boolean {
    const a = path.resolve(root);
    const b = path.resolve(candidate);
    const rel = path.relative(a, b);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Map `node.icon` to `webview.asWebviewUri` URLs so the G6 canvas can load images under CSP.
 *
 * Convention (same as the desktop editor): **relative** `icon` paths are resolved from the
 * directory that contains the **currently loaded `.b3-setting`** file — not the workspace root
 * and not the tree JSON path. `settingDir` must be that directory (`getResolvedB3SettingDir`).
 */
export function mapNodeDefsIconsForWebview(
    webview: vscode.Webview,
    workspaceFolder: vscode.Uri,
    settingDir: string | undefined,
    nodeDefs: NodeDef[]
): NodeDef[] {
    const root = workspaceFolder.fsPath;
    return nodeDefs.map((def) => {
        const icon = def.icon;
        if (!icon) {
            return def;
        }
        const trimmed = icon.trim();
        if (!trimmed) {
            return def;
        }

        if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
            return def;
        }

        let absPath: string;
        if (trimmed.startsWith("file://")) {
            absPath = vscode.Uri.parse(trimmed).fsPath;
        } else if (path.isAbsolute(trimmed)) {
            absPath = path.normalize(trimmed);
        } else if (settingDir) {
            absPath = path.normalize(path.join(settingDir, trimmed));
        } else {
            // Relative paths are only defined relative to `.b3-setting`; never guess workspace root.
            return { ...def, icon: undefined };
        }

        if (!filePathIsUnderRoot(root, absPath)) {
            return { ...def, icon: undefined };
        }

        try {
            if (!fs.existsSync(absPath)) {
                return { ...def, icon: undefined };
            }
        } catch {
            return { ...def, icon: undefined };
        }

        const webUri = webview.asWebviewUri(vscode.Uri.file(absPath));
        return { ...def, icon: webUri.toString() };
    });
}
