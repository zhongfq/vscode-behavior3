import type * as vscode from "vscode";
import type { Logger } from "../webview/shared/misc/logger";
import { formatConsoleArgs } from "./output-channel";

export function createLogOutputChannelLogger(out: vscode.LogOutputChannel): Logger {
    return {
        log: (...args: unknown[]) => {
            try {
                out.info(formatConsoleArgs(args));
            } catch {
                /* ignore */
            }
        },
        debug: (...args: unknown[]) => {
            try {
                out.debug(formatConsoleArgs(args));
            } catch {
                /* ignore */
            }
        },
        info: (...args: unknown[]) => {
            try {
                out.info(formatConsoleArgs(args));
            } catch {
                /* ignore */
            }
        },
        warn: (...args: unknown[]) => {
            try {
                out.warn(formatConsoleArgs(args));
            } catch {
                /* ignore */
            }
        },
        error: (...args: unknown[]) => {
            try {
                out.error(formatConsoleArgs(args));
            } catch {
                /* ignore */
            }
        },
    };
}
