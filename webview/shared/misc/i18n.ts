// Adapted from original: uses inline resources instead of HTTP backend
// to work reliably in VSCode webview sandbox context.
import i18n from "i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import { initReactI18next } from "react-i18next";

import enTranslation from "../../../public/locales/en.json";
import zhTranslation from "../../../public/locales/zh.json";

declare module "i18next" {
  interface CustomTypeOptions {
    returnNull: false;
  }
}

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    returnNull: false,
    lng: "zh",
    fallbackLng: "zh",
    interpolation: {
      escapeValue: false,
    },
    react: {
      useSuspense: false,
    },
    load: "languageOnly",
    detection: {
      order: ["localStorage"],
      caches: ["localStorage"],
    },
    resources: {
      zh: { translation: zhTranslation },
      en: { translation: enTranslation },
    },
  });

export default i18n;
