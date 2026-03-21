import * as vscode from "vscode";
import { InspectorViewProvider } from "./inspectorViewProvider";
import { TreeEditorProvider } from "./treeEditorProvider";

export function activate(context: vscode.ExtensionContext) {
  const inspectorProvider = new InspectorViewProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(InspectorViewProvider.viewId, inspectorProvider)
  );

  const editorProvider = new TreeEditorProvider(context.extensionUri, context);
  editorProvider.setInspectorProvider(inspectorProvider);
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(TreeEditorProvider.viewType, editorProvider, {
      supportsMultipleEditorsPerDocument: false,
      webviewOptions: {
        retainContextWhenHidden: true,
      },
    })
  );

  // Command: build
  context.subscriptions.push(
    vscode.commands.registerCommand("behavior3.build", async () => {
      const outputDir = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: "Select Output Directory",
        title: "Build Behavior Tree - Select Output Directory",
      });
      if (!outputDir || outputDir.length === 0) {
        return;
      }
      vscode.window.showInformationMessage(
        `[Behavior3] Build to: ${outputDir[0].fsPath} (coming soon)`
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
      const workdir = vscode.workspace.workspaceFolders?.[0]?.uri;
      if (!workdir) {
        return;
      }
      const found = await vscode.workspace.findFiles(
        new vscode.RelativePattern(workdir.fsPath, "*.b3-setting"),
        null,
        1
      );
      if (found.length > 0) {
        await vscode.window.showTextDocument(found[0]);
      } else {
        vscode.window.showInformationMessage("No .b3-setting file found in workspace root.");
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
