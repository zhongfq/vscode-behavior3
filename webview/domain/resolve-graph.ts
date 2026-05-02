import type { NodeDef } from "../shared/misc/b3type";
import type {
    InvalidSubtreeSource,
    PersistedNodeModel,
    PersistedTreeModel,
    ResolveGraphResult,
    ResolvedDocumentGraph,
    ResolvedNodeModel,
    SubtreeSourceCacheEntry,
    WorkdirRelativeJsonPath,
} from "../shared/contracts";
import { normalizeWorkdirRelativePath } from "../shared/protocol";
import { clonePersistedNode } from "../shared/tree";

interface ResolveCursor {
    nodesByInstanceKey: Record<string, ResolvedNodeModel>;
    nodeOrder: string[];
    mainTreeDisplayIdsByStableId: Record<string, string>;
}

interface ResolveContext {
    parentKey: string | null;
    depth: number;
    subtreeStack: WorkdirRelativeJsonPath[];
    overrideSourceChain: PersistedTreeModel[];
    sourceTreePath: WorkdirRelativeJsonPath | null;
    insideExternalSubtree: boolean;
}

const enum StatusFlag {
    SUCCESS = 2,
    FAILURE = 1,
    RUNNING = 0,
    SUCCESS_ZERO = 5,
    FAILURE_ZERO = 4,
}

const applyPatchIfAny = (
    node: PersistedNodeModel,
    patch:
        | Pick<PersistedNodeModel, "desc" | "input" | "output" | "args" | "debug" | "disabled">
        | undefined
) => {
    if (!patch) {
        return;
    }
    if (patch.desc !== undefined) node.desc = patch.desc;
    if (patch.input !== undefined) node.input = patch.input;
    if (patch.output !== undefined) node.output = patch.output;
    if (patch.args !== undefined) node.args = { ...(node.args ?? {}), ...patch.args };
    if (patch.debug !== undefined) node.debug = patch.debug;
    if (patch.disabled !== undefined) node.disabled = patch.disabled;
};

const applyArgDefaults = (node: PersistedNodeModel, def: NodeDef | null) => {
    if (!def?.args?.length) {
        return;
    }
    node.args ||= {};
    for (const arg of def.args) {
        if (node.args[arg.name] === undefined && arg.default !== undefined) {
            node.args[arg.name] = arg.default;
        }
    }
};

const buildResolvedExternalNode = (
    sourceNode: PersistedNodeModel,
    overrideChain: PersistedTreeModel[],
    rootOverride: PersistedTreeModel["$override"]
) => {
    const value = clonePersistedNode(sourceNode);
    for (const tree of [...overrideChain].reverse()) {
        applyPatchIfAny(value, tree.$override[sourceNode.$id]);
    }
    const subtreeOriginal = clonePersistedNode(value);
    applyPatchIfAny(value, rootOverride[sourceNode.$id]);
    return { value, subtreeOriginal };
};

const isInvalidSubtreeSource = (
    value: SubtreeSourceCacheEntry | undefined
): value is InvalidSubtreeSource => {
    return Boolean(value && typeof value === "object" && "error" in value);
};

const toStatusFlag = (nodeName: string, defsByName: Map<string, NodeDef>) => {
    let status = 0;
    const def = defsByName.get(nodeName);
    def?.status?.forEach((entry) => {
        switch (entry) {
            case "success":
                status |= 1 << StatusFlag.SUCCESS;
                break;
            case "failure":
                status |= 1 << StatusFlag.FAILURE;
                break;
            case "running":
                status |= 1 << StatusFlag.RUNNING;
                break;
        }
    });
    return status;
};

const appendStatusFlag = (status: number, childStatus: number) => {
    const childSuccess = (childStatus >> StatusFlag.SUCCESS) & 1;
    const childFailure = (childStatus >> StatusFlag.FAILURE) & 1;
    if (childSuccess === 0) {
        status |= 1 << StatusFlag.SUCCESS_ZERO;
    }
    if (childFailure === 0) {
        status |= 1 << StatusFlag.FAILURE_ZERO;
    }
    status |= childStatus;
    return status;
};

