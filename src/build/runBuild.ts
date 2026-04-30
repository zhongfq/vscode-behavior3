import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { getLogger, logger, setLogger, type Logger } from "../../webview/shared/misc/logger";
import { getBehavior3OutputChannel } from "../outputChannel";
import { findB3SettingPath, findB3WorkspacePath } from "../settingResolver";
import { TreeEditorProvider } from "../treeEditorProvider";
import { setFs } from "../../webview/shared/misc/b3fs";
import {
    buildProject,
    initWorkdirFromSettingFile,
    setCheckExpr,
} from "../../webview/shared/misc/b3util";

/**
 * During build: suppress debug. Delegate log/info/warn/error to `prev` only — `prev` is already the
 * extension's composed logger (console + OutputChannel); do not add another channel sink or lines
 * appear twice in the Output panel.
 */
function createBuildScopedLogger(prev: Logger): Logger {
    return {
        log: (...args: unknown[]) => prev.log(...args),
        debug: () => {
            /* suppress noisy debug from b3util during build */
        },
        info: (...args: unknown[]) => prev.info(...args),
        warn: (...args: unknown[]) => prev.warn(...args),
        error: (...args: unknown[]) => prev.error(...args),
    };
}

/** Inject Node `fs` into shared `b3util` / `getFs()` (see `webview/shared/misc/b3fs.ts`). */
setFs(fs);

const WORKSPACE_STATE_KEY_PREFIX = "behavior3.lastBuildOutputDir:";
let buildInFlight = false;

function getWorkspaceStateKey(folderUri: vscode.Uri): string {
    return WORKSPACE_STATE_KEY_PREFIX + folderUri.toString();
}

export function getLastBuildOutputUri(
    context: vscode.ExtensionContext,
    workspaceFolder: vscode.Uri
): vscode.Uri | undefined {
    const saved = context.workspaceState.get<string>(getWorkspaceStateKey(workspaceFolder));
    if (!saved) {
        return undefined;
    }
    try {
        const uri = vscode.Uri.file(saved);
        if (fs.existsSync(uri.fsPath)) {
            return uri;
        }
    } catch {
        /* ignore */
    }
    return undefined;
}

export async function saveLastBuildOutput(
    context: vscode.ExtensionContext,
    workspaceFolder: vscode.Uri,
    outputDirFsPath: string
): Promise<void> {
    await context.workspaceState.update(getWorkspaceStateKey(workspaceFolder), outputDirFsPath);
}

/**
 * Resolve `.b3-setting` path (same rules as `settingResolver.resolveNodeDefs`, synchronous).
 * @param searchFromDir Optional directory to start walking upward from (e.g. dirname of `.b3-workspace`).
 */
export function resolveSettingFilePathSync(
    workspaceRootFsPath: string,
    searchFromDir?: string
): string | undefined {
    const config = vscode.workspace.getConfiguration("behavior3");
    const settingFile = config.get<string>("settingFile", "");
    if (settingFile) {
        const p = path.join(workspaceRootFsPath, settingFile);
        if (fs.existsSync(p)) {
            return p;
        }
    }
    const start = searchFromDir ?? workspaceRootFsPath;
    const anchor = vscode.Uri.file(path.join(path.resolve(start), ".behavior3-anchor"));
    const rootUri = vscode.Uri.file(path.resolve(workspaceRootFsPath));
    return findB3SettingPath(anchor, rootUri);
}

/**
 * Prefer the active behavior tree tab (custom editor or .json); webview focus may hide activeTextEditor.
 */
function getActiveBehaviorTreeFileUri(): vscode.Uri | undefined {
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    if (tab?.input instanceof vscode.TabInputCustom) {
        if (tab.input.viewType === TreeEditorProvider.viewType && tab.input.uri.scheme === "file") {
            return tab.input.uri;
        }
    }
    if (tab?.input instanceof vscode.TabInputText) {
        const u = tab.input.uri;
        if (u.scheme === "file") {
            const ext = path.extname(u.fsPath).toLowerCase();
            if (ext === ".json") {
                return u;
            }
        }
    }
    const ed = vscode.window.activeTextEditor;
    if (ed?.document.uri.scheme === "file") {
        const u = ed.document.uri;
        const ext = path.extname(u.fsPath).toLowerCase();
        if (ext === ".json") {
            return u;
        }
    }
    return undefined;
}

