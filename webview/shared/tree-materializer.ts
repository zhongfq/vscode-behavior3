import type { NodeDef } from "./misc/b3type";
import type {
    InvalidSubtreeSource,
    PersistedNodeModel,
    PersistedTreeModel,
    SubtreeSourceCacheEntry,
    WorkdirRelativeJsonPath,
} from "./contracts";
import { normalizeWorkdirRelativePath } from "./protocol";
import { clonePersistedNode } from "./tree";

const enum StatusFlag {
    SUCCESS = 2,
    FAILURE = 1,
    RUNNING = 0,
    SUCCESS_ZERO = 5,
    FAILURE_ZERO = 4,
}

interface MaterializeContext {
    subtreeStack: WorkdirRelativeJsonPath[];
    overrideSourceChain: PersistedTreeModel[];
    sourceTreePath: WorkdirRelativeJsonPath | null;
    insideExternalSubtree: boolean;
}

export interface MaterializedTreeNode {
    data: PersistedNodeModel;
    children: MaterializedTreeNode[];
    structuralStableId: string;
    sourceStableId: string;
    sourceTreePath: WorkdirRelativeJsonPath | null;
    subtreeStack: WorkdirRelativeJsonPath[];
    subtreeNode: boolean;
    subtreeEditable: boolean;
    subtreeOriginal?: PersistedNodeModel;
    resolutionError?: "missing-subtree" | "invalid-subtree" | "cyclic-subtree";
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
    if (patch.desc !== undefined) {
        node.desc = patch.desc;
    }
    if (patch.input !== undefined) {
        node.input = patch.input;
    }
    if (patch.output !== undefined) {
        node.output = patch.output;
    }
    if (patch.args !== undefined) {
        node.args = { ...(node.args ?? {}), ...patch.args };
    }
    if (patch.debug !== undefined) {
        node.debug = patch.debug;
    }
    if (patch.disabled !== undefined) {
        node.disabled = patch.disabled;
    }
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
    if (!def?.status?.length) {
        return status | childStatus;
    }

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
};

export const computeNodeStatusBits = (
    nodeName: string,
    childStatuses: Array<number | undefined>,
    defsByName: Map<string, NodeDef>
): number => {
    let status = toStatusFlag(nodeName, defsByName);
    if (childStatuses.length === 0) {
        return status;
    }

    let mergedChildStatus = 0;
    for (const childStatus of childStatuses) {
        if (childStatus !== undefined) {
            mergedChildStatus = appendStatusFlag(mergedChildStatus, childStatus);
        }
    }

    return buildStatusFlag(status, nodeName, mergedChildStatus, defsByName);
};

export const materializePersistedTree = (params: {
    persistedTree: PersistedTreeModel;
    subtreeSources: Record<WorkdirRelativeJsonPath, SubtreeSourceCacheEntry>;
    nodeDefs: NodeDef[];
    subtreeEditable: boolean;
}): MaterializedTreeNode => {
    const defsByName = new Map(params.nodeDefs.map((def) => [def.name, def] as const));

    const resolveNode = (
        structuredNode: PersistedNodeModel,
        context: MaterializeContext
    ): MaterializedTreeNode => {
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
        let resolutionError: MaterializedTreeNode["resolutionError"];
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

        const childContext: MaterializeContext =
            materialized && subtreeTree
                ? {
                      subtreeStack: [...context.subtreeStack, normalizedPath!],
                      overrideSourceChain: [...context.overrideSourceChain, subtreeTree],
                      sourceTreePath: normalizedPath!,
                      insideExternalSubtree: true,
                  }
                : context.sourceTreePath
                  ? {
                        subtreeStack: [...context.subtreeStack],
                        overrideSourceChain: overrideChain,
                        sourceTreePath: context.sourceTreePath,
                        insideExternalSubtree: true,
                    }
                  : {
                        subtreeStack: [],
                        overrideSourceChain: [],
                        sourceTreePath: null,
                        insideExternalSubtree: false,
                    };

        const nextChildren =
            materialized && subtreeTree
                ? (subtreeTree.root.children ?? [])
                : normalizedPath && !subtreeTree
                  ? []
                  : (sourceNode.children ?? []);

        const children = nextChildren.map((child) => resolveNode(child, childContext));
        sourceNode.children = children.map((child) => child.data);
        sourceNode.$status = computeNodeStatusBits(
            sourceNode.name,
            children
                .filter((child) => !child.data.disabled)
                .map((child) => child.data.$status),
            defsByName
        );

        return {
            data: sourceNode,
            children,
            structuralStableId: structuredNode.$id,
            sourceStableId: sourceNode.$id,
            sourceTreePath: sourceTreePath ?? null,
            subtreeStack: materialized
                ? [...context.subtreeStack, normalizedPath!]
                : [...context.subtreeStack],
            subtreeNode: context.insideExternalSubtree,
            subtreeEditable: !context.insideExternalSubtree || params.subtreeEditable,
            subtreeOriginal,
            resolutionError,
        };
    };

    return resolveNode(params.persistedTree.root, {
        subtreeStack: [],
        overrideSourceChain: [],
        sourceTreePath: null,
        insideExternalSubtree: false,
    });
};
