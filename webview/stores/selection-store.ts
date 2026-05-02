import { createStore, type StoreApi } from "zustand/vanilla";
import type { SelectionState } from "../shared/contracts";

export const createSelectionStore = (): StoreApi<SelectionState> => {
    return createStore<SelectionState>(() => ({
        selectedTree: null,
        selectedNodeKey: null,
        selectedNodeRef: null,
        selectedNodeSnapshot: null,
        selectedNodeDef: null,
        activeVariableNames: [],
        search: {
            open: false,
            mode: "content",
            query: "",
            caseSensitive: false,
            focusOnly: true,
            results: [],
            index: 0,
        },
        inspector: {
            panelWidth: 368,
        },
    }));
};
