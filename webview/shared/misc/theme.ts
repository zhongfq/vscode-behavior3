import { ThemeConfig, theme } from "antd";

type ThemeMode = "dark" | "light";

type ThemePalette = {
    appBg: string;
    panelBg: string;
    elevatedBg: string;
    inputBg: string;
    inputBorder: string;
    panelBorder: string;
    text: string;
    textSecondary: string;
    textTertiary: string;
    textLink: string;
    focusBorder: string;
    buttonBg: string;
    buttonFg: string;
    buttonHoverBg: string;
    listHoverBg: string;
    listSelectedBg: string;
    listSelectedFg: string;
    error: string;
    warning: string;
};

const readCssVariable = (name: string): string | undefined => {
    if (typeof document === "undefined") {
        return undefined;
    }

    for (const element of [document.body, document.documentElement]) {
        if (!element) {
            continue;
        }

        const value = getComputedStyle(element).getPropertyValue(name).trim();
        if (value) {
            return value;
        }
    }

    return undefined;
};

const resolveCssVariable = (names: string[], fallback: string): string => {
    for (const name of names) {
        const value = readCssVariable(name);
        if (value) {
            return value;
        }
    }

    return fallback;
};

const getThemePalette = (mode: ThemeMode): ThemePalette => {
    const isDark = mode === "dark";

    return {
        appBg: resolveCssVariable(["--vscode-editor-background"], isDark ? "#0d1117" : "#ffffff"),
        panelBg: resolveCssVariable(
            ["--vscode-sideBar-background", "--vscode-editor-background"],
            isDark ? "#0d1117" : "#ffffff"
        ),
        elevatedBg: resolveCssVariable(
            [
                "--vscode-editorWidget-background",
                "--vscode-sideBarSectionHeader-background",
                "--vscode-sideBar-background",
            ],
            isDark ? "#161b22" : "#f6f8fa"
        ),
        inputBg: resolveCssVariable(
            [
                "--vscode-input-background",
                "--vscode-editorWidget-background",
                "--vscode-sideBar-background",
            ],
            isDark ? "#161b22" : "#ffffff"
        ),
        inputBorder: resolveCssVariable(
            ["--vscode-input-border", "--vscode-panel-border", "--vscode-sideBar-border"],
            isDark ? "#30363d" : "#d0d7de"
        ),
        panelBorder: resolveCssVariable(
            ["--vscode-sideBar-border", "--vscode-panel-border", "--vscode-editorWidget-border"],
            isDark ? "#30363d" : "#d0d7de"
        ),
        text: resolveCssVariable(["--vscode-foreground"], isDark ? "#e6edf3" : "#1f2328"),
        textSecondary: resolveCssVariable(
            ["--vscode-descriptionForeground", "--vscode-foreground"],
            isDark ? "#8b949e" : "#57606a"
        ),
        textTertiary: resolveCssVariable(
            ["--vscode-disabledForeground", "--vscode-descriptionForeground"],
            isDark ? "#6e7681" : "#6e7781"
        ),
        textLink: resolveCssVariable(
            ["--vscode-textLink-foreground", "--vscode-focusBorder", "--vscode-button-background"],
            isDark ? "#58a6ff" : "#0969da"
        ),
        focusBorder: resolveCssVariable(
            ["--vscode-focusBorder", "--vscode-textLink-foreground", "--vscode-button-background"],
            isDark ? "#2f81f7" : "#0969da"
        ),
        buttonBg: resolveCssVariable(
            ["--vscode-button-background", "--vscode-textLink-foreground"],
            isDark ? "#238636" : "#0969da"
        ),
        buttonFg: resolveCssVariable(
            ["--vscode-button-foreground", "--vscode-editor-background"],
            "#ffffff"
        ),
        buttonHoverBg: resolveCssVariable(
            ["--vscode-button-hoverBackground", "--vscode-button-background"],
            isDark ? "#2ea043" : "#1f6feb"
        ),
        listHoverBg: resolveCssVariable(
            [
                "--vscode-list-hoverBackground",
                "--vscode-toolbar-hoverBackground",
                "--vscode-editorHoverWidget-background",
            ],
            isDark ? "#30363d" : "#eaeef2"
        ),
        listSelectedBg: resolveCssVariable(
            [
                "--vscode-list-activeSelectionBackground",
                "--vscode-list-inactiveSelectionBackground",
                "--vscode-button-background",
            ],
            isDark ? "#2f81f7" : "#0969da"
        ),
        listSelectedFg: resolveCssVariable(
            ["--vscode-list-activeSelectionForeground", "--vscode-button-foreground", "--vscode-foreground"],
            "#ffffff"
        ),
        error: resolveCssVariable(
            ["--vscode-errorForeground", "--vscode-inputValidation-errorForeground"],
            isDark ? "#f85149" : "#cf222e"
        ),
        warning: resolveCssVariable(
            [
                "--vscode-editorWarning-foreground",
                "--vscode-problemsWarningIcon-foreground",
                "--vscode-notificationsWarningIcon-foreground",
            ],
            isDark ? "#d29922" : "#9a6700"
        ),
    };
};

