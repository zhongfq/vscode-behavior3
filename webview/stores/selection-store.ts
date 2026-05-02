import { createStore, type StoreApi } from "zustand/vanilla";
import type { SelectionState } from "../shared/contracts";

type SearchState = SelectionState["search"];

export const createInitialSearchState = (): SearchState => ({
    open: false,
    mode: "content",
    query: "",
    caseSensitive: false,
    focusOnly: true,
    results: [],
    index: 0,
});

export const patchSelectionSearchState = (
    store: StoreApi<SelectionState>,
    patch: Partial<SearchState>
): void => {
    store.setState((state) => ({
        ...state,
        search: {
            ...state.search,
            ...patch,
        },
    }));
};

export const resetSelectionSearchState = (store: StoreApi<SelectionState>): void => {
    store.setState((state) => ({
        ...state,
        search: createInitialSearchState(),
    }));
};

export const createInitialSelectionState = (): SelectionState => ({
    selectedTree: null,
    selectedNodeKey: null,
    selectedNodeRef: null,
    selectedNodeSnapshot: null,
    selectedNodeDef: null,
    activeVariableNames: [],
    search: createInitialSearchState(),
    inspector: {
        panelWidth: 368,
    },
});

export const createSelectionStore = (): StoreApi<SelectionState> => {
    return createStore<SelectionState>(() => createInitialSelectionState());
};
