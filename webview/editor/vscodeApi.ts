/**
 * Bridge between the Editor Webview and the VSCode Extension Host.
 * The `acquireVsCodeApi()` function is injected by VSCode into the webview context.
 */
import type { EditorToHostMessage, HostToEditorMessage } from "../../src/types";
import { composeLoggers, createConsoleLogger, setLogger, type Logger } from "../shared/misc/logger";

declare function acquireVsCodeApi(): {
  postMessage(message: EditorToHostMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();

/** Send a message to the extension host */
export const postMessage = (msg: EditorToHostMessage) => {
  vscode.postMessage(msg);
};

function formatWebviewConsoleArg(a: unknown): string {
  if (typeof a === "string") {
    return a;
  }
  if (a instanceof Error) {
    return a.stack ?? a.message;
  }
  try {
    if (typeof a === "object" && a !== null) {
      return JSON.stringify(a);
    }
  } catch {
    /* ignore */
  }
  return String(a);
}

function createWebviewForwardLogger(post: (msg: EditorToHostMessage) => void): Logger {
  const forward =
    (level: "log" | "info" | "warn" | "error" | "debug") =>
    (...args: unknown[]) => {
      try {
        const message = args.map(formatWebviewConsoleArg).join(" ");
        post({ type: "webviewLog", level, message });
      } catch {
        /* ignore bridge errors */
      }
    };
  return {
    log: forward("log"),
    info: forward("info"),
    warn: forward("warn"),
    error: forward("error"),
    debug: forward("debug"),
  };
}

setLogger(composeLoggers(createConsoleLogger(), createWebviewForwardLogger(postMessage)));

type MessageHandler = (msg: HostToEditorMessage) => void;
const handlers: MessageHandler[] = [];

window.addEventListener("message", (event) => {
  const msg = event.data as HostToEditorMessage;
  for (const handler of handlers) {
    handler(msg);
  }
});

/** Register a handler for messages from the extension host */
export const onMessage = (handler: MessageHandler): (() => void) => {
  handlers.push(handler);
  return () => {
    const idx = handlers.indexOf(handler);
    if (idx >= 0) {
      handlers.splice(idx, 1);
    }
  };
};

/** Persist minimal UI state across webview lifecycle (when panel is hidden) */
export const getState = () => vscode.getState() as Record<string, unknown> | null;
export const setState = (state: Record<string, unknown>) => vscode.setState(state);

/** Request a file from the extension host (returns a Promise) */
export const readFile = (filePath: string): Promise<string | null> => {
  return new Promise((resolve) => {
    const requestId = Math.random().toString(36).slice(2);
    const off = onMessage((msg) => {
      if (msg.type === "readFileResult" && msg.requestId === requestId) {
        off();
        resolve(msg.content);
      }
    });
    postMessage({ type: "readFile", requestId, path: filePath });
  });
};

/** Save a subtree file via extension host */
export const saveSubtree = (filePath: string, content: string): Promise<void> => {
  return new Promise((resolve, reject) => {
    const requestId = Math.random().toString(36).slice(2);
    const timer = window.setTimeout(() => {
      off();
      reject(new Error("Save subtree timed out"));
    }, 15000);
    const off = onMessage((msg) => {
      if (msg.type === "saveSubtreeResult" && msg.requestId === requestId) {
        off();
        window.clearTimeout(timer);
        if (msg.success) {
          resolve();
          return;
        }
        reject(new Error(msg.error ?? "Failed to save subtree"));
      }
    });
    postMessage({ type: "saveSubtree", requestId, path: filePath, content });
  });
};

/** Pick save path in the host and write subtree JSON; returns relative path under workdir or null if cancelled / failed */
export const saveSubtreeAs = (content: string, suggestedBaseName: string): Promise<string | null> => {
  return new Promise((resolve) => {
    const requestId = Math.random().toString(36).slice(2);
    const off = onMessage((msg) => {
      if (msg.type === "saveSubtreeAsResult" && msg.requestId === requestId) {
        off();
        resolve(msg.savedPath);
      }
    });
    postMessage({ type: "saveSubtreeAs", requestId, content, suggestedBaseName });
  });
};
