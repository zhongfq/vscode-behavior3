import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import enTranslation from "../../../public/locales/en.json";
import zhTranslation from "../../../public/locales/zh.json";

declare module "i18next" {
    interface CustomTypeOptions {
        returnNull: false;
    }
}

export const supportedLanguages = ["en", "zh"] as const;
export type SupportedLanguage = (typeof supportedLanguages)[number];

export const normalizeI18nLanguage = (language?: string | null): SupportedLanguage => {
    const value = (language ?? "").toLowerCase();
    return value.startsWith("zh") ? "zh" : "en";
};

const getInitialLanguage = (): SupportedLanguage => {
    if (typeof document !== "undefined" && document.documentElement.lang) {
        return normalizeI18nLanguage(document.documentElement.lang);
    }
    if (typeof navigator !== "undefined" && navigator.language) {
        return normalizeI18nLanguage(navigator.language);
    }
    return "en";
};

i18n.use(initReactI18next).init({
    returnNull: false,
    initImmediate: false,
    lng: getInitialLanguage(),
    fallbackLng: "en",
    supportedLngs: [...supportedLanguages],
    interpolation: {
        escapeValue: false,
    },
    react: {
        useSuspense: false,
    },
    resources: {
        zh: { translation: zhTranslation },
        en: { translation: enTranslation },
    },
});

export const setI18nLanguage = async (language?: string | null): Promise<SupportedLanguage> => {
    const normalized = normalizeI18nLanguage(language);
    if (i18n.resolvedLanguage !== normalized) {
        await i18n.changeLanguage(normalized);
    }
    if (typeof document !== "undefined") {
        document.documentElement.lang = normalized === "zh" ? "zh-CN" : "en";
    }
    return normalized;
};

export default i18n;
