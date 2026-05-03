import type { EditorCommand } from "../shared/contracts";
import { createDocumentCommands } from "./controller-document-commands";
import { createMutationCommands } from "./controller-mutation-commands";
import { createSelectionCommands } from "./controller-selection-commands";
import { createControllerRuntime, type ControllerDeps } from "./controller-runtime";

export const createEditorController = (deps: ControllerDeps): EditorCommand => {
    const runtime = createControllerRuntime(deps);
    return {
        ...createDocumentCommands(runtime),
        ...createSelectionCommands(runtime),
        ...createMutationCommands(runtime),
    };
};
