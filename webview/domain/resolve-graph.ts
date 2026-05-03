import type { NodeDef } from "../shared/misc/b3type";
import type {
    PersistedTreeModel,
    ResolveGraphResult,
    ResolvedDocumentGraph,
    ResolvedNodeModel,
    SubtreeSourceCacheEntry,
    WorkdirRelativeJsonPath,
} from "../shared/contracts";
import { materializePersistedTree, type MaterializedTreeNode } from "../shared/tree-materializer";

/**
 * Flatten the materialized tree into the runtime graph structure used by the
 * renderer, search, selection, and inspector layers.
 */
const flattenMaterializedTree = (
    root: MaterializedTreeNode,
    prefix: string
): ResolveGraphResult => {
    const nodesByInstanceKey: Record<string, ResolvedNodeModel> = {};
    const nodeOrder: string[] = [];
    const mainTreeDisplayIdsByStableId: Record<string, string> = {};
    let nextDisplayId = 1;

    const visit = (
        node: MaterializedTreeNode,
        parentKey: string | null,
        depth: number
    ): string => {
        const displayId = String(nextDisplayId);
        nextDisplayId += 1;
        const instanceKey = displayId;
        const childKeys = node.children.map((child) => visit(child, instanceKey, depth + 1));

        if (node.sourceTreePath === null) {
            mainTreeDisplayIdsByStableId[node.structuralStableId] = displayId;
        }

        nodesByInstanceKey[instanceKey] = {
            ref: {
                instanceKey,
                displayId,
                structuralStableId: node.structuralStableId,
                sourceStableId: node.sourceStableId,
                sourceTreePath: node.sourceTreePath,
                subtreeStack: [...node.subtreeStack],
            },
            parentKey,
            childKeys,
            depth,
            renderedIdLabel: `${prefix}${displayId}`,
            name: node.data.name,
            desc: node.data.desc,
            args: node.data.args,
            input: node.data.input,
            output: node.data.output,
            debug: node.data.debug,
            disabled: node.data.disabled,
            path: node.data.path,
            $status: node.data.$status,
            subtreeNode: node.subtreeNode,
            subtreeEditable: node.subtreeEditable,
            subtreeOriginal: node.subtreeOriginal,
            resolutionError: node.resolutionError,
        };
        nodeOrder.push(instanceKey);
        return instanceKey;
    };

    const rootKey = visit(root, null, 0);

    const graph: ResolvedDocumentGraph = {
        rootKey,
        nodesByInstanceKey,
        nodeOrder,
    };

    return {
        graph,
        mainTreeDisplayIdsByStableId,
    };
};

/**
 * Resolve persisted main-tree data plus reachable subtree sources into one
 * graph snapshot. The rest of the webview treats this as the canonical runtime
 * model until the next rebuild.
 */
export const resolveDocumentGraph = (params: {
    persistedTree: PersistedTreeModel;
    subtreeSources: Record<WorkdirRelativeJsonPath, SubtreeSourceCacheEntry>;
    nodeDefs: NodeDef[];
    subtreeEditable: boolean;
}): ResolveGraphResult => {
    const root = materializePersistedTree({
        persistedTree: params.persistedTree,
        subtreeSources: params.subtreeSources,
        nodeDefs: params.nodeDefs,
        subtreeEditable: params.subtreeEditable,
    });

    return flattenMaterializedTree(root, params.persistedTree.prefix ?? "");
};
