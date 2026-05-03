import type { EditorToHostMessage, HostToEditorMessage } from "../../../src/types";
import {
    composeLoggers,
    createConsoleLogger,
    setLogger,
    type Logger,
} from "../../shared/misc/logger";
import type {
    HostAdapter,
    HostEvent,
    PersistedTreeModel,
    ReadFileResponse,
    RevertDocumentResponse,
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

interface PendingRequestMap {
    readFile: ReadFileResponse;
    saveSubtree: SaveSubtreeResponse;
    saveSubtreeAs: SaveSubtreeAsResponse;
    saveDocument: SaveDocumentResponse;
    revertDocument: RevertDocumentResponse;
}

type PendingRequestType = keyof PendingRequestMap;
type PendingRequest = {
    [K in PendingRequestType]: {
        type: K;
        resolve(value: PendingRequestMap[K]): void;
    };
}[PendingRequestType];

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

const registerPendingRequest = <K extends PendingRequestType>(
    type: K,
    resolve: (value: PendingRequestMap[K]) => void,
    requestId = createRequestId()
): string => {
    pendingRequests.set(requestId, {
        type,
        resolve,
    } as PendingRequest);
    return requestId;
};

const resolvePendingRequest = <K extends PendingRequestType>(
    requestId: string,
    type: K,
    value: PendingRequestMap[K]
): boolean => {
    const pending = pendingRequests.get(requestId);
    if (pending?.type !== type) {
        return false;
    }

    pendingRequests.delete(requestId);
    (pending.resolve as (resolved: PendingRequestMap[K]) => void)(value);
    return true;
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
            const dispatchHostEvent = (message: HostToEditorMessage) => {
                switch (message.type) {
                    case "readFileResult":
                        resolvePendingRequest(message.requestId, "readFile", {
                            content: message.content,
                        });
                        return;

                    case "saveSubtreeResult":
                        resolvePendingRequest(message.requestId, "saveSubtree", {
                            success: message.success,
                            error: message.error,
                        });
                        return;

                    case "saveSubtreeAsResult":
                        resolvePendingRequest(message.requestId, "saveSubtreeAs", {
                            savedPath: message.savedPath,
                            error: message.error,
                        });
                        return;

                    case "saveDocumentResult":
                        resolvePendingRequest(message.requestId, "saveDocument", {
                            success: message.success,
                            error: message.error,
                        });
                        return;

                    case "revertDocumentResult":
                        resolvePendingRequest(message.requestId, "revertDocument", {
                            success: message.success,
                            error: message.error,
                        });
                        return;

                    case "init":
                        onMessage({ type: "init", payload: normalizeHostInitMessage(message) });
                        return;

                    case "varDeclLoaded":
                        onMessage({
                            type: "varDeclLoaded",
                            payload: normalizeHostVarsMessage(message),
                        });
                        return;

                    case "fileChanged":
                        onMessage({ type: "fileChanged", content: message.content });
                        return;

                    case "documentReloaded":
                        onMessage({ type: "documentReloaded", content: message.content });
                        return;

                    case "themeChanged":
                        onMessage({ type: "themeChanged", theme: message.theme });
                        return;

                    case "subtreeFileChanged":
                        onMessage({ type: "subtreeFileChanged" });
                        return;

                    case "settingLoaded":
                        onMessage({
                            type: "settingLoaded",
                            nodeDefs: message.nodeDefs,
                            settings: message.settings,
                        });
                        return;

                    case "buildResult":
                        onMessage({
                            type: "buildResult",
                            success: message.success,
                            message: message.message,
                        });
                        return;
                }
            };

            const handler = (event: MessageEvent<HostToEditorMessage>) => {
                dispatchHostEvent(event.data);
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
                const requestId = registerPendingRequest("saveDocument", resolve);
                postMessage({ type: "saveDocument", requestId, content });
            });
        },

        revertDocument() {
            return new Promise<RevertDocumentResponse>((resolve) => {
                const requestId = registerPendingRequest("revertDocument", resolve);
                postMessage({ type: "revertDocument", requestId });
            });
        },

        readFile(path: WorkdirRelativeJsonPath, opts) {
            return new Promise<ReadFileResponse>((resolve) => {
                const requestId = registerPendingRequest("readFile", resolve);
                postMessage({
                    type: "readFile",
                    requestId,
                    path,
                    openIfSubtree: opts?.openIfSubtree,
                });
            });
        },

        saveSubtree(path: WorkdirRelativeJsonPath, content: string) {
            return new Promise<SaveSubtreeResponse>((resolve) => {
                const requestId = registerPendingRequest("saveSubtree", resolve);
                postMessage({ type: "saveSubtree", requestId, path, content });
            });
        },

        saveSubtreeAs(content: string, suggestedBaseName: string) {
            return new Promise<SaveSubtreeAsResponse>((resolve) => {
                const requestId = registerPendingRequest("saveSubtreeAs", resolve);
                postMessage({ type: "saveSubtreeAs", requestId, content, suggestedBaseName });
            });
        },

        log(level, message) {
            postMessage({ type: "webviewLog", level, message });
        },
    };
};