const getInputShadow = (color: string) => `0 0 0 1px ${color}`;

const buildThemeConfig = (mode: ThemeMode): ThemeConfig => {
    const palette = getThemePalette(mode);

    return {
        cssVar: {},
        algorithm: mode === "dark" ? theme.darkAlgorithm : theme.defaultAlgorithm,
        token: {
            colorPrimary: palette.buttonBg,
            colorInfo: palette.buttonBg,
            colorLink: palette.textLink,
            colorError: palette.error,
            colorWarning: palette.warning,
            colorBgBase: palette.appBg,
            colorBgLayout: palette.appBg,
            colorBgContainer: palette.panelBg,
            colorBgElevated: palette.elevatedBg,
            colorBorder: palette.panelBorder,
            colorBorderSecondary: palette.panelBorder,
            colorText: palette.text,
            colorTextSecondary: palette.textSecondary,
            colorTextTertiary: palette.textTertiary,
            colorTextPlaceholder: palette.textTertiary,
            colorFillTertiary: palette.listHoverBg,
            boxShadowSecondary: "none",
            borderRadius: 4,
        },
        components: {
            Tree: {
                borderRadius: 0,
                colorBgContainer: palette.appBg,
            },
            Tabs: {
                horizontalMargin: "0",
            },
            Layout: {
                bodyBg: palette.appBg,
                headerBg: palette.panelBg,
                headerColor: palette.text,
                siderBg: palette.panelBg,
                lightSiderBg: palette.panelBg,
                lightTriggerBg: palette.panelBg,
                lightTriggerColor: palette.text,
            },
            Input: {
                addonBg: palette.elevatedBg,
                activeBg: palette.inputBg,
                hoverBg: palette.inputBg,
                hoverBorderColor: palette.focusBorder,
                activeBorderColor: palette.focusBorder,
                activeShadow: getInputShadow(palette.focusBorder),
                errorActiveShadow: getInputShadow(palette.error),
                warningActiveShadow: getInputShadow(palette.warning),
            },
            Select: {
                selectorBg: palette.inputBg,
                clearBg: palette.inputBg,
                hoverBorderColor: palette.focusBorder,
                activeBorderColor: palette.focusBorder,
                activeOutlineColor: palette.focusBorder,
                optionSelectedBg: palette.listSelectedBg,
                optionSelectedColor: palette.listSelectedFg,
                optionSelectedFontWeight: 500,
                optionActiveBg: palette.listHoverBg,
                multipleItemBg: palette.listHoverBg,
                multipleItemBorderColor: palette.panelBorder,
                multipleSelectorBgDisabled: palette.elevatedBg,
                multipleItemColorDisabled: palette.textTertiary,
                multipleItemBorderColorDisabled: palette.panelBorder,
            },
            Button: {
                defaultShadow: "none",
                primaryShadow: "none",
                dangerShadow: "none",
                defaultBg: palette.panelBg,
                defaultColor: palette.text,
                defaultBorderColor: palette.panelBorder,
                defaultHoverBg: palette.listHoverBg,
                defaultHoverColor: palette.text,
                defaultHoverBorderColor: palette.focusBorder,
                defaultActiveBg: palette.listHoverBg,
                defaultActiveColor: palette.text,
                defaultActiveBorderColor: palette.focusBorder,
                primaryColor: palette.buttonFg,
                solidTextColor: palette.buttonFg,
                textTextColor: palette.text,
                textTextHoverColor: palette.text,
                textTextActiveColor: palette.text,
                textHoverBg: palette.listHoverBg,
                linkHoverBg: "transparent",
            },
            Form: {
                labelColor: palette.textSecondary,
                labelRequiredMarkColor: palette.error,
            },
            Dropdown: {
                motionDurationMid: "0.1s",
            },
        },
    };
};

export const getThemeConfig = (mode: ThemeMode, _themeVersion = 0): ThemeConfig => {
    return buildThemeConfig(mode);
};