const buildStatusFlag = (
    status: number,
    nodeName: string,
    childStatus: number,
    defsByName: Map<string, NodeDef>
) => {
    const def = defsByName.get(nodeName);
    if (def?.status?.length) {
        const childSuccess = (childStatus >> StatusFlag.SUCCESS) & 1;
        const childFailure = (childStatus >> StatusFlag.FAILURE) & 1;
        const childRunning = (childStatus >> StatusFlag.RUNNING) & 1;
        const childHasZeroSuccess = (childStatus >> StatusFlag.SUCCESS_ZERO) & 1;
        const childHasZeroFailure = (childStatus >> StatusFlag.FAILURE_ZERO) & 1;

        def.status.forEach((entry) => {
            switch (entry) {
                case "!success":
                    status |= childFailure << StatusFlag.SUCCESS;
                    break;
                case "!failure":
                    status |= childSuccess << StatusFlag.FAILURE;
                    break;
                case "|success":
                    status |= childSuccess << StatusFlag.SUCCESS;
                    break;
                case "|failure":
                    status |= childFailure << StatusFlag.FAILURE;
                    break;
                case "|running":
                    status |= childRunning << StatusFlag.RUNNING;
                    break;
                case "&success":
                    if (childHasZeroSuccess) {
                        status &= ~(1 << StatusFlag.SUCCESS);
                    } else {
                        status |= childSuccess << StatusFlag.SUCCESS;
                    }
                    break;
                case "&failure":
                    if (childHasZeroFailure) {
                        status &= ~(1 << StatusFlag.FAILURE);
                    } else {
                        status |= childFailure << StatusFlag.FAILURE;
                    }
                    break;
            }
        });

        return status;
    }

    return status | childStatus;
};

