import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { buildBehaviorProject } from "./build-cli";
import { getLogger, logger, setLogger, type Logger } from "../../webview/shared/misc/logger";
import { getBehavior3OutputChannel } from "../output-channel";
import {
    findBehaviorSettingFileSync,
    findBehaviorWorkspaceFileSync,
} from "../project-path-discovery";
import { TreeEditorProvider } from "../tree-editor-provider";

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

const WORKSPACE_STATE_KEY_PREFIX = "behavior3.lastBuildOutputDir:";
let buildInFlight = false;

export interface RunBuildOptions {
    buildScriptDebug?: boolean;
}

const isRuntimeModuleFile = (fileName: string) =>
    fileName.includes(".runtime.") && fileName.endsWith(".mjs");

function cleanupRuntimeModulesUnder(dir: string): void {
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return;
    }

    for (const entry of entries) {
        const filePath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            cleanupRuntimeModulesUnder(filePath);
            continue;
        }
        if (!entry.isFile() || !isRuntimeModuleFile(entry.name)) {
            continue;
        }
        try {
            fs.unlinkSync(filePath);
        } catch {
            /* ignore cleanup failure */
        }
    }
}

async function startBuildScriptDebugSession(params: {
    context: vscode.ExtensionContext;
    folder: vscode.WorkspaceFolder;
    projectPath: string;
    workspaceFile: string;
    settingPath: string;
    outputDir: string;
    checkExpr: boolean;
}): Promise<boolean> {
    const program = params.context.asAbsolutePath(path.join("dist", "build-cli.js"));
    if (!fs.existsSync(program)) {
        void vscode.window.showErrorMessage(`Build CLI is missing: ${program}`);
        return false;
    }

    const debugConfig: vscode.DebugConfiguration = {
        type: "node",
        request: "launch",
        name: "Debug Behavior3 Build Script",
        program,
        cwd: params.folder.uri.fsPath,
        console: "integratedTerminal",
        sourceMaps: true,
        smartStep: true,
        skipFiles: ["<node_internals>/**"],
        args: [
            "--build-script-debug",
            "--output",
            params.outputDir,
            "--project",
            params.projectPath,
            "--workspace-file",
            params.workspaceFile,
            "--setting-file",
            params.settingPath,
            params.checkExpr ? "--check-expr" : "--no-check-expr",
        ],
    };

    const cleanupSession = vscode.debug.onDidTerminateDebugSession((session) => {
        if (
            session.configuration.program !== program ||
            !Array.isArray(session.configuration.args) ||
            !session.configuration.args.includes(params.workspaceFile)
        ) {
            return;
        }
        cleanupRuntimeModulesUnder(path.dirname(params.workspaceFile));
        cleanupSession.dispose();
    });

    const started = await vscode.debug.startDebugging(params.folder, debugConfig);
    if (!started) {
        cleanupSession.dispose();
    }
    return started;
}

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

export async function runBuild(
    context: vscode.ExtensionContext,
    options: RunBuildOptions = {}
): Promise<void> {
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
        const workspaceSearchPath = treeUri?.fsPath ?? workspaceRoot;
        const workspaceFile = findBehaviorWorkspaceFileSync(workspaceSearchPath, {
            rootDir: workspaceRoot,
        });
        if (!workspaceFile) {
            void vscode.window.showErrorMessage(
                treeUri
                    ? "No .b3-workspace file found when walking up from the active behavior tree file. Add one next to your project (e.g. sample/workspace.b3-workspace)."
                    : "No .b3-workspace file found when walking up from the workspace folder. Add one (e.g. sample/workspace.b3-workspace) or open a behavior tree file first."
            );
            return;
        }

        const settingPath = findBehaviorSettingFileSync(path.dirname(workspaceFile), {
            rootDir: workspaceRoot,
        });
        if (!settingPath) {
            void vscode.window.showErrorMessage(
                "No .b3-setting file found. Place a *.b3-setting next to your behavior trees or in a parent folder."
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
        const buildScriptDebug = options.buildScriptDebug;

        const out = getBehavior3OutputChannel();
        out.show(true);
        out.info(`Build output → ${outputDirFs}`);
        if (buildScriptDebug) {
            out.info("Starting build script debug session.");
            const started = await startBuildScriptDebugSession({
                context,
                folder,
                projectPath: treeUri?.fsPath ?? workspaceFile,
                workspaceFile,
                settingPath,
                outputDir: outputDirPosix,
                checkExpr,
            });
            if (!started) {
                void vscode.window.showErrorMessage("Failed to start build script debug session.");
            }
            return;
        }

        const prevLogger = getLogger();
        setLogger(createBuildScopedLogger(prevLogger));
        try {
            const { hasError } = await buildBehaviorProject({
                workspaceFile,
                settingFile: settingPath,
                outputDir: outputDirPosix,
                checkExpr,
                buildScriptDebug,
            });

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
