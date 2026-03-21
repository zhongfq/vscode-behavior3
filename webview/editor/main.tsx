import { App, ConfigProvider } from "antd";
import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { setGlobalHooks } from "@shared/misc/hooks";
import "@shared/misc/i18n";
import { getThemeConfig } from "@shared/misc/theme";
import { useWorkspace } from "./contexts/workspace-context";
import { Editor } from "./components/editor";
import "./components/register-node";
import * as vscodeApi from "./vscodeApi";
import "./style.scss";

const GlobalHooksBridge = () => {
  setGlobalHooks();
  return null;
};

const EditorApp = () => {
  const [ready, setReady] = useState(false);
  const workspace = useWorkspace();

  useEffect(() => {
    const off = vscodeApi.onMessage((msg) => {
      if (msg.type === "init") {
        workspace.init({
          content: msg.content,
          filePath: msg.filePath,
          workdir: msg.workdir,
          nodeDefs: msg.nodeDefs,
          checkExpr: msg.checkExpr,
          theme: msg.theme,
        });
        setReady(true);
      } else if (msg.type === "fileChanged") {
        if (workspace.editor?.changed) {
          // Mark as needing reload
          if (workspace.editor) {
            workspace.editor.alertReload = true;
          }
        } else {
          workspace.reloadContent(msg.content);
        }
      } else if (msg.type === "settingLoaded") {
        workspace.updateNodeDefs(msg.nodeDefs);
      } else if (msg.type === "propertyChanged") {
        workspace.editor?.dispatch?.("updateNode", {
          data: { id: msg.nodeId, ...msg.data },
          prefix: workspace.editor.data.prefix,
          disabled: false,
        });
      } else if (msg.type === "treePropertyChanged") {
        workspace.editor?.dispatch?.("updateTree", msg.data);
      } else if (msg.type === "requestTreeSelection") {
        // Inspector panel just loaded — re-send current tree selection
        const editor = workspace.editor;
        if (editor) {
          vscodeApi.postMessage({ type: "treeSelected", tree: editor.data });
        }
      } else if (msg.type === "varDeclLoaded") {
        // Host has computed the full usingVars (including import/subtree files)
        workspace.applyHostVars(msg.usingVars);
      }
    });

    // Tell the extension host we are ready
    vscodeApi.postMessage({ type: "ready" });

    return off;
  }, []);

  const theme = getThemeConfig(workspace.theme);

  return (
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column" }}>
      <ConfigProvider theme={theme}>
        <App style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
          <GlobalHooksBridge />
          {ready && workspace.editor ? (
            <Editor
              data={workspace.editor}
              onChange={() => {
                if (workspace.editor) {
                  const content = JSON.stringify(workspace.editor.data, null, 2);
                  vscodeApi.postMessage({ type: "update", content });
                }
              }}
              style={{ flex: 1, minHeight: 0 }}
            />
          ) : (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flex: 1,
                color: "#666",
                fontSize: 14,
              }}
            >
              Loading...
            </div>
          )}
        </App>
      </ConfigProvider>
    </div>
  );
};

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <EditorApp />
  </React.StrictMode>
);
