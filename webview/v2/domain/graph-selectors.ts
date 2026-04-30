import { getNodeType, isExprType, type NodeDef } from "../../shared/misc/b3type";
import { parseExpr } from "../../shared/misc/b3util";
import i18n from "../../shared/misc/i18n";
import type {
    GraphHighlightState,
    GraphNodeVM,
    GraphSearchState,
    PersistedTreeModel,
    ResolvedDocumentGraph,
    ResolvedGraphModel,
} from "../shared/contracts";
import { stringifyCompactJson5, stringifySearchValueAsJson5 } from "../shared/json5-display";

const DEFAULT_NODE_COLORS: Record<GraphNodeVM["nodeStyleKind"], string> = {
    Composite: "#34d800",
    Decorator: "#b2eb35",
    Condition: "#f72585",
    Action: "#1769dd",
    Other: "#707070",
    Error: "#ff0000",
};

const stringifyArgValue = (value: unknown): string => {
    return stringifySearchValueAsJson5(value);
};

const includesString = (haystack: string, needle: string, caseSensitive: boolean): boolean => {
    return caseSensitive
        ? haystack.includes(needle)
        : haystack.toLowerCase().includes(needle.toLowerCase());
};

const pickNodeSubtitle = (nodeDesc: string | undefined, defDesc: string | undefined) => {
    const trimmedNodeDesc = nodeDesc?.trim();
    if (trimmedNodeDesc) {
        return trimmedNodeDesc;
    }

    const trimmedDefDesc = defDesc?.trim();
    return trimmedDefDesc || undefined;
};

export const buildResolvedGraphModel = (
    graph: ResolvedDocumentGraph,
    nodeDefs: NodeDef[],
    nodeColors?: Record<string, string>
): ResolvedGraphModel => {
    const defsByName = new Map(nodeDefs.map((def) => [def.name, def] as const));
    const nodes: GraphNodeVM[] = [];
    const edges = [];

    for (const key of graph.nodeOrder) {
        const node = graph.nodesByInstanceKey[key];
        const def = defsByName.get(node.name);
        const nodeStyleKind = node.resolutionError ? "Error" : def ? getNodeType(def) : "Error";

        nodes.push({
            ref: node.ref,
            parentKey: node.parentKey,
            childKeys: node.childKeys,
            depth: node.depth,
            renderedIdLabel: node.renderedIdLabel,
            title: node.name,
            subtitle: pickNodeSubtitle(node.desc, def?.desc),
            typeLabel:
                def?.type ??
                (node.resolutionError
                    ? i18n.t("node.resolutionError")
                    : i18n.t("node.unknownType")),
            icon: def?.icon,
            nodeStyleKind,
            accentColor: nodeColors?.[nodeStyleKind] ?? DEFAULT_NODE_COLORS[nodeStyleKind],
            disabled: Boolean(node.disabled),
            subtreeNode: node.subtreeNode,
            subtreePath: node.path,
            statusBits: ((node.$status ?? 0) & 0b111) as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7,
            inputs: (node.input ?? []).map((input) => ({
                label: input,
                variable: input || undefined,
            })),
            outputs: (node.output ?? []).map((output) => ({
                label: output,
                variable: output || undefined,
            })),
            argsText:
                node.args && Object.keys(node.args).length > 0
                    ? stringifyCompactJson5(node.args)
                    : undefined,
        });

        for (const childKey of node.childKeys) {
            edges.push({
                key: `${key}->${childKey}`,
                sourceKey: key,
                targetKey: childKey,
            });
        }
    }

    return {
        rootKey: graph.rootKey,
        nodes,
        edges,
    };
};

export const computeVariableHighlights = (
    graph: ResolvedDocumentGraph,
    nodeDefs: NodeDef[],
    activeVariableNames: string[]
): GraphHighlightState => {
    const defsByName = new Map(nodeDefs.map((def) => [def.name, def] as const));
    const hits: GraphHighlightState["variableHits"] = {};

    if (activeVariableNames.length === 0) {
        return {
            activeVariableNames: [],
            variableHits: {},
        };
    }

    for (const key of graph.nodeOrder) {
        const node = graph.nodesByInstanceKey[key];
        const nodeHits: Array<"input" | "output" | "args"> = [];
        if ((node.input ?? []).some((value) => value && activeVariableNames.includes(value))) {
            nodeHits.push("input");
        }
        if ((node.output ?? []).some((value) => value && activeVariableNames.includes(value))) {
            nodeHits.push("output");
        }

        const def = defsByName.get(node.name);
        for (const arg of def?.args ?? []) {
            if (!isExprType(arg.type)) {
                continue;
            }
            const rawValue = node.args?.[arg.name];
            const exprValues = Array.isArray(rawValue) ? rawValue : [rawValue];
            if (
                exprValues.some(
                    (expr) =>
                        typeof expr === "string" &&
                        parseExpr(expr).some((name) => activeVariableNames.includes(name))
                )
            ) {
                nodeHits.push("args");
                break;
            }
        }

        if (nodeHits.length > 0) {
            hits[key] = nodeHits;
        }
    }

    return {
        activeVariableNames: [...activeVariableNames],
        variableHits: hits,
    };
};

export const computeSearchState = (
    graph: ResolvedDocumentGraph,
    current: GraphSearchState,
    tree: PersistedTreeModel | null
): GraphSearchState => {
    if (!tree || !current.query) {
        return {
            ...current,
            resultKeys: [],
            activeResultIndex: 0,
        };
    }

    const resultKeys: string[] = [];
    for (const key of graph.nodeOrder) {
        const node = graph.nodesByInstanceKey[key];
        let matched = false;
        if (current.mode === "id") {
            matched = includesString(node.ref.displayId, current.query, current.caseSensitive);
        } else {
            const stringParts = [
                node.name,
                node.desc ?? "",
                node.path ?? "",
                ...(node.input ?? []),
                ...(node.output ?? []),
                ...Object.values(node.args ?? {}).flatMap((value) =>
                    Array.isArray(value) ? value.map(stringifyArgValue) : [stringifyArgValue(value)]
                ),
            ];
            matched = stringParts.some((part) =>
                includesString(part, current.query, current.caseSensitive)
            );
        }
        if (matched) {
            resultKeys.push(key);
        }
    }

    return {
        ...current,
        resultKeys,
        activeResultIndex:
            resultKeys.length === 0
                ? 0
                : Math.min(current.activeResultIndex, resultKeys.length - 1),
    };
};

export const buildSearchState = (params: {
    graph: ResolvedDocumentGraph | null;
    query: string;
    mode: "content" | "id";
    caseSensitive: boolean;
    focusOnly: boolean;
    activeResultIndex: number;
    tree: PersistedTreeModel | null;
}): GraphSearchState => {
    if (!params.graph) {
        return {
            query: params.query,
            mode: params.mode,
            caseSensitive: params.caseSensitive,
            focusOnly: params.focusOnly,
            resultKeys: [],
            activeResultIndex: 0,
        };
    }

    return computeSearchState(
        params.graph,
        {
            query: params.query,
            mode: params.mode,
            caseSensitive: params.caseSensitive,
            focusOnly: params.focusOnly,
            resultKeys: [],
            activeResultIndex: params.activeResultIndex,
        },
        params.tree
    );
};