export const resolveDocumentGraph = (params: {
    persistedTree: PersistedTreeModel;
    subtreeSources: Record<WorkdirRelativeJsonPath, SubtreeSourceCacheEntry>;
    nodeDefs: NodeDef[];
    subtreeEditable: boolean;
}): ResolveGraphResult => {
    const defsByName = new Map(params.nodeDefs.map((def) => [def.name, def] as const));
    const cursor: ResolveCursor = {
        nodesByInstanceKey: {},
        nodeOrder: [],
        mainTreeDisplayIdsByStableId: {},
    };

    const resolveNode = (
        structuredNode: PersistedNodeModel,
        context: ResolveContext,
        nextDisplayId: number
    ): { node: ResolvedNodeModel; nextDisplayId: number } => {
        const normalizedPath = structuredNode.path
            ? normalizeWorkdirRelativePath(structuredNode.path)
            : undefined;
        const isCyclic = normalizedPath ? context.subtreeStack.includes(normalizedPath) : false;
        const subtreeSource =
            normalizedPath && !isCyclic ? params.subtreeSources[normalizedPath] : undefined;
        const subtreeTree =
            subtreeSource && !isInvalidSubtreeSource(subtreeSource) ? subtreeSource : null;
        const materialized = Boolean(normalizedPath && subtreeTree);

        let sourceNode = structuredNode;
        let resolutionError: ResolvedNodeModel["resolutionError"];
        let sourceTreePath = context.sourceTreePath;
        let subtreeOriginal: PersistedNodeModel | undefined;
        let overrideChain = context.overrideSourceChain;

        if (normalizedPath && isCyclic) {
            resolutionError = "cyclic-subtree";
        } else if (isInvalidSubtreeSource(subtreeSource)) {
            resolutionError = "invalid-subtree";
        } else if (normalizedPath && !subtreeTree) {
            resolutionError = "missing-subtree";
        } else if (materialized && subtreeTree) {
            sourceNode = clonePersistedNode(subtreeTree.root);
            sourceNode.path = normalizedPath;
            sourceTreePath = normalizedPath!;
            overrideChain = [...context.overrideSourceChain, subtreeTree];
            const external = buildResolvedExternalNode(
                sourceNode,
                overrideChain,
                params.persistedTree.$override
            );
            sourceNode = external.value;
            subtreeOriginal = external.subtreeOriginal;
        } else if (context.sourceTreePath) {
            sourceTreePath = context.sourceTreePath;
            const external = buildResolvedExternalNode(
                sourceNode,
                context.overrideSourceChain,
                params.persistedTree.$override
            );
            sourceNode = external.value;
            subtreeOriginal = external.subtreeOriginal;
        } else {
            sourceNode = clonePersistedNode(sourceNode);
        }

        applyArgDefaults(sourceNode, defsByName.get(sourceNode.name) ?? null);

        const displayId = String(nextDisplayId);
        const renderedIdLabel = `${params.persistedTree.prefix ?? ""}${displayId}`;
        const instanceKey = displayId;
        let nextId = nextDisplayId + 1;

        const node: ResolvedNodeModel = {
            ref: {
                instanceKey,
                displayId,
                structuralStableId: structuredNode.$id,
                sourceStableId: sourceNode.$id,
                sourceTreePath: sourceTreePath ?? null,
                subtreeStack: materialized
                    ? [...context.subtreeStack, normalizedPath!]
                    : [...context.subtreeStack],
            },
            parentKey: context.parentKey,
            childKeys: [],
            depth: context.depth,
            renderedIdLabel,
            name: sourceNode.name,
            desc: sourceNode.desc,
            args: sourceNode.args,
            input: sourceNode.input,
            output: sourceNode.output,
            debug: sourceNode.debug,
            disabled: sourceNode.disabled,
            path: sourceNode.path,
            $status: sourceNode.$status,
            subtreeNode: context.insideExternalSubtree,
            subtreeEditable: !context.insideExternalSubtree || params.subtreeEditable,
            subtreeOriginal,
            resolutionError,
        };

        if (context.sourceTreePath === null) {
            cursor.mainTreeDisplayIdsByStableId[structuredNode.$id] = displayId;
        }

        cursor.nodesByInstanceKey[instanceKey] = node;
        cursor.nodeOrder.push(instanceKey);

        const nextChildren =
            materialized && subtreeTree
                ? (subtreeTree.root.children ?? [])
                : normalizedPath && !subtreeTree
                  ? []
                  : (sourceNode.children ?? []);

        const childContext: ResolveContext =
            materialized && subtreeTree
                ? {
                      parentKey: instanceKey,
                      depth: context.depth + 1,
                      subtreeStack: [...context.subtreeStack, normalizedPath!],
                      overrideSourceChain: [...context.overrideSourceChain, subtreeTree],
                      sourceTreePath: normalizedPath!,
                      insideExternalSubtree: true,
                  }
                : context.sourceTreePath
                  ? {
                        parentKey: instanceKey,
                        depth: context.depth + 1,
                        subtreeStack: [...context.subtreeStack],
                        overrideSourceChain: overrideChain,
                        sourceTreePath: context.sourceTreePath,
                        insideExternalSubtree: true,
                    }
                  : {
                        parentKey: instanceKey,
                        depth: context.depth + 1,
                        subtreeStack: [],
                        overrideSourceChain: [],
                        sourceTreePath: null,
                        insideExternalSubtree: false,
                    };

        for (const child of nextChildren) {
            const resolvedChild = resolveNode(child, childContext, nextId);
            nextId = resolvedChild.nextDisplayId;
            node.childKeys.push(resolvedChild.node.ref.instanceKey);
        }

        let status = toStatusFlag(node.name, defsByName);
        if (node.childKeys.length > 0) {
            let childStatus = 0;
            for (const childKey of node.childKeys) {
                const childNode = cursor.nodesByInstanceKey[childKey];
                if (childNode?.$status && !childNode.disabled) {
                    childStatus = appendStatusFlag(childStatus, childNode.$status);
                }
            }
            status = buildStatusFlag(status, node.name, childStatus, defsByName);
        }
        node.$status = status;

        return {
            node,
            nextDisplayId: nextId,
        };
    };

    const rootResult = resolveNode(
        params.persistedTree.root,
        {
            parentKey: null,
            depth: 0,
            subtreeStack: [],
            overrideSourceChain: [],
            sourceTreePath: null,
            insideExternalSubtree: false,
        },
        1
    );

    const root = rootResult.node;

    const graph: ResolvedDocumentGraph = {
        rootKey: root.ref.instanceKey,
        nodesByInstanceKey: cursor.nodesByInstanceKey,
        nodeOrder: cursor.nodeOrder,
    };

    return {
        graph,
        mainTreeDisplayIdsByStableId: cursor.mainTreeDisplayIdsByStableId,
    };
};
