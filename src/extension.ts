import * as vscode from "vscode";
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

  // Command: new tree file
  context.subscriptions.push(
    vscode.commands.registerCommand("behavior3.newTree", async (uri?: vscode.Uri) => {
      const targetDir = uri ?? vscode.workspace.workspaceFolders?.[0]?.uri;
      if (!targetDir) {
        vscode.window.showErrorMessage("Please open a workspace folder first.");
        return;
      }
      const name = await vscode.window.showInputBox({
        prompt: "Enter behavior tree file name (without extension)",
        placeHolder: "my-tree",
        validateInput: (v) => (v.trim() ? null : "Name cannot be empty"),
      });
      if (!name) {
        return;
      }
      const fileUri = vscode.Uri.joinPath(targetDir, `${name.trim()}.b3tree`);
      const initialContent = JSON.stringify(
        {
          version: "1.9.0",
          name: name.trim(),
          desc: "",
          export: true,
          group: [],
          import: [],
          vars: [],
          root: { id: "1", name: "Sequence", $id: nanoid(), children: [] },
          $override: {},
          custom: {},
        },
        null,
        2
      );
      await vscode.workspace.fs.writeFile(fileUri, Buffer.from(initialContent, "utf-8"));
      await vscode.commands.executeCommand("vscode.openWith", fileUri, TreeEditorProvider.viewType);
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

function nanoid(size = 10): string {
  const chars = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let result = "";
  for (let i = 0; i < size; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}
