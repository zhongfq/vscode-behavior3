import { App as AntdApp, ConfigProvider, Flex, Layout, Typography } from "antd";
import React, { useEffect, useLayoutEffect } from "react";
import { useTranslation } from "react-i18next";
import { getAntdLocale } from "../shared/misc/antd-locale";
import i18n, { setI18nLanguage } from "../shared/misc/i18n";
import { getThemeConfig } from "../shared/misc/theme";
import { GraphPane } from "../features/graph/graph-pane";
import { InspectorPane } from "../features/inspector/inspector-pane";
import { applyDocumentTheme } from "../shared/theme-mode";
import { GlobalHooksBridge } from "./global-hooks-bridge";
import { useDocumentStore, useRuntime, useSelectionStore, useWorkspaceStore } from "./runtime";

const { Content, Sider } = Layout;

const AppShell: React.FC = () => {
    const runtime = useRuntime();
    const { message: messageApi } = AntdApp.useApp();
    const { t } = useTranslation();
    const theme = useWorkspaceStore((state) => state.settings.theme);
    const language = useWorkspaceStore((state) => state.settings.language);
    const hasDocument = useDocumentStore((state) => state.persistedTree !== null);
    const inspectorPanelWidth = useSelectionStore((state) => state.inspector.panelWidth);

    useEffect(() => {
        const off = runtime.hostAdapter.connect((message) => {
            if (message.type === "init") {
                void (async () => {
                    await setI18nLanguage(message.payload.settings.language);
                    await runtime.controller.initFromHost(message.payload);
                })();
                return;
            }
            if (message.type === "fileChanged") {
                void runtime.controller.reloadDocumentFromHost(message.content);
                return;
            }
            if (message.type === "themeChanged") {
                runtime.workspaceStore.setState((state) => ({
                    ...state,
                    settings: {
                        ...state.settings,
                        theme: message.theme,
                    },
                    themeVersion: state.themeVersion + 1,
                }));
                void runtime.controller.refreshGraph({ preserveSelection: true });
                return;
            }
            if (message.type === "settingLoaded") {
                void (async () => {
                    if (message.settings?.language) {
                        await setI18nLanguage(message.settings.language);
                    }
                    runtime.workspaceStore.setState((state) => ({
                        ...state,
                        settings: {
                            ...state.settings,
                            ...(message.settings ?? {}),
                        },
                    }));
                    await runtime.controller.applyNodeDefs(message.nodeDefs);
                })();
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
                const text =
                    message.message.trim() ||
                    i18n.t(message.success ? "build.success" : "build.failed");
                void (message.success ? messageApi.success(text) : messageApi.error(text));
                runtime.hostAdapter.log(
                    message.success ? "info" : "warn",
                    `[v2] build result: ${message.message}`
                );
            }
        });

        runtime.hostAdapter.sendReady();
        return off;
    }, [messageApi, runtime]);

    useLayoutEffect(() => {
        applyDocumentTheme(theme);
    }, [theme]);

    useEffect(() => {
        void setI18nLanguage(language);
    }, [language]);

    return (
        <Layout className="b3-v2-shell">
            <Layout hasSider className="b3-v2-body">
                <Content className="b3-v2-content">
                    {hasDocument ? (
                        <GraphPane />
                    ) : (
                        <Flex className="b3-v2-loading" justify="center" align="center">
                            <Typography.Text type="secondary">
                                {t("editor.loading")}
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
    );
};

export const App: React.FC = () => {
    const theme = useWorkspaceStore((state) => state.settings.theme);
    const language = useWorkspaceStore((state) => state.settings.language);
    const themeVersion = useWorkspaceStore((state) => state.themeVersion);

    return (
        <ConfigProvider locale={getAntdLocale(language)} theme={getThemeConfig(theme, themeVersion)}>
            <AntdApp style={{ height: "100%" }}>
                <GlobalHooksBridge />
                <AppShell />
            </AntdApp>
        </ConfigProvider>
    );
};
