import enUS from "antd/locale/en_US";
import zhCN from "antd/locale/zh_CN";
import { normalizeI18nLanguage } from "./i18n";

export const getAntdLocale = (language?: string | null) =>
    normalizeI18nLanguage(language) === "zh" ? zhCN : enUS;
