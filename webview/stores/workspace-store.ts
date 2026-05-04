import { createStore, type StoreApi } from "zustand/vanilla";
import type { WorkspaceState } from "../shared/contracts";
import { detectInitialThemeMode } from "../shared/theme-mode";

export const applyWorkspaceTheme = (
    store: StoreApi<WorkspaceState>,
    theme: WorkspaceState["settings"]["theme"]
): void => {
    store.setState((state) => ({
        ...state,
        settings: {
            ...state.settings,
            theme,
        },
        themeVersion: state.themeVersion + 1,
    }));
};

export const mergeWorkspaceSettings = (
    store: StoreApi<WorkspaceState>,
    settings: Partial<WorkspaceState["settings"]>
): void => {
    store.setState((state) => ({
        ...state,
        settings: {
            ...state.settings,
            ...settings,
        },
    }));
};

export const createInitialWorkspaceState = (): WorkspaceState => ({
    filePath: "",
    workdir: "",
    nodeDefs: [],
    groupDefs: [],
    allFiles: [],
    settings: {
        checkExpr: true,
        subtreeEditable: true,
        language: "zh",
        theme: detectInitialThemeMode(),
    },
    themeVersion: 0,
    usingVars: null,
    usingGroups: null,
    importDecls: [],
    subtreeDecls: [],
    subtreeSources: {},
    subtreeSourceRevision: 0,
    hostSubtreeRefreshSeq: 0,
    nodeCheckDiagnostics: {},
});

export const createWorkspaceStore = (): StoreApi<WorkspaceState> => {
    return createStore<WorkspaceState>(() => createInitialWorkspaceState());
};
