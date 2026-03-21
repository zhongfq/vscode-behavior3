/**
 * Editor webview workspace context.
 * Replaces the original Electron-based workspace-context.ts.
 * All file I/O is done via postMessage to the extension host.
 */
import React from "react";
import { create } from "zustand";
import { NodeDef } from "@shared/misc/b3type";
import {
  FileVarDecl,
  ImportDecl,
  NodeData,
  TreeData,
  VarDecl,
} from "@shared/misc/b3type";
import * as b3util from "@shared/misc/b3util";
import { message } from "@shared/misc/hooks";
import i18n from "@shared/misc/i18n";
import { basenameWithoutExt, nanoid, readTree, writeTree } from "@shared/misc/util";
import * as vscodeApi from "../vscodeApi";

export type EditEvent =
  | "close"
  | "save"
  | "copy"
  | "paste"
  | "replace"
  | "delete"
  | "insert"
  | "jumpNode"
  | "undo"
  | "redo"
  | "refresh"
  | "repaint"
  | "rename"
  | "reload"
  | "updateTree"
  | "updateNode"
  | "searchNode"
  | "editSubtree"
  | "saveAsSubtree"
  | "clickVar";

export class EditorStore {
  path: string;
  data: TreeData;
  declare: FileVarDecl;
  changed: boolean = false;
  alertReload: boolean = false;
  focusId?: string | null;
  dispatch?: (event: EditEvent, data?: unknown) => void;

  constructor(path: string, content: string) {
    this.path = path;
    this.data = readTree(content);
    this.data.name = basenameWithoutExt(path);
    this.declare = {
      import: this.data.import.map((v) => ({ path: v, vars: [], depends: [] })),
      subtree: [],
      vars: this.data.vars.map((v) => ({ ...v })),
    };
  }

  reload(content: string) {
    this.data = readTree(content);
    this.data.name = basenameWithoutExt(this.path);
    this.declare = {
      import: this.data.import.map((v) => ({ path: v, vars: [], depends: [] })),
      subtree: [],
      vars: this.data.vars.map((v) => ({ ...v })),
    };
    this.changed = false;
    this.alertReload = false;
  }
}

export type EditNode = {
  data: NodeData;
  error?: boolean;
  prefix: string;
  disabled: boolean;
  subtreeEditable?: boolean;
};

export type EditNodeDef = {
  data: NodeDef;
  path?: string;
};

export type EditTree = {
  name: string;
  desc?: string;
  export?: boolean;
  prefix?: string;
  group: string[];
  import: ImportDecl[];
  vars: VarDecl[];
  subtree: ImportDecl[];
  root: NodeData;
};

export type WorkspaceStore = {
  // init state (received from extension host)
  filePath: string;
  workdir: string;
  nodeDefs: b3util.NodeDefs;
  groupDefs: string[];
  checkExpr: boolean;
  theme: "dark" | "light";

  // single editor (no multi-tab in VSCode extension; each file has its own tab)
  editor?: EditorStore;
  modifiedTime: number;

  isShowingSearch: boolean;
  onShowingSearch: (v: boolean) => void;

  // init from extension host message
  init: (params: {
    content: string;
    filePath: string;
    workdir: string;
    nodeDefs: NodeDef[];
    checkExpr: boolean;
    theme: "dark" | "light";
  }) => void;

  // update node defs (from setting file change)
  updateNodeDefs: (defs: NodeDef[]) => void;

  // reload content when file changed externally
  reloadContent: (content: string) => void;

  // save current editor
  save: () => void;

  // refresh var declaration (updates usingGroups/usingVars)
  refresh: () => void;

  // apply pre-computed vars from the extension host (includes import/subtree vars)
  applyHostVars: (vars: Array<{ name: string; desc: string }>) => void;

  usingGroups: typeof b3util.usingGroups;
  usingVars: typeof b3util.usingVars;

  // Inspector callbacks
  editingNode?: EditNode | null;
  onEditingNode: (node: EditNode | null) => void;

  editingNodeDef?: EditNodeDef | null;
  onEditingNodeDef: (node: EditNodeDef | null) => void;

  editingTree?: EditTree | null;
  onEditingTree: (editor: EditorStore) => void;
};

