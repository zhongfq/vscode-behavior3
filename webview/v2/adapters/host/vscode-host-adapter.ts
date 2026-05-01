import type { EditorToHostMessage, HostToEditorMessage } from "../../../../src/types";
import {
    composeLoggers,
    createConsoleLogger,
    setLogger,
    type Logger,
} from "../../../shared/misc/logger";
import type {
    HostAdapter,
    HostEvent,
    PersistedTreeModel,
    ReadFileResponse,
    SaveDocumentResponse,
    SaveSubtreeAsResponse,
    SaveSubtreeResponse,
    WorkdirRelativeJsonPath,
} from "../../shared/contracts";
import {
    createRequestId,
    normalizeHostInitMessage,
    normalizeHostVarsMessage,
} from "../../shared/protocol";

declare function acquireVsCodeApi(): {
    postMessage(message: EditorToHostMessage): void;
    getState(): unknown;
    setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();

type PendingRequest =
    | { type: "readFile"; resolve(value: ReadFileResponse): void }
    | { type: "saveSubtree"; resolve(value: SaveSubtreeResponse): void }
    | { type: "saveSubtreeAs"; resolve(value: SaveSubtreeAsResponse): void }
    | { type: "saveDocument"; resolve(value: SaveDocumentResponse): void };

const pendingRequests = new Map<string, PendingRequest>();

const formatLogArg = (value: unknown): string => {
    if (typeof value === "string") {
        return value;
    }
    if (value instanceof Error) {
        return value.stack ?? value.message;
    }
    try {
        if (value && typeof value === "object") {
            return JSON.stringify(value);
        }
    } catch {
        // ignore serialization failure
    }
    return String(value);
};

const postMessage = (message: EditorToHostMessage) => {
    vscode.postMessage(message);
};

const createForwardLogger = (): Logger => {
    const forward =
        (level: "log" | "info" | "warn" | "error" | "debug") =>
        (...args: unknown[]) => {
            postMessage({
                type: "webviewLog",
                level,
                message: args.map(formatLogArg).join(" "),
            });
        };

    return {
        log: forward("log"),
        info: forward("info"),
        warn: forward("warn"),
        error: forward("error"),
        debug: forward("debug"),
    };
};

setLogger(composeLoggers(createConsoleLogger(), createForwardLogger()));

export const createVsCodeHostAdapter = (): HostAdapter => {
    return {
        connect(onMessage) {
            const handler = (event: MessageEvent<HostToEditorMessage>) => {
                const message = event.data;

                if (message.type === "readFileResult") {
                    const pending = pendingRequests.get(message.requestId);
                    if (pending?.type === "readFile") {
                        pendingRequests.delete(message.requestId);
                        pending.resolve({ content: message.content });
                    }
                    return;
                }

                if (message.type === "saveSubtreeResult") {
                    const pending = pendingRequests.get(message.requestId);
                    if (pending?.type === "saveSubtree") {
                        pendingRequests.delete(message.requestId);
                        pending.resolve({ success: message.success, error: message.error });
                    }
                    return;
                }

                if (message.type === "saveSubtreeAsResult") {
                    const pending = pendingRequests.get(message.requestId);
                    if (pending?.type === "saveSubtreeAs") {
                        pendingRequests.delete(message.requestId);
                        pending.resolve({ savedPath: message.savedPath, error: message.error });
                    }
                    return;
                }

                if (message.type === "saveDocumentResult") {
                    const pending = pendingRequests.get(message.requestId);
                    if (pending?.type === "saveDocument") {
                        pendingRequests.delete(message.requestId);
                        pending.resolve({ success: message.success, error: message.error });
                    }
                    return;
                }

                if (message.type === "init") {
                    onMessage({ type: "init", payload: normalizeHostInitMessage(message) });
                    return;
                }

                if (message.type === "varDeclLoaded") {
                    onMessage({
                        type: "varDeclLoaded",
                        payload: normalizeHostVarsMessage(message),
                    });
                    return;
                }

                if (message.type === "fileChanged") {
                    onMessage({ type: "fileChanged", content: message.content });
                    return;
                }

                if (message.type === "themeChanged") {
                    onMessage({ type: "themeChanged", theme: message.theme });
                    return;
                }

                if (message.type === "subtreeFileChanged") {
                    onMessage({ type: "subtreeFileChanged" });
                    return;
                }

                if (message.type === "settingLoaded") {
                    onMessage({
                        type: "settingLoaded",
                        nodeDefs: message.nodeDefs,
                        settings: message.settings,
                    });
                    return;
                }

                if (message.type === "buildResult") {
                    onMessage({
                        type: "buildResult",
                        success: message.success,
                        message: message.message,
                    });
                }
            };

            window.addEventListener("message", handler);
            return () => window.removeEventListener("message", handler);
        },

        sendReady() {
            postMessage({ type: "ready" });
        },

        sendUpdate(content) {
            postMessage({ type: "update", content });
        },

        sendTreeSelected(tree: PersistedTreeModel) {
            postMessage({ type: "treeSelected", tree });
        },

        sendRequestSetting() {
            postMessage({ type: "requestSetting" });
        },

        sendBuild() {
            postMessage({ type: "build" });
        },

        saveDocument(content: string) {
            return new Promise<SaveDocumentResponse>((resolve) => {
                const requestId = createRequestId();
                pendingRequests.set(requestId, { type: "saveDocument", resolve });
                postMessage({ type: "saveDocument", requestId, content });
            });
        },

        readFile(path: WorkdirRelativeJsonPath, opts) {
            return new Promise<ReadFileResponse>((resolve) => {
                const requestId = opts?.openIfSubtree ? "open-subtree" : createRequestId();
                pendingRequests.set(requestId, { type: "readFile", resolve });
                postMessage({ type: "readFile", requestId, path });
            });
        },

        saveSubtree(path: WorkdirRelativeJsonPath, content: string) {
            return new Promise<SaveSubtreeResponse>((resolve) => {
                const requestId = createRequestId();
                pendingRequests.set(requestId, { type: "saveSubtree", resolve });
                postMessage({ type: "saveSubtree", requestId, path, content });
            });
        },

        saveSubtreeAs(content: string, suggestedBaseName: string) {
            return new Promise<SaveSubtreeAsResponse>((resolve) => {
                const requestId = createRequestId();
                pendingRequests.set(requestId, { type: "saveSubtreeAs", resolve });
                postMessage({ type: "saveSubtreeAs", requestId, content, suggestedBaseName });
            });
        },

        log(level, message) {
            postMessage({ type: "webviewLog", level, message });
        },
    };
};
