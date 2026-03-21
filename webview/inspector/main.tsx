import { App, ConfigProvider } from "antd";
import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { NodeDef, TreeData, NodeData, VarDecl } from "@shared/misc/b3type";
import { setGlobalHooks } from "@shared/misc/hooks";
import "@shared/misc/i18n";
import { getThemeConfig } from "@shared/misc/theme";
import { Inspector, InspectorState } from "./components/inspector";
import * as vscodeApi from "./vscodeApi";
import "./style.scss";

const GlobalHooksBridge = () => {
  setGlobalHooks();
  return null;
};

const InspectorApp = () => {
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [state, setState] = useState<InspectorState>({ kind: "empty" });

  useEffect(() => {
    const off = vscodeApi.onMessage((msg) => {
      if (msg.type === "nodeSelected") {
        if (msg.node == null) {
          setState({ kind: "empty" });
          return;
        }
        setState({
          kind: "node",
          node: msg.node as NodeData,
          nodeDefs: msg.nodeDefs as NodeDef[],
          editingTree: (msg.editingTree as TreeData) ?? null,
          workdir: msg.workdir,
          checkExpr: msg.checkExpr,
          allFiles: msg.allFiles ?? [],
          usingVars: (msg.usingVars as Record<string, { name: string; desc: string }>) ?? null,
          groupDefs: msg.groupDefs ?? [],
        });
      } else if (msg.type === "treeSelected") {
        if (msg.tree == null) {
          setState({ kind: "empty" });
          return;
        }
        setState({
          kind: "tree",
          tree: msg.tree as TreeData,
          nodeDefs: msg.nodeDefs as NodeDef[],
          workdir: msg.workdir,
          checkExpr: msg.checkExpr,
          allFiles: msg.allFiles ?? [],
          usingVars: (msg.usingVars as Record<string, { name: string; desc: string }>) ?? null,
          groupDefs: msg.groupDefs ?? [],
        });
      } else if (msg.type === "theme") {
        setTheme(msg.value);
      }
    });

    vscodeApi.postMessage({ type: "ready" });

    return off;
  }, []);

  const themeConfig = getThemeConfig(theme);

  return (
    <ConfigProvider theme={themeConfig}>
      <App>
        <GlobalHooksBridge />
        <Inspector state={state} />
      </App>
    </ConfigProvider>
  );
};

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <InspectorApp />
  </React.StrictMode>
);
