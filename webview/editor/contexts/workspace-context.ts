/**
 * Editor webview workspace context.
 * Replaces the original Electron-based workspace-context.ts.
 * All file I/O is done via postMessage to the extension host.
 */
import React from "react";
import { create } from "zustand";
import * as vscodeApi from "../vscodeApi";
import { FileVarDecl, ImportDecl, NodeData, TreeData, VarDecl } from "../../shared/misc/b3type";
import { NodeDef } from "../../shared/misc/b3type";
import * as b3util from "../../shared/misc/b3util";
import { message } from "../../shared/misc/hooks";
import i18n from "../../shared/misc/i18n";
import {
    basenameWithoutExt,
    nanoid,
    readTree,
    treeDataForPersistence,
} from "../../shared/misc/util";

export const detectInitialThemeMode = (): "dark" | "light" => {
    if (typeof document === "undefined") {
        return "dark";
    }
    const classes = document.body?.classList;
    if (classes?.contains("vscode-light") || classes?.contains("vscode-high-contrast-light")) {
        return "light";
    }
    if (classes?.contains("vscode-dark") || classes?.contains("vscode-high-contrast")) {
        return "dark";
    }
    return window.matchMedia?.("(prefers-color-scheme: light)")?.matches ? "light" : "dark";
};

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
    /** True when the node belongs to an external subtree (not the main tree). */
    subtreeNode?: boolean;
    /** Original subtree node data (before any overrides), used to power reset buttons. */
    subtreeOriginal?: NodeData;
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

export type Settings = {
    checkExpr: boolean;
    editSubtreeNodeProps: boolean;
    lang: string;
    theme: "dark" | "light";
    /** Override default node-type colors. Keys: "Composite" | "Decorator" | "Condition" | "Action" | "Other" | "Error" */
    nodeColors?: Record<string, string>;
};

/** Fresh snapshot for TreeInspector props (clone vars/import/subtree so store !== live declare refs). */
export function buildEditingTreeSnapshot(editor: EditorStore): EditTree {
    return {
        ...editor.data,
        root: editor.data.root,
        import: editor.declare.import.map((d) => ({
            path: d.path,
            modified: d.modified,
            vars: d.vars.map((v) => ({ name: v.name, desc: v.desc ?? "" })),
            depends: (d.depends ?? []).map((x) => ({ path: x.path, modified: x.modified })),
        })),
        subtree: editor.declare.subtree.map((d) => ({
            path: d.path,
            modified: d.modified,
            vars: d.vars.map((v) => ({ name: v.name, desc: v.desc ?? "" })),
            depends: (d.depends ?? []).map((x) => ({ path: x.path, modified: x.modified })),
        })),
        vars: editor.declare.vars.map((v) => ({ name: v.name, desc: v.desc ?? "" })),
    };
}

