/**
 * Shared message protocol types between Extension Host and Webview.
 */

export interface NodeDef {
  name: string;
  type: string;
  desc?: string;
  doc?: string;
  args?: Array<{
    name: string;
    type: string;
    desc?: string;
    default?: unknown;
    options?: unknown;
    optional?: boolean;
  }>;
  input?: string[];
  output?: string[];
  children?: number;
}

// ─── Editor Webview → Extension Host ────────────────────────────────────────

export type EditorToHostMessage =
  | { type: "ready" }
  | { type: "update"; content: string }
  | { type: "nodeSelected"; node: unknown | null; tree: unknown | null }
  | { type: "treeSelected"; tree: unknown }
  | { type: "requestSetting" }
  | { type: "build" }
  | { type: "readFile"; requestId: string; path: string }
  | { type: "saveSubtree"; requestId: string; path: string; content: string };

// ─── Extension Host → Editor Webview ────────────────────────────────────────

export type HostToEditorMessage =
  | {
      type: "init";
      content: string;
      filePath: string;
      workdir: string;
      nodeDefs: NodeDef[];
      checkExpr: boolean;
      theme: "dark" | "light";
    }
  | { type: "fileChanged"; content: string }
  | { type: "settingLoaded"; nodeDefs: NodeDef[] }
  | { type: "buildResult"; success: boolean; message: string }
  | { type: "readFileResult"; requestId: string; content: string | null }
  | { type: "propertyChanged"; nodeId: string; data: Record<string, unknown> }
  | { type: "treePropertyChanged"; data: Record<string, unknown> }
  | { type: "requestTreeSelection" }
  | { type: "varDeclLoaded"; usingVars: Array<{ name: string; desc: string }> };

// ─── Inspector Webview → Extension Host ─────────────────────────────────────

export type InspectorToHostMessage =
  | { type: "ready" }
  | { type: "propertyChanged"; nodeId: string; data: Record<string, unknown> }
  | { type: "treePropertyChanged"; data: Record<string, unknown> };

// ─── Extension Host → Inspector Webview ─────────────────────────────────────

export type HostToInspectorMessage =
  | {
      type: "nodeSelected";
      node: unknown | null;
      nodeDefs: NodeDef[];
      editingTree: unknown | null;
      workdir: string;
      checkExpr: boolean;
      allFiles: string[];
      usingVars: Record<string, { name: string; desc: string }> | null;
      groupDefs: string[];
    }
  | {
      type: "treeSelected";
      tree: unknown | null;
      nodeDefs: NodeDef[];
      workdir: string;
      checkExpr: boolean;
      allFiles: string[];
      usingVars: Record<string, { name: string; desc: string }> | null;
      groupDefs: string[];
    }
  | { type: "theme"; value: "dark" | "light" };
