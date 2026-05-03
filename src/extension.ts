import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { Context, Node, NodeDef } from "behavior3";
import { stringifyJson } from "../webview/shared/misc/stringify";
import { writeTree } from "../webview/shared/misc/util";
import { composeLoggers, createConsoleLogger, setLogger } from "../webview/shared/misc/logger";
import { runBuild } from "./build/run-build";
import { createLogOutputChannelLogger } from "./log-channel";
import { getBehavior3OutputChannel } from "./output-channel";
import { findB3SettingPath } from "./setting-resolver";
import { TreeEditorProvider } from "./tree-editor-provider";

export function activate(context: vscode.ExtensionContext) {
    const out = getBehavior3OutputChannel();
    context.subscriptions.push(out);
    setLogger(composeLoggers(createConsoleLogger(), createLogOutputChannelLogger(out)));

    const editorProvider = new TreeEditorProvider(context.extensionUri);
    context.subscriptions.push(
        vscode.window.registerCustomEditorProvider(TreeEditorProvider.viewType, editorProvider, {
            supportsMultipleEditorsPerDocument: false,
            webviewOptions: {
                retainContextWhenHidden: true,
            },
        })
    );

    // Auto-open JSON files with Behavior3 editor only when they look like trees and
    // a parent `.b3-setting` exists. Scope: once per open cycle (re-check after close/reopen).
    const autoCheckedJsonWhileOpen = new Set<string>();
    const autoOpeningJsonUris = new Set<string>();
    const skipNextAutoOpenUris = new Set<string>();
    context.subscriptions.push(
        vscode.window.tabGroups.onDidChangeTabs((event) => {
            for (const tab of event.closed) {
                const input = tab.input;
                if (input instanceof vscode.TabInputText) {
                    const key = input.uri.toString();
                    autoCheckedJsonWhileOpen.delete(key);
                    autoOpeningJsonUris.delete(key);
                }
            }
            for (const tab of event.opened) {
                const input = tab.input;
                if (input instanceof vscode.TabInputText) {
                    void tryAutoOpenBehaviorEditor(
                        input.uri,
                        autoCheckedJsonWhileOpen,
                        autoOpeningJsonUris,
                        skipNextAutoOpenUris
                    );
                }
            }
        })
    );

    // Command: build (same pipeline as desktop behavior3editor `b3util.buildProject`)
    context.subscriptions.push(
        vscode.commands.registerCommand("behavior3.build", async () => {
            await runBuild(context);
        })
    );

    /** Switch between the Behavior3 webview editor and the built-in text (JSON) editor for the same file. */
    context.subscriptions.push(
        vscode.commands.registerCommand("behavior3.toggleEditorMode", async () => {
            const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
            if (!tab) {
                return;
            }
            const input = tab.input;
            if (input instanceof vscode.TabInputTextDiff) {
                void vscode.window.showInformationMessage(
                    "Cannot switch editor mode while viewing a diff."
                );
                return;
            }
            if (
                input instanceof vscode.TabInputCustom &&
                input.viewType === TreeEditorProvider.viewType
            ) {
                skipNextAutoOpenUris.add(input.uri.toString());
                await vscode.commands.executeCommand("vscode.openWith", input.uri, "default");
                return;
            }
            if (input instanceof vscode.TabInputText) {
                const uri = input.uri;
                if (uri.scheme === "file") {
                    const p = uri.fsPath.toLowerCase();
                    if (p.endsWith(".json")) {
                        await vscode.commands.executeCommand(
                            "vscode.openWith",
                            uri,
                            TreeEditorProvider.viewType
                        );
                        return;
                    }
                }
            }
            void vscode.window.showInformationMessage(
                "Editor mode toggle applies to Behavior Tree JSON files (.json)."
            );
        })
    );

    // Command: create a new behavior3 project from template (`sample/`)
    context.subscriptions.push(
        vscode.commands.registerCommand("behavior3.createProject", async (uri?: vscode.Uri) => {
            const parentUri = uri ?? vscode.workspace.workspaceFolders?.[0]?.uri;
            if (!parentUri || parentUri.scheme !== "file") {
                vscode.window.showErrorMessage("Please open a workspace folder first.");
                return;
            }

            const projectName = await vscode.window.showInputBox({
                prompt: "Enter project folder name",
                placeHolder: "my-behavior3-project",
                validateInput: (v) => (v.trim() ? null : "Name cannot be empty"),
            });
            if (!projectName) {
                return;
            }

            const projectDir = path.join(parentUri.fsPath, projectName.trim());
            if (fs.existsSync(projectDir)) {
                void vscode.window.showErrorMessage(`Folder already exists: ${projectName.trim()}`);
                return;
            }

            try {
                // Create the minimal v2 project layout:
                // - `node-config.b3-setting` for node definitions
                // - `example.json` as the starter tree
                // - `workspace.b3-workspace` for project-level settings
                await fs.promises.mkdir(projectDir, { recursive: false });

                await fs.promises.writeFile(
                    path.join(projectDir, "node-config.b3-setting"),
                    createNodeConfigFromBuiltins(),
                    "utf-8"
                );

                await fs.promises.writeFile(
                    path.join(projectDir, "example.json"),
                    writeTree(
                        {
                            root: {
                                id: 1,
                                name: "Sequence",
                                children: [
                                    { id: 2, name: "Log", args: { message: "hello" } },
                                    { id: 3, name: "Wait", args: { time: 1 } },
                                ],
                            },
                        } as never,
                        "example"
                    ),
                    "utf-8"
                );

                await fs.promises.writeFile(
                    path.join(projectDir, "workspace.b3-workspace"),
                    stringifyJson({ settings: {} }, { indent: 2 }),
                    "utf-8"
                );

                const fileUri = vscode.Uri.file(path.join(projectDir, "example.json"));
                await vscode.commands.executeCommand(
                    "vscode.openWith",
                    fileUri,
                    TreeEditorProvider.viewType
                );
            } catch (e) {
                void vscode.window.showErrorMessage(
                    `Failed to create project: ${e instanceof Error ? e.message : e}`
                );
                return;
            }
        })
    );

    // Command: open JSON file with Behavior3 custom editor
    context.subscriptions.push(
        vscode.commands.registerCommand("behavior3.openWithEditor", async (uri?: vscode.Uri) => {
            if (!uri) {
                vscode.window.showErrorMessage("No file selected.");
                return;
            }
            await vscode.commands.executeCommand(
                "vscode.openWith",
                uri,
                TreeEditorProvider.viewType
            );
        })
    );

    // Command: create a new behavior tree JSON file
    context.subscriptions.push(
        vscode.commands.registerCommand("behavior3.createTree", async (uri?: vscode.Uri) => {
            let folderUri: vscode.Uri | undefined;
            if (uri?.scheme === "file") {
                try {
                    const stat = await vscode.workspace.fs.stat(uri);
                    folderUri =
                        stat.type === vscode.FileType.Directory
                            ? uri
                            : vscode.Uri.file(path.dirname(uri.fsPath));
                } catch {
                    folderUri = undefined;
                }
            }
            folderUri ??= vscode.workspace.workspaceFolders?.[0]?.uri;
            if (!folderUri) {
                void vscode.window.showErrorMessage("Please open a workspace folder first.");
                return;
            }

            const fileName = await vscode.window.showInputBox({
                prompt: "Enter behavior tree file name (without extension)",
                placeHolder: "my-tree",
                validateInput: (v) => {
                    if (!v.trim()) return "Name cannot be empty";
                    if (/[/\\:*?"<>|]/.test(v)) return "Name contains invalid characters";
                    return null;
                },
            });
            if (!fileName) {
                return;
            }

            const treeName = fileName.trim();
            const fileUri = vscode.Uri.file(path.join(folderUri.fsPath, `${treeName}.json`));
            if (fs.existsSync(fileUri.fsPath)) {
                void vscode.window.showErrorMessage(`File already exists: ${treeName}.json`);
                return;
            }

            const template = writeTree(
                {
                    root: {
                        id: 1,
                        name: "Sequence",
                        children: [],
                    },
                } as never,
                treeName
            );

            try {
                await fs.promises.writeFile(fileUri.fsPath, template, "utf-8");
                await vscode.commands.executeCommand(
                    "vscode.openWith",
                    fileUri,
                    TreeEditorProvider.viewType
                );
            } catch (e) {
                void vscode.window.showErrorMessage(
                    `Failed to create file: ${e instanceof Error ? e.message : e}`
                );
            }
        })
    );

    // Command: open node settings
    context.subscriptions.push(
        vscode.commands.registerCommand("behavior3.openSettings", async () => {
            const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
            if (!folder) {
                void vscode.window.showInformationMessage("Open a workspace folder first.");
                return;
            }
            const active = vscode.window.activeTextEditor?.document.uri;
            let fsPath: string | undefined;
            if (active?.scheme === "file") {
                fsPath = findB3SettingPath(
                    active,
                    vscode.workspace.getWorkspaceFolder(active)?.uri
                );
            }
            if (!fsPath) {
                const hits = await vscode.workspace.findFiles(
                    new vscode.RelativePattern(folder.fsPath, "**/*.b3-setting"),
                    null,
                    1
                );
                fsPath = hits[0]?.fsPath;
            }
            if (fsPath) {
                await vscode.window.showTextDocument(vscode.Uri.file(fsPath));
            } else {
                void vscode.window.showInformationMessage(
                    "No .b3-setting file found. Place one next to your trees or under a parent folder."
                );
            }
        })
    );
}

export function deactivate() {}

async function tryAutoOpenBehaviorEditor(
    uri: vscode.Uri,
    autoCheckedJsonWhileOpen: Set<string>,
    autoOpeningJsonUris: Set<string>,
    skipNextAutoOpenUris: Set<string>
): Promise<void> {
    if (uri.scheme !== "file") {
        return;
    }
    if (path.extname(uri.fsPath).toLowerCase() !== ".json") {
        return;
    }
    const key = uri.toString();
    if (skipNextAutoOpenUris.has(key)) {
        skipNextAutoOpenUris.delete(key);
        return;
    }
    if (autoCheckedJsonWhileOpen.has(key) || autoOpeningJsonUris.has(key)) {
        return;
    }
    autoCheckedJsonWhileOpen.add(key);
    const content = await readJsonFileText(uri);
    if (content === undefined || !isLikelyBehaviorTreeJson(content)) {
        return;
    }
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
    const settingPath = findB3SettingPath(uri, workspaceFolder?.uri);
    if (!settingPath) {
        return;
    }
    autoOpeningJsonUris.add(key);
    try {
        await closeDuplicateTextTabForUri(uri);
        await vscode.commands.executeCommand("vscode.openWith", uri, TreeEditorProvider.viewType, {
            viewColumn: vscode.ViewColumn.Active,
            preserveFocus: false,
            preview: true,
        });
    } catch {
        // Ignore openWith failures and keep default text editor.
    } finally {
        autoOpeningJsonUris.delete(key);
    }
}

async function readJsonFileText(uri: vscode.Uri): Promise<string | undefined> {
    try {
        const raw = await vscode.workspace.fs.readFile(uri);
        return Buffer.from(raw).toString("utf-8");
    } catch {
        return undefined;
    }
}

async function closeDuplicateTextTabForUri(uri: vscode.Uri): Promise<void> {
    const tabsToClose: vscode.Tab[] = [];
    for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
            const input = tab.input;
            if (input instanceof vscode.TabInputText && input.uri.toString() === uri.toString()) {
                tabsToClose.push(tab);
            }
        }
    }
    if (tabsToClose.length > 0) {
        await vscode.window.tabGroups.close(tabsToClose);
    }
}