const saveEditor = (editor?: EditorStore) => {
  if (!editor?.changed) return;
  editor.dispatch?.("save");
};

export const useWorkspace = create<WorkspaceStore>((set, get) => ({
  filePath: "",
  workdir: "",
  nodeDefs: new b3util.NodeDefs(),
  groupDefs: [],
  checkExpr: true,
  theme: "dark",
  editor: undefined,
  modifiedTime: 0,
  isShowingSearch: false,
  usingGroups: null,
  usingVars: null,

  onShowingSearch: (v) => set({ isShowingSearch: v }),

  init: ({ content, filePath, workdir, nodeDefs: defs, checkExpr, theme }) => {
    b3util.initWithNodeDefs(
      defs,
      (msg) => message.error(msg),
      checkExpr
    );

    const editor = new EditorStore(filePath, content);

    b3util.refreshVarDecl(editor.data.root, editor.data.group, editor.declare);

    set({
      filePath,
      workdir,
      nodeDefs: b3util.nodeDefs,
      groupDefs: b3util.groupDefs,
      checkExpr,
      theme,
      editor,
      usingGroups: b3util.usingGroups,
      usingVars: b3util.usingVars,
    });

    get().onEditingTree(editor);
  },

  updateNodeDefs: (defs) => {
    b3util.initWithNodeDefs(defs, (msg) => message.error(msg), get().checkExpr);
    const editor = get().editor;
    set({ nodeDefs: b3util.nodeDefs, groupDefs: b3util.groupDefs });
    editor?.dispatch?.("refresh");
  },

  reloadContent: (content) => {
    const editor = get().editor;
    if (!editor) return;
    editor.reload(content);
    b3util.refreshVarDecl(editor.data.root, editor.data.group, editor.declare);
    set({
      editor,
      usingGroups: b3util.usingGroups,
      usingVars: b3util.usingVars,
      modifiedTime: Date.now(),
    });
    editor.dispatch?.("refresh");
  },

  save: () => saveEditor(get().editor),

  refresh: () => {
    const editor = get().editor;
    if (!editor) return;
    b3util.refreshVarDecl(editor.data.root, editor.data.group, editor.declare);
    set({ usingGroups: b3util.usingGroups, usingVars: b3util.usingVars });
  },

  applyHostVars: (vars) => {
    b3util.updateUsingVars(vars);
    set({ usingVars: b3util.usingVars });
    // Repaint node colors to reflect updated usingVars.
    // Use "repaint" (not "refresh") to avoid triggering selectNode(null)
    // → onEditingTree → treeSelected → varDeclLoaded infinite loop.
    get().editor?.dispatch?.("repaint");
  },

  onEditingNode: (node) => {
    set({ editingNode: node, editingNodeDef: null, editingTree: null });
    if (node) {
      const currentTree = get().editor?.data ?? null;
      vscodeApi.postMessage({ type: "nodeSelected", node: node.data, tree: currentTree });
    } else {
      // notify tree selected
      const editor = get().editor;
      if (editor) {
        vscodeApi.postMessage({
          type: "treeSelected",
          tree: editor.data,
        });
      }
    }
  },

  onEditingNodeDef: (nodeDef) => {
    set({ editingNodeDef: nodeDef, editingNode: null, editingTree: null });
  },

  onEditingTree: (editor) => {
    get().refresh();
    set({
      editingTree: {
        ...editor.data,
        root: editor.data.root,
        import: editor.declare.import,
        subtree: editor.declare.subtree,
        vars: editor.declare.vars,
      },
      editingNodeDef: null,
      editingNode: null,
    });
    vscodeApi.postMessage({
      type: "treeSelected",
      tree: editor.data,
    });
  },
}));
