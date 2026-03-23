import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { Context, Node, NodeDef } from "../behavior3/src/behavior3";
import { composeLoggers, createConsoleLogger, setLogger } from "../webview/shared/misc/logger";
import { runBuild } from "./build/runBuild";
import { createLogOutputChannelLogger } from "./logChannel";
import { getBehavior3OutputChannel } from "./outputChannel";
import { findB3SettingPath } from "./settingResolver";
import { TreeEditorProvider } from "./treeEditorProvider";

export function activate(context: vscode.ExtensionContext) {
  const out = getBehavior3OutputChannel();
  context.subscriptions.push(out);
  setLogger(composeLoggers(createConsoleLogger(), createLogOutputChannelLogger(out)));

  const editorProvider = new TreeEditorProvider(context.extensionUri, context);
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(TreeEditorProvider.viewType, editorProvider, {
      supportsMultipleEditorsPerDocument: false,
      webviewOptions: {
        retainContextWhenHidden: true,
      },
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
        void vscode.window.showInformationMessage("Cannot switch editor mode while viewing a diff.");
        return;
      }
      if (input instanceof vscode.TabInputCustom && input.viewType === TreeEditorProvider.viewType) {
        await vscode.commands.executeCommand("vscode.openWith", input.uri, "default");
        return;
      }
      if (input instanceof vscode.TabInputText) {
        const uri = input.uri;
        if (uri.scheme === "file") {
          const p = uri.fsPath.toLowerCase();
          if (p.endsWith(".b3tree") || p.endsWith(".json")) {
            await vscode.commands.executeCommand("vscode.openWith", uri, TreeEditorProvider.viewType);
            return;
          }
        }
      }
      void vscode.window.showInformationMessage(
        "Editor mode toggle applies to Behavior Tree files (.b3tree / .json)."
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
        // Align with desktop createProject (`behavior3editor/src/contexts/workspace-context.ts`):
        // - write `node-config.b3-setting` (node defs)
        // - write `example.json` (default example tree)
        // - write `.b3-workspace` containing `{ nodeConf, metadata }`
        await fs.promises.mkdir(projectDir, { recursive: false });

        await fs.promises.writeFile(
          path.join(projectDir, "node-config.b3-setting"),
          createNodeConfigFromBuiltins(),
          "utf-8"
        );

        await fs.promises.writeFile(
          path.join(projectDir, "example.json"),
          JSON.stringify(
            {
              name: "example",
              root: {
                id: 1,
                name: "Sequence",
                children: [
                  { id: 2, name: "Log", args: { message: "hello" } },
                  { id: 3, name: "Wait", args: { time: 1 } },
                ],
              },
            },
            null,
            2
          ),
          "utf-8"
        );

        await fs.promises.writeFile(
          path.join(projectDir, "workspace.b3-workspace"),
          JSON.stringify(
            {
              nodeConf: "node-config.b3-setting",
              metadata: [],
            },
            null,
            2
          ),
          "utf-8"
        );

        const fileUri = vscode.Uri.file(path.join(projectDir, "example.json"));
        await vscode.commands.executeCommand("vscode.openWith", fileUri, TreeEditorProvider.viewType);
      } catch (e) {
        void vscode.window.showErrorMessage(`Failed to create project: ${e instanceof Error ? e.message : e}`);
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
      await vscode.commands.executeCommand("vscode.openWith", uri, TreeEditorProvider.viewType);
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
        fsPath = findB3SettingPath(active, vscode.workspace.getWorkspaceFolder(active)?.uri);
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
          "No .b3-setting file found. Place one next to your trees or under a parent folder, or set behavior3.settingFile."
        );
      }
    })
  );
}

export function deactivate() {}

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
  let content = JSON.stringify(defs, null, 2);
  content = content.replace(/"doc": "\\n +/g, '"doc": "');
  content = content.replace(/\\n +/g, "\\n");
  return content;
}
