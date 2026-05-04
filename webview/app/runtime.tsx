import React, { createContext, useContext } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import { createG6GraphAdapter } from "../adapters/graph/g6-graph-adapter";
import { createVsCodeHostAdapter } from "../adapters/host/vscode-host-adapter";
import { createEditorController } from "../commands/create-editor-controller";
import { createDocumentStore } from "../stores/document-store";
import { createSelectionStore } from "../stores/selection-store";
import { createWorkspaceStore } from "../stores/workspace-store";
import { createAppHooksStore, type AppHooksStore } from "../shared/misc/hooks";
import type {
    DocumentState,
    EditorCommand,
    SelectionState,
    WorkspaceState,
} from "../shared/contracts";
import type { GraphAdapter } from "../shared/graph-contracts";

export interface EditorRuntime {
    documentStore: StoreApi<DocumentState>;
    workspaceStore: StoreApi<WorkspaceState>;
    selectionStore: StoreApi<SelectionState>;
    controller: EditorCommand;
    graphAdapter: GraphAdapter;
    hostAdapter: ReturnType<typeof createVsCodeHostAdapter>;
    appHooks: AppHooksStore;
}

export const createEditorRuntime = (): EditorRuntime => {
    const documentStore = createDocumentStore();
    const workspaceStore = createWorkspaceStore();
    const selectionStore = createSelectionStore();
    const hostAdapter = createVsCodeHostAdapter();
    const graphAdapter = createG6GraphAdapter();
    const appHooks = createAppHooksStore();
    const controller = createEditorController({
        documentStore,
        workspaceStore,
        selectionStore,
        hostAdapter,
        graphAdapter,
        appHooks,
    });

    return {
        documentStore,
        workspaceStore,
        selectionStore,
        controller,
        graphAdapter,
        hostAdapter,
        appHooks,
    };
};

const RuntimeContext = createContext<EditorRuntime | null>(null);

export const RuntimeProvider: React.FC<React.PropsWithChildren<{ runtime: EditorRuntime }>> = ({
    runtime,
    children,
}) => {
    return <RuntimeContext.Provider value={runtime}>{children}</RuntimeContext.Provider>;
};

export const useRuntime = (): EditorRuntime => {
    const runtime = useContext(RuntimeContext);
    if (!runtime) {
        throw new Error("V2 runtime is not available");
    }
    return runtime;
};

export const useDocumentStore = <T,>(selector: (state: DocumentState) => T): T => {
    const runtime = useRuntime();
    return useStore(runtime.documentStore, selector);
};

export const useWorkspaceStore = <T,>(selector: (state: WorkspaceState) => T): T => {
    const runtime = useRuntime();
    return useStore(runtime.workspaceStore, selector);
};

export const useSelectionStore = <T,>(selector: (state: SelectionState) => T): T => {
    const runtime = useRuntime();
    return useStore(runtime.selectionStore, selector);
};

export const useAppShellState = () => {
    const theme = useWorkspaceStore((state) => state.settings.theme);
    const language = useWorkspaceStore((state) => state.settings.language);
    const hasDocument = useDocumentStore((state) => state.persistedTree !== null);
    const inspectorPanelWidth = useSelectionStore((state) => state.inspector.panelWidth);

    return {
        theme,
        language,
        hasDocument,
        inspectorPanelWidth,
    };
};

export const useAppThemeState = () => {
    const theme = useWorkspaceStore((state) => state.settings.theme);
    const language = useWorkspaceStore((state) => state.settings.language);
    const themeVersion = useWorkspaceStore((state) => state.themeVersion);

    return {
        theme,
        language,
        themeVersion,
    };
};

export const useInspectorPaneState = () => {
    const document = useDocumentStore((state) => state.persistedTree);
    const alertReload = useDocumentStore((state) => state.alertReload);
    const pendingExternalContent = useDocumentStore((state) => state.pendingExternalContent);
    const selectedNode = useSelectionStore((state) => state.selectedNodeSnapshot);

    return {
        document,
        alertReload,
        pendingExternalContent,
        selectedNode,
    };
};

export const useNodeInspectorState = () => {
    const document = useDocumentStore((state) => state.persistedTree);
    const selectedNode = useSelectionStore((state) => state.selectedNodeSnapshot);
    const nodeDefs = useWorkspaceStore((state) => state.nodeDefs);
    const usingVars = useWorkspaceStore((state) => state.usingVars);
    const usingGroups = useWorkspaceStore((state) => state.usingGroups);
    const allFiles = useWorkspaceStore((state) => state.allFiles);
    const checkExpr = useWorkspaceStore((state) => state.settings.checkExpr);
    const nodeCheckDiagnostics = useWorkspaceStore((state) => state.nodeCheckDiagnostics);

    return {
        document,
        selectedNode,
        nodeDefs,
        usingVars,
        usingGroups,
        allFiles,
        checkExpr,
        nodeCheckDiagnostics,
    };
};

export const useTreeInspectorState = () => {
    const document = useDocumentStore((state) => state.persistedTree);
    const nodeDefs = useWorkspaceStore((state) => state.nodeDefs);
    const groupDefs = useWorkspaceStore((state) => state.groupDefs);
    const allFiles = useWorkspaceStore((state) => state.allFiles);
    const importDecls = useWorkspaceStore((state) => state.importDecls);
    const subtreeDecls = useWorkspaceStore((state) => state.subtreeDecls);

    return {
        document,
        nodeDefs,
        groupDefs,
        allFiles,
        importDecls,
        subtreeDecls,
    };
};

export const useGraphPaneState = () => {
    const selectedNode = useSelectionStore((state) => state.selectedNodeSnapshot);
    const selectedNodeRef = useSelectionStore((state) => state.selectedNodeRef);
    const searchOpen = useSelectionStore((state) => state.search.open);
    const rootStableId = useDocumentStore((state) => state.persistedTree?.root.uuid ?? null);

    return {
        selectedNode,
        selectedNodeRef,
        searchOpen,
        rootStableId,
    };
};
