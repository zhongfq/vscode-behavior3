import React from "react";
import ReactDOM from "react-dom/client";
import "./style.scss";
import { App } from "./app/app";
import { createEditorRuntime, RuntimeProvider } from "./app/runtime";
import { applyDocumentTheme, detectInitialThemeMode } from "./shared/theme-mode";

const runtime = createEditorRuntime();
applyDocumentTheme(detectInitialThemeMode());

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
        <RuntimeProvider runtime={runtime}>
            <App />
        </RuntimeProvider>
    </React.StrictMode>
);
