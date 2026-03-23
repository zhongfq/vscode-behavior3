import { App, ConfigProvider } from "antd";
import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import * as vscodeApi from "./vscodeApi";
import { setGlobalHooks } from "../shared/misc/hooks";
import "../shared/misc/i18n";
import i18n from "../shared/misc/i18n";
import { getThemeConfig } from "../shared/misc/theme";
import { useSetting } from "./contexts/setting-context";
import { useWorkspace } from "./contexts/workspace-context";
import { writeTree } from "../shared/misc/util";
import { Editor } from "./components/editor";
import "./components/register-node";
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
        void i18n.changeLanguage(msg.language);
        useSetting.getState().setLayout(msg.nodeLayout);
        workspace.init({
          content: msg.content,
          filePath: msg.filePath,
          workdir: msg.workdir,
          nodeDefs: msg.nodeDefs,
          checkExpr: msg.checkExpr,
          theme: msg.theme,
          allFiles: msg.allFiles ?? [],
        });
        setReady(true);
      } else if (msg.type === "fileChanged") {
        if (workspace.editor?.changed) {
          if (workspace.editor) {
            workspace.editor.alertReload = true;
          }
        } else {
          workspace.reloadContent(msg.content);
        }
      } else if (msg.type === "settingLoaded") {
        workspace.updateNodeDefs(msg.nodeDefs);
      } else if (msg.type === "varDeclLoaded") {
        workspace.applyHostVars(msg.usingVars, msg.allFiles, msg.importDecls, msg.subtreeDecls);
      } else if (msg.type === "subtreeFileChanged") {
        workspace.requestHostSubtreeRefresh();
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
                  const content = writeTree(workspace.editor.data, workspace.editor.data.name);
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
