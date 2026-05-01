import { createStore, type StoreApi } from "zustand/vanilla";
import type { WorkspaceState } from "../shared/contracts";
import { detectInitialThemeMode } from "../shared/theme-mode";

export const createWorkspaceStore = (): StoreApi<WorkspaceState> => {
    return createStore<WorkspaceState>(() => ({
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
    }));
};
