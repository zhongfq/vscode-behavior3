import * as vscode from "vscode";

let channel: vscode.LogOutputChannel | undefined;

/** Single Output channel: webview console + extension build / diagnostics. */
export function getBehavior3OutputChannel(): vscode.LogOutputChannel {
    if (!channel) {
        channel = vscode.window.createOutputChannel("Behavior3", { log: true });
    }
    return channel;
}

/** Format `console.log(a, b)` style arguments for a single line. */
export function formatConsoleArgs(args: unknown[]): string {
    return args.map(formatOneArg).join(" ");
}

function formatOneArg(a: unknown): string {
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
        /* fall through */
    }
    return String(a);
}
