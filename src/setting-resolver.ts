import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { logger } from "../webview/shared/misc/logger";
import type { NodeDef } from "./types";

/** True if `dir` is the workspace root or a subdirectory of it. */
function dirIsInWorkspaceTree(workspaceRoot: string, dir: string): boolean {
    const root = path.resolve(workspaceRoot);
    const d = path.resolve(dir);
    const rel = path.relative(root, d);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Walk from the opened file's directory up to the workspace root; return the first `*.b3-setting` found.
 * Matches desktop / monorepo layouts where the config lives in e.g. `sample/` while trees are under `sample/workdir/`.
 */
export function findB3SettingPath(
    documentUri: vscode.Uri,
    workspaceFolder: vscode.Uri | undefined
): string | undefined {
    const root = workspaceFolder?.fsPath;
    let dir = path.resolve(path.dirname(documentUri.fsPath));

    while (true) {
        if (root && !dirIsInWorkspaceTree(root, dir)) {
            break;
        }
        try {
            const names = fs.readdirSync(dir);
            const hit = names.filter((n) => n.endsWith(".b3-setting")).sort();
            if (hit.length > 0) {
                return path.join(dir, hit[0]);
            }
        } catch {
            /* ignore */
        }
        if (root && path.resolve(dir) === path.resolve(root)) {
            break;
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return undefined;
}

/**
 * Walk from the opened file's directory up to the workspace root; return the first `*.b3-workspace` found.
 * Same traversal as {@link findB3SettingPath}, used by the build command to locate the project root.
 */
export function findB3WorkspacePath(
    documentUri: vscode.Uri,
    workspaceFolder: vscode.Uri | undefined
): string | undefined {
    const root = workspaceFolder?.fsPath;
    let dir = path.resolve(path.dirname(documentUri.fsPath));

    while (true) {
        if (root && !dirIsInWorkspaceTree(root, dir)) {
            break;
        }
        try {
            const names = fs.readdirSync(dir);
            const hit = names.filter((n) => n.endsWith(".b3-workspace")).sort();
            if (hit.length > 0) {
                return path.join(dir, hit[0]);
            }
        } catch {
            /* ignore */
        }
        if (root && path.resolve(dir) === path.resolve(root)) {
            break;
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return undefined;
}

/**
 * Behavior-tree project root: the directory containing the resolved `*.b3-workspace` file
 * (same as build `process.chdir` / `b3util.workdir`). Subtree `path` and imports are relative to this.
 * Falls back to the VS Code workspace folder when no `.b3-workspace` is found walking up from the document.
 */
export function getBehaviorProjectRootFsPath(
    documentUri: vscode.Uri,
    workspaceFolder: vscode.Uri
): string {
    const wfile = findB3WorkspacePath(documentUri, workspaceFolder);
    if (wfile) {
        return path.dirname(wfile);
    }
    return workspaceFolder.fsPath;
}

/**
 * Same discovery order as `resolveNodeDefs`. Returns the directory of the resolved `.b3-setting`
 * file so relative fields such as `NodeDef.icon` can be resolved against that directory.
 */
export async function getResolvedB3SettingDir(
    workspaceFolder: vscode.Uri,
    documentUri?: vscode.Uri
): Promise<string | undefined> {
    const p = await resolveB3SettingFilePath(workspaceFolder, documentUri);
    return p ? path.dirname(p) : undefined;
}

async function resolveB3SettingFilePath(
    workspaceFolder: vscode.Uri,
    documentUri?: vscode.Uri
): Promise<string | undefined> {
    if (documentUri) {
        const wf = vscode.workspace.getWorkspaceFolder(documentUri);
        const foundFs = findB3SettingPath(documentUri, wf?.uri);
        if (foundFs) {
            try {
                await vscode.workspace.fs.stat(vscode.Uri.file(foundFs));
                return foundFs;
            } catch {
                /* ignore */
            }
        }
    }

    const pattern = new vscode.RelativePattern(workspaceFolder.fsPath, "*.b3-setting");
    const found = await vscode.workspace.findFiles(pattern, null, 1);
    if (found.length > 0) {
        try {
            await vscode.workspace.fs.stat(found[0]);
            return found[0].fsPath;
        } catch {
            /* ignore */
        }
    }

    return undefined;
}

/**
 * Load node definitions from `.b3-setting`.
 *
 * Priority:
 *   1. Walk upward from the opened tree file's directory to workspace root; first `*.b3-setting` per directory
 *   2. Any `*.b3-setting` directly in the workspace folder (legacy)
 */
export async function resolveNodeDefs(
    workspaceFolder: vscode.Uri,
    documentUri?: vscode.Uri
): Promise<NodeDef[]> {
    const filePath = await resolveB3SettingFilePath(workspaceFolder, documentUri);
    if (!filePath) {
        return [];
    }
    try {
        const raw = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
        const text = Buffer.from(raw).toString("utf-8");
        return JSON.parse(text) as NodeDef[];
    } catch (e) {
        logger.error("[behavior3] failed to load setting file:", filePath, e);
        return [];
    }
}

/**
 * Read `settings.nodeColors` from the resolved `.b3-workspace` file.
 * Returns `undefined` when no workspace file is found or it has no `nodeColors`.
 */
export async function resolveWorkspaceNodeColors(
    workspaceFolder: vscode.Uri,
    documentUri?: vscode.Uri
): Promise<Record<string, string> | undefined> {
    let wfPath: string | undefined;

    if (documentUri) {
        const wf = vscode.workspace.getWorkspaceFolder(documentUri);
        wfPath = findB3WorkspacePath(documentUri, wf?.uri ?? workspaceFolder);
    }

    if (!wfPath) {
        const pattern = new vscode.RelativePattern(workspaceFolder.fsPath, "*.b3-workspace");
        const found = await vscode.workspace.findFiles(pattern, null, 1);
        if (found.length > 0) wfPath = found[0].fsPath;
    }

    if (!wfPath) return undefined;

    try {
        const raw = await vscode.workspace.fs.readFile(vscode.Uri.file(wfPath));
        const data = JSON.parse(Buffer.from(raw).toString("utf-8")) as {
            settings?: { nodeColors?: Record<string, string> };
        };
        const nc = data.settings?.nodeColors;
        return nc && Object.keys(nc).length > 0 ? nc : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Watch any `*.b3-setting` under the workspace folder so nested configs (e.g. `sample/*.b3-setting`) trigger reload.
 */
export function watchSettingFile(
    workspaceFolder: vscode.Uri,
    callback: () => void
): vscode.Disposable {
    const pattern = new vscode.RelativePattern(workspaceFolder.fsPath, "**/*.b3-setting");
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);

    watcher.onDidChange(callback);
    watcher.onDidCreate(callback);
    watcher.onDidDelete(callback);

    return watcher;
}

/**
 * Watch any `*.b3-workspace` under the workspace folder so settings such as `settings.nodeColors`
 * can be refreshed without reopening the editor.
 */
export function watchWorkspaceFile(
    workspaceFolder: vscode.Uri,
    callback: () => void
): vscode.Disposable {
    const pattern = new vscode.RelativePattern(workspaceFolder.fsPath, "**/*.b3-workspace");
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);

    watcher.onDidChange(callback);
    watcher.onDidCreate(callback);
    watcher.onDidDelete(callback);

    return watcher;
}
