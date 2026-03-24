/**
 * Shared message protocol types between Extension Host and Webview.
 */

import type { NodeDef } from "../behavior3/src/behavior3/node";
import type { NodeLayout } from "../webview/shared/misc/b3type";

export type { NodeDef };

// ─── Editor Webview → Extension Host ────────────────────────────────────────

export type EditorToHostMessage =
  | { type: "ready" }
  | { type: "update"; content: string }
  | { type: "treeSelected"; tree: unknown }
  | { type: "requestSetting" }
  | { type: "build" }
  | { type: "readFile"; requestId: string; path: string }
  | { type: "saveSubtree"; requestId: string; path: string; content: string }
  /** Right-click → Save as subtree: pick path under workdir and write JSON from webview. */
  | { type: "saveSubtreeAs"; requestId: string; content: string; suggestedBaseName: string }
  /** Forward webview `console.*` to extension Output panel. */
  | { type: "webviewLog"; level: "log" | "info" | "warn" | "error" | "debug"; message: string };

// ─── Extension Host → Editor Webview ────────────────────────────────────────

export type HostToEditorMessage =
  | {
      type: "init";
      content: string;
      filePath: string;
      workdir: string;
      nodeDefs: NodeDef[];
      checkExpr: boolean;
      language: "zh" | "en";
      nodeLayout: NodeLayout;
      theme: "dark" | "light";
      allFiles: string[];
    }
  | { type: "fileChanged"; content: string }
  /** A referenced subtree file was saved or edited; parent canvas should reload subtree data. */
  | { type: "subtreeFileChanged" }
  | { type: "settingLoaded"; nodeDefs: NodeDef[] }
  | { type: "buildResult"; success: boolean; message: string }
  | { type: "readFileResult"; requestId: string; content: string | null }
  | {
      type: "saveSubtreeResult";
      requestId: string;
      success: boolean;
      error?: string;
    }
  | {
      type: "saveSubtreeAsResult";
      requestId: string;
      savedPath: string | null;
      error?: string;
    }
  | {
      type: "varDeclLoaded";
      usingVars: Array<{ name: string; desc: string }>;
      allFiles?: string[];
      importDecls?: Array<{ path: string; vars: Array<{ name: string; desc: string }> }>;
      subtreeDecls?: Array<{ path: string; vars: Array<{ name: string; desc: string }> }>;
    };