export async function runBuild(context: vscode.ExtensionContext): Promise<void> {
    if (buildInFlight) {
        void vscode.window.showWarningMessage(
            "A build is already running. Please wait for it to finish."
        );
        return;
    }
    buildInFlight = true;
    try {
        const treeUri = getActiveBehaviorTreeFileUri();
        let folder: vscode.WorkspaceFolder | undefined;
        if (treeUri) {
            folder = vscode.workspace.getWorkspaceFolder(treeUri);
            if (!folder) {
                void vscode.window.showErrorMessage(
                    "The active behavior tree file must belong to an opened workspace folder."
                );
                return;
            }
        } else {
            folder = vscode.workspace.workspaceFolders?.[0];
        }
        if (!folder) {
            void vscode.window.showErrorMessage("Open a workspace folder before building.");
            return;
        }

        const workspaceRoot = folder.uri.fsPath;
        const walkAnchorUri =
            treeUri ?? vscode.Uri.file(path.join(workspaceRoot, ".behavior3-build-anchor"));
        const workspaceFile = findB3WorkspacePath(walkAnchorUri, folder.uri);
        if (!workspaceFile) {
            void vscode.window.showErrorMessage(
                treeUri
                    ? "No .b3-workspace file found when walking up from the active behavior tree file. Add one next to your project (e.g. sample/workspace.b3-workspace)."
                    : "No .b3-workspace file found when walking up from the workspace folder. Add one (e.g. sample/workspace.b3-workspace) or open a behavior tree file first."
            );
            return;
        }

        const settingPath = resolveSettingFilePathSync(
            workspaceRoot,
            workspaceFile ? path.dirname(workspaceFile) : undefined
        );
        if (!settingPath) {
            void vscode.window.showErrorMessage(
                "No .b3-setting file found. Add behavior3.settingFile or place a *.b3-setting in the workspace root."
            );
            return;
        }

        const workdirFs = path.dirname(workspaceFile);
        const workdirPosix = workdirFs.replace(/\\/g, "/");

        const defaultUri = getLastBuildOutputUri(context, folder.uri) ?? folder.uri;

        const picked = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            defaultUri,
            openLabel: "Select output folder",
            title: "Build Behavior Tree — output directory",
        });
        if (!picked || picked.length === 0) {
            return;
        }

        const outputDirFs = picked[0].fsPath;
        const outputDirPosix = outputDirFs.replace(/\\/g, "/");
        await saveLastBuildOutput(context, folder.uri, outputDirFs);

        const config = vscode.workspace.getConfiguration("behavior3");
        const checkExpr = config.get<boolean>("checkExpr", true);

        const out = getBehavior3OutputChannel();
        out.show(true);
        out.info(`Build output → ${outputDirFs}`);

        const prevLogger = getLogger();
        setLogger(createBuildScopedLogger(prevLogger));
        try {
            initWorkdirFromSettingFile(workdirPosix, settingPath.replace(/\\/g, "/"), () => {});
            setCheckExpr(checkExpr);

            const workspaceFilePosix = workspaceFile.replace(/\\/g, "/");
            const hasError = await buildProject(workspaceFilePosix, outputDirPosix);

            if (hasError) {
                const resultMessage =
                    "Build finished with validation errors. See the Output panel for details.";
                const delivered = TreeEditorProvider.postMessageToWorkspace(folder.uri.fsPath, {
                    type: "buildResult",
                    success: false,
                    message: resultMessage,
                });
                if (!delivered) {
                    void vscode.window.showErrorMessage(resultMessage);
                }
            } else {
                const resultMessage = `Build completed: ${outputDirFs}`;
                out.info(resultMessage);
                const delivered = TreeEditorProvider.postMessageToWorkspace(folder.uri.fsPath, {
                    type: "buildResult",
                    success: true,
                    message: resultMessage,
                });
                if (!delivered) {
                    void vscode.window.showInformationMessage(resultMessage);
                }
            }
        } catch (e) {
            logger.error("build failed:", e);
            const resultMessage = `Build failed: ${e}`;
            const delivered = TreeEditorProvider.postMessageToWorkspace(folder.uri.fsPath, {
                type: "buildResult",
                success: false,
                message: resultMessage,
            });
            if (!delivered) {
                void vscode.window.showErrorMessage(resultMessage);
            }
        } finally {
            setLogger(prevLogger);
        }
    } finally {
        buildInFlight = false;
    }
}