function isLikelyBehaviorTreeJson(content: string): boolean {
    try {
        const parsed = JSON.parse(content) as {
            root?: unknown;
            vars?: unknown;
            import?: unknown;
        };
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            return false;
        }
        if (!parsed.root || typeof parsed.root !== "object" || Array.isArray(parsed.root)) {
            return false;
        }
        const root = parsed.root as Record<string, unknown>;
        const hasTreeNodeShape =
            typeof root.name === "string" ||
            Array.isArray(root.children) ||
            typeof root.path === "string" ||
            typeof root.id === "number";
        if (!hasTreeNodeShape) {
            return false;
        }
        if (parsed.vars !== undefined && !Array.isArray(parsed.vars)) {
            return false;
        }
        if (parsed.import !== undefined && !Array.isArray(parsed.import)) {
            return false;
        }
        return true;
    } catch {
        return false;
    }
}

function createNodeConfigFromBuiltins(): string {
    // Keep behavior aligned with behavior3editor's zhNodeDef():
    // instantiate Context, collect nodeDefs, sort by name, then apply doc newline normalization.
    const context = new (class extends Context {
        override async loadTree(_path: string): Promise<Node> {
            throw new Error("Not implemented.");
        }
    })();
    const defs = Object.values(context.nodeDefs).sort((a: NodeDef, b: NodeDef) =>
        a.name.localeCompare(b.name)
    );
    let content = stringifyJson(defs, { indent: 2 });
    content = content.replace(/"doc": "\\n +/g, '"doc": "');
    content = content.replace(/\\n +/g, "\\n");
    return content;
}
