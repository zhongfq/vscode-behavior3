import { subtreeNeedsMissingIds } from "./misc/b3util";
import {
    basenameWithoutExt,
    readTree,
    treeDataForPersistence,
    writeTree,
} from "./misc/util";
import type { PersistedNodeModel, PersistedTreeModel, WorkdirRelativeJsonPath } from "./contracts";

export const clonePersistedTree = (tree: PersistedTreeModel): PersistedTreeModel =>
    JSON.parse(JSON.stringify(tree)) as PersistedTreeModel;

export const clonePersistedNode = (node: PersistedNodeModel): PersistedNodeModel =>
    JSON.parse(JSON.stringify(node)) as PersistedNodeModel;

export const parsePersistedTreeContent = (
    content: string,
    filePath?: string
): PersistedTreeModel => {
    const tree = readTree(content);
    if (filePath) {
        tree.name = basenameWithoutExt(filePath);
    }
    return treeDataForPersistence(tree, tree.name) as PersistedTreeModel;
};

export const serializePersistedTree = (tree: PersistedTreeModel): string => {
    return writeTree(tree as never, tree.name);
};

export const walkPersistedNodes = (
    node: PersistedNodeModel,
    visitor: (node: PersistedNodeModel, parent: PersistedNodeModel | null, depth: number) => void,
    parent: PersistedNodeModel | null = null,
    depth = 0
) => {
    visitor(node, parent, depth);
    for (const child of node.children ?? []) {
        walkPersistedNodes(child, visitor, node, depth + 1);
    }
};

export const findPersistedNodeByStableId = (
    root: PersistedNodeModel,
    stableId: string
): PersistedNodeModel | null => {
    let found: PersistedNodeModel | null = null;
    walkPersistedNodes(root, (node) => {
        if (!found && node.$id === stableId) {
            found = node;
        }
    });
    return found;
};

export const findPersistedNodeById = (
    root: PersistedNodeModel,
    displayId: string
): PersistedNodeModel | null => {
    let found: PersistedNodeModel | null = null;
    walkPersistedNodes(root, (node) => {
        if (!found && node.id === displayId) {
            found = node;
        }
    });
    return found;
};

export const collectReachableSubtreePaths = (
    root: PersistedNodeModel
): WorkdirRelativeJsonPath[] => {
    const paths = new Set<WorkdirRelativeJsonPath>();
    walkPersistedNodes(root, (node) => {
        if (node.path) {
            paths.add(node.path);
        }
    });
    return Array.from(paths);
};

export const applyMainTreeDisplayIds = (
    root: PersistedNodeModel,
    idsByStableId: Record<string, string>
) => {
    walkPersistedNodes(root, (node) => {
        const nextId = idsByStableId[node.$id];
        if (nextId) {
            node.id = nextId;
        }
    });
};

export const hasMissingStableIds = (content: string): boolean => {
    try {
        const parsed = JSON.parse(content) as { root?: unknown };
        return subtreeNeedsMissingIds(parsed.root);
    } catch {
        return false;
    }
};