export type WorkspaceStore = {
    // init state (received from extension host)
    filePath: string;
    workdir: string;
    nodeDefs: b3util.NodeDefs;
    groupDefs: string[];
    checkExpr: boolean;
    editSubtreeNodeProps: boolean;
    theme: "dark" | "light";
    allFiles: string[];

    settings: Settings;

    // single editor (no multi-tab in VSCode extension; each file has its own tab)
    editor?: EditorStore;
    modifiedTime: number;

    /** Incremented when a referenced subtree file changes on disk/buffer; Editor refreshes the graph. */
    hostSubtreeRefreshSeq: number;
    requestHostSubtreeRefresh: () => void;

    isShowingSearch: boolean;
    onShowingSearch: (v: boolean) => void;

    // init from extension host message
    init: (params: {
        content: string;
        filePath: string;
        workdir: string;
        nodeDefs: NodeDef[];
        allFiles: string[];
        settings: Settings;
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
    applyHostVars: (
        vars: Array<{ name: string; desc: string }>,
        allFiles?: string[],
        importDecls?: Array<{ path: string; vars: Array<{ name: string; desc: string }> }>,
        subtreeDecls?: Array<{ path: string; vars: Array<{ name: string; desc: string }> }>
    ) => void;

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
    editSubtreeNodeProps: true,
    theme: detectInitialThemeMode(),
    allFiles: [],
    editor: undefined,
    modifiedTime: 0,
    hostSubtreeRefreshSeq: 0,
    isShowingSearch: false,
    usingGroups: null,
    usingVars: null,

    settings: {
        checkExpr: true,
        editSubtreeNodeProps: true,
        theme: "dark",
        lang: "en",
    },

    onShowingSearch: (v) => set({ isShowingSearch: v }),

    requestHostSubtreeRefresh: () =>
        set((s) => ({ hostSubtreeRefreshSeq: s.hostSubtreeRefreshSeq + 1 })),

    init: ({ content, filePath, workdir, nodeDefs: defs, allFiles, settings }) => {
        b3util.initWithNodeDefs(defs, (msg) => message.error(msg), settings.checkExpr);

        const editor = new EditorStore(filePath, content);

        b3util.refreshVarDecl(editor.data.root, editor.data.group, editor.declare);

        set({
            filePath,
            workdir,
            nodeDefs: b3util.nodeDefs,
            groupDefs: b3util.groupDefs,
            settings,
            checkExpr: settings.checkExpr,
            editSubtreeNodeProps: settings.editSubtreeNodeProps,
            allFiles: allFiles ?? [],
            editor,
            hostSubtreeRefreshSeq: 0,
            usingGroups: b3util.usingGroups,
            usingVars: b3util.usingVars,
        });

        get().onEditingTree(editor);
    },

    updateNodeDefs: (defs) => {
        b3util.initWithNodeDefs(defs, (msg) => message.error(msg), get().checkExpr);
        const editor = get().editor;
        set({ nodeDefs: b3util.nodeDefs, groupDefs: b3util.groupDefs });
        editor?.dispatch?.("refresh", { preserveSelection: true });
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
        editor.dispatch?.("refresh", { preserveSelection: true });
        // 与 graph 编辑一致：变量表以宿主 buildUsingVars 为准，避免 refreshVarDecl 不读盘导致 usingVars 陈旧
        vscodeApi.postMessage({
            type: "treeSelected",
            tree: treeDataForPersistence(editor.data, editor.data.name),
        });
    },

    save: () => saveEditor(get().editor),

    refresh: () => {
        const editor = get().editor;
        if (!editor) return;
        b3util.refreshVarDecl(editor.data.root, editor.data.group, editor.declare);
        const usingGroups = b3util.usingGroups;
        const usingVars = b3util.usingVars;
        const s = get();
        if (s.usingGroups !== usingGroups || s.usingVars !== usingVars) {
            set({ usingGroups, usingVars });
        }
    },

    applyHostVars: (vars, allFiles, importDecls, subtreeDecls) => {
        const usingVarsSig = (m: typeof b3util.usingVars) =>
            m
                ? Object.keys(m)
                      .sort()
                      .map((k) => `${k}\x00${m![k].desc ?? ""}`)
                      .join("\x01")
                : "";

        const incomingSig = [...vars]
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((v) => `${v.name}\x00${v.desc ?? ""}`)
            .join("\x01");

        const varsUnchanged = incomingSig === usingVarsSig(b3util.usingVars);
        if (!varsUnchanged) {
            b3util.updateUsingVars(vars);
        }

        const editor = get().editor;
        if (editor) {
            if (importDecls) {
                editor.declare.import = importDecls.map((d) => ({
                    path: d.path,
                    vars: d.vars.map((v) => ({ name: v.name, desc: v.desc })),
                    depends: [],
                }));
            }
            if (subtreeDecls) {
                editor.declare.subtree = subtreeDecls.map((d) => ({
                    path: d.path,
                    vars: d.vars.map((v) => ({ name: v.name, desc: v.desc })),
                    depends: [],
                }));
            }
        }

        const update: Partial<WorkspaceStore> = {};
        if (!varsUnchanged) {
            update.usingVars = b3util.usingVars;
        }
        if (allFiles) update.allFiles = allFiles;

        if (editor && (importDecls || subtreeDecls)) {
            const candidate = buildEditingTreeSnapshot(editor);
            const prev = get().editingTree;
            const treeChanged =
                !prev ||
                JSON.stringify(prev.import) !== JSON.stringify(candidate.import) ||
                JSON.stringify(prev.subtree) !== JSON.stringify(candidate.subtree) ||
                JSON.stringify(prev.vars) !== JSON.stringify(candidate.vars);
            if (treeChanged) {
                update.editingTree = candidate;
            }
        }

        if (Object.keys(update).length > 0) {
            set(update);
        }
    },

    onEditingNode: (node) => {
        set({ editingNode: node, editingNodeDef: null, editingTree: null });
        if (!node) {
            // Notify host so it can recompute varDeclLoaded
            const editor = get().editor;
            if (editor) {
                vscodeApi.postMessage({
                    type: "treeSelected",
                    tree: treeDataForPersistence(editor.data, editor.data.name),
                });
            }
        }
    },

    onEditingNodeDef: (nodeDef) => {
        set({ editingNodeDef: nodeDef, editingNode: null, editingTree: null });
    },

    onEditingTree: (editor) => {
        const s = get();
        // Already showing tree inspector and user clicked empty canvas again: avoid
        // refresh / host round-trip / editingTree object churn (right panel flash).
        if (s.editingNode === null && s.editingTree !== null) {
            return;
        }
        get().refresh();
        set({
            editingTree: buildEditingTreeSnapshot(editor),
            editingNodeDef: null,
            editingNode: null,
        });
        vscodeApi.postMessage({
            type: "treeSelected",
            tree: treeDataForPersistence(editor.data, editor.data.name),
        });
    },
}));
