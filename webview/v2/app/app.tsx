import { App as AntdApp, ConfigProvider, Flex, Layout, Typography } from "antd";
import React, { useEffect, useLayoutEffect } from "react";
import i18n from "../../shared/misc/i18n";
import { getThemeConfig } from "../../shared/misc/theme";
import { GraphPane } from "../features/graph/graph-pane";
import { InspectorPane } from "../features/inspector/inspector-pane";
import { applyDocumentTheme } from "../shared/theme-mode";
import { GlobalHooksBridge } from "./global-hooks-bridge";
import { useDocumentStore, useRuntime, useSelectionStore, useWorkspaceStore } from "./runtime";

const { Content, Sider } = Layout;

export const App: React.FC = () => {
    const runtime = useRuntime();
    const theme = useWorkspaceStore((state) => state.settings.theme);
    const language = useWorkspaceStore((state) => state.settings.language);
    const hasDocument = useDocumentStore((state) => state.persistedTree !== null);
    const inspectorPanelWidth = useSelectionStore((state) => state.inspector.panelWidth);

    useEffect(() => {
        const off = runtime.hostAdapter.connect((message) => {
            if (message.type === "init") {
                void runtime.controller.initFromHost(message.payload);
                return;
            }
            if (message.type === "fileChanged") {
                void runtime.controller.reloadDocumentFromHost(message.content);
                return;
            }
            if (message.type === "themeChanged") {
                runtime.workspaceStore.setState((state) => {
                    if (state.settings.theme === message.theme) {
                        return state;
                    }
                    return {
                        ...state,
                        settings: {
                            ...state.settings,
                            theme: message.theme,
                        },
                    };
                });
                return;
            }
            if (message.type === "settingLoaded") {
                void runtime.controller.applyNodeDefs(message.nodeDefs);
                return;
            }
            if (message.type === "varDeclLoaded") {
                void runtime.controller.applyHostVars(message.payload);
                return;
            }
            if (message.type === "subtreeFileChanged") {
                void runtime.controller.markSubtreeChanged();
                return;
            }
            if (message.type === "buildResult") {
                runtime.hostAdapter.log(
                    message.success ? "info" : "warn",
                    `[v2] build result: ${message.message}`
                );
            }
        });

        runtime.hostAdapter.sendReady();
        return off;
    }, [runtime]);

    useLayoutEffect(() => {
        applyDocumentTheme(theme);
    }, [theme]);

    useEffect(() => {
        void i18n.changeLanguage(language);
    }, [language]);

    return (
        <ConfigProvider theme={getThemeConfig(theme)}>
            <AntdApp style={{ height: "100%" }}>
                <GlobalHooksBridge />
                <Layout className="b3-v2-shell">
                    <Layout hasSider className="b3-v2-body">
                        <Content className="b3-v2-content">
                            {hasDocument ? (
                                <GraphPane />
                            ) : (
                                <Flex className="b3-v2-loading" justify="center" align="center">
                                    <Typography.Text type="secondary">
                                        Loading V2 editor...
                                    </Typography.Text>
                                </Flex>
                            )}
                        </Content>
                        <Sider
                            width={inspectorPanelWidth}
                            className="b3-v2-sider"
                            style={{
                                flex: `0 0 ${inspectorPanelWidth}px`,
                                maxWidth: inspectorPanelWidth,
                                minWidth: inspectorPanelWidth,
                            }}
                        >
                            <InspectorPane />
                        </Sider>
                    </Layout>
                </Layout>
            </AntdApp>
        </ConfigProvider>
    );
};
