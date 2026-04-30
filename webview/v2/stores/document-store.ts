import { createStore, type StoreApi } from "zustand/vanilla";
import type { DocumentState } from "../shared/contracts";

export const createDocumentStore = (): StoreApi<DocumentState> => {
    return createStore<DocumentState>(() => ({
        persistedTree: null,
        dirty: false,
        alertReload: false,
        pendingExternalContent: null,
        history: [],
        historyIndex: -1,
        lastSavedSnapshot: null,
    }));
};
