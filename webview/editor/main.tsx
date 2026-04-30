import { App, ConfigProvider } from "antd";
import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { useTranslation } from "react-i18next";
import * as vscodeApi from "./vscodeApi";
import { setGlobalHooks } from "../shared/misc/hooks";
import "../shared/misc/i18n";
import { getAntdLocale } from "../shared/misc/antd-locale";
import { setI18nLanguage } from "../shared/misc/i18n";
import { getThemeConfig } from "../shared/misc/theme";
import { detectInitialThemeMode, useWorkspace } from "./contexts/workspace-context";
import { writeTree } from "../shared/misc/util";
import { Editor } from "./components/editor";
import "./components/register-node";
import "./style.scss";

const bootTheme = detectInitialThemeMode();
document.documentElement.setAttribute("data-theme", bootTheme);
document.body.setAttribute("data-theme", bootTheme);

const GlobalHooksBridge = () => {
    setGlobalHooks();
    return null;
};

const EditorApp = () => {
    const [ready, setReady] = useState(false);
    const workspace = useWorkspace();
    const { t } = useTranslation();

    useEffect(() => {
        document.documentElement.setAttribute("data-theme", workspace.theme);
        document.body.setAttribute("data-theme", workspace.theme);
    }, [workspace.theme]);

    useEffect(() => {
        const off = vscodeApi.onMessage((msg) => {
            if (msg.type === "init") {
                void (async () => {
                    await setI18nLanguage(msg.language);
                    workspace.init({
                        content: msg.content,
                        filePath: msg.filePath,
                        workdir: msg.workdir,
                        nodeDefs: msg.nodeDefs,
                        allFiles: msg.allFiles ?? [],
                        settings: {
                            subtreeEditable: msg.subtreeEditable ?? true,
                            theme: msg.theme,
                            checkExpr: msg.checkExpr,
                            lang: msg.language,
                            nodeColors: msg.nodeColors,
                        },
                    });
                    setReady(true);
                })();
            } else if (msg.type === "fileChanged") {
                if (workspace.editor?.changed) {
                    if (workspace.editor) {
                        workspace.editor.alertReload = true;
                    }
                } else {
                    workspace.reloadContent(msg.content);
                }
            } else if (msg.type === "settingLoaded") {
                if (msg.settings) {
                    const current = useWorkspace.getState();
                    void setI18nLanguage(msg.settings.language);
                    workspace.updateSettings({
                        checkExpr: msg.settings.checkExpr ?? current.checkExpr,
                        subtreeEditable: msg.settings.subtreeEditable ?? current.subtreeEditable,
                        lang: msg.settings.language ?? current.settings.lang,
                        theme: current.theme,
                        nodeColors: msg.settings.nodeColors ?? current.settings.nodeColors,
                    });
                }
                workspace.updateNodeDefs(msg.nodeDefs);
            } else if (msg.type === "varDeclLoaded") {
                workspace.applyHostVars(
                    msg.usingVars,
                    msg.allFiles,
                    msg.importDecls,
                    msg.subtreeDecls
                );
            } else if (msg.type === "subtreeFileChanged") {
                workspace.requestHostSubtreeRefresh();
            }
        });

        // Tell the extension host we are ready
        vscodeApi.postMessage({ type: "ready" });

        return off;
    }, []);

    const theme = getThemeConfig(workspace.theme);
    const language = workspace.settings.lang;

    return (
        <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column" }}>
            <ConfigProvider locale={getAntdLocale(language)} theme={theme}>
                <App style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
                    <GlobalHooksBridge />
                    {ready && workspace.editor ? (
                        <Editor
                            data={workspace.editor}
                            onChange={() => {
                                if (workspace.editor) {
                                    const content = writeTree(
                                        workspace.editor.data,
                                        workspace.editor.data.name
                                    );
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
                                color: "var(--b3-text-muted)",
                                fontSize: 14,
                            }}
                        >
                            {t("editor.loading")}
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
