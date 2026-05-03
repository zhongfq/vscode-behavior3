import type { NodeDef } from "behavior3";
import type { NodeData, TreeData, VarDecl, WorkspaceModel } from "./misc/b3type";
import { generateUuid } from "./stable-id";

const NODE_DEF_TYPES = new Set<NodeDef["type"]>(["Action", "Decorator", "Condition", "Composite"]);
const NODE_STATUS_VALUES = new Set<NonNullable<NonNullable<NodeDef["status"]>[number]>>([
    "success",
    "failure",
    "running",
    "!success",
    "!failure",
    "|success",
    "|failure",
    "|running",
    "&success",
    "&failure",
]);
const NODE_ARG_TYPE_PATTERN = /^(bool|boolean|int|float|string|json|expr|code)(\[\])?(\?)?$/;
const CHILDREN_ARITIES = new Set<NonNullable<NodeDef["children"]>>([-1, 0, 1, 2, 3]);

type PlainRecord = Record<string, unknown>;

const isPlainRecord = (value: unknown): value is PlainRecord => {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
};

const expectPlainRecord = (value: unknown, label: string): PlainRecord => {
    if (!isPlainRecord(value)) {
        throw new Error(`${label} must be an object`);
    }
    return value;
};

const asOptionalString = (value: unknown): string | undefined => {
    return typeof value === "string" ? value : undefined;
};

const asRequiredString = (value: unknown, label: string): string => {
    if (typeof value !== "string" || !value.trim()) {
        throw new Error(`${label} must be a non-empty string`);
    }
    return value;
};

const asStringArray = (value: unknown, label: string): string[] => {
    if (value === undefined) {
        return [];
    }
    if (!Array.isArray(value)) {
        throw new Error(`${label} must be an array`);
    }
    return value.map((entry, index) => {
        if (typeof entry !== "string") {
            throw new Error(`${label}[${index}] must be a string`);
        }
        return entry;
    });
};

const asVarDeclArray = (value: unknown, label: string): VarDecl[] => {
    if (value === undefined) {
        return [];
    }
    if (!Array.isArray(value)) {
        throw new Error(`${label} must be an array`);
    }

    return value.map((entry, index) => {
        const record = expectPlainRecord(entry, `${label}[${index}]`);
        return {
            name: asRequiredString(record.name, `${label}[${index}].name`),
            desc: asOptionalString(record.desc) ?? "",
        };
    });
};

const normalizeNodeArgType = (value: string): string => {
    const normalized = value.replace(/^code/, "expr").replace(/^boolean/, "bool");
    if (!NODE_ARG_TYPE_PATTERN.test(value)) {
        throw new Error(`unsupported node arg type: ${value}`);
    }
    return normalized;
};

const normalizeNodeArgOptions = (
    value: unknown,
    label: string
): NonNullable<NonNullable<NodeDef["args"]>[number]["options"]> | undefined => {
    if (value === undefined) {
        return undefined;
    }
    if (!Array.isArray(value)) {
        throw new Error(`${label} must be an array`);
    }
    if (value.length === 0) {
        return [];
    }

    const first = value[0];
    if (isPlainRecord(first) && !("source" in first)) {
        return [
            {
                source: value.map((entry, index) => {
                    const option = expectPlainRecord(entry, `${label}[${index}]`);
                    return {
                        name: asRequiredString(option.name, `${label}[${index}].name`),
                        value: option.value,
                    };
                }),
            },
        ];
    }

    return value.map((entry, index) => {
        const option = expectPlainRecord(entry, `${label}[${index}]`);
        const source = option.source;
        if (!Array.isArray(source)) {
            throw new Error(`${label}[${index}].source must be an array`);
        }

        const match = option.match;
        const normalizedMatch: Record<string, unknown[]> | undefined = match
            ? Object.fromEntries(
                  Object.entries(expectPlainRecord(match, `${label}[${index}].match`)).map(
                      ([key, matchValue]) => {
                          if (!Array.isArray(matchValue)) {
                              throw new Error(`${label}[${index}].match.${key} must be an array`);
                          }
                          return [key, [...matchValue]];
                      }
                  )
              )
            : undefined;

        return {
            match: normalizedMatch,
            source: source.map((sourceEntry, sourceIndex) => {
                const sourceRecord = expectPlainRecord(
                    sourceEntry,
                    `${label}[${index}].source[${sourceIndex}]`
                );
                return {
                    name: asRequiredString(
                        sourceRecord.name,
                        `${label}[${index}].source[${sourceIndex}].name`
                    ),
                    value: sourceRecord.value,
                };
            }),
        };
    });
};

const normalizeNodeArgs = (value: unknown, label: string): NodeDef["args"] | undefined => {
    if (value === undefined) {
        return undefined;
    }
    if (!Array.isArray(value)) {
        throw new Error(`${label} must be an array`);
    }

    return value.map((entry, index) => {
        const record = expectPlainRecord(entry, `${label}[${index}]`);
        const type = normalizeNodeArgType(
            asRequiredString(record.type, `${label}[${index}].type`)
        ) as NonNullable<NonNullable<NodeDef["args"]>[number]>["type"];

        return {
            name: asRequiredString(record.name, `${label}[${index}].name`),
            type,
            desc: asOptionalString(record.desc) ?? "",
            oneof: asOptionalString(record.oneof),
            default: record.default,
            options: normalizeNodeArgOptions(record.options, `${label}[${index}].options`),
        };
    });
};

const normalizeNodeDef = (value: unknown, label: string): NodeDef => {
    const record = expectPlainRecord(value, label);
    const type = asRequiredString(record.type, `${label}.type`) as NodeDef["type"];
    if (!NODE_DEF_TYPES.has(type)) {
        throw new Error(`${label}.type must be one of ${Array.from(NODE_DEF_TYPES).join(", ")}`);
    }

    const groupValue = record.group;
    const group =
        groupValue === undefined
            ? undefined
            : Array.isArray(groupValue)
              ? groupValue.map((entry, index) =>
                    asRequiredString(entry, `${label}.group[${index}]`)
                )
              : [asRequiredString(groupValue, `${label}.group`)];

    const childrenValue = record.children;
    if (childrenValue !== undefined && !CHILDREN_ARITIES.has(childrenValue as never)) {
        throw new Error(`${label}.children must be one of -1, 0, 1, 2, 3`);
    }

    const statusValue = record.status;
    const status =
        statusValue === undefined
            ? undefined
            : asStringArray(statusValue, `${label}.status`).map((entry) => {
                  if (!NODE_STATUS_VALUES.has(entry as never)) {
                      throw new Error(`${label}.status contains unsupported value: ${entry}`);
                  }
                  return entry as NonNullable<NodeDef["status"]>[number];
              });

    return {
        name: asRequiredString(record.name, `${label}.name`),
        type,
        desc: asOptionalString(record.desc) ?? "",
        input: (() => {
            const input = asStringArray(record.input, `${label}.input`);
            return input.length > 0 ? input : undefined;
        })(),
        output: (() => {
            const output = asStringArray(record.output, `${label}.output`);
            return output.length > 0 ? output : undefined;
        })(),
        args: normalizeNodeArgs(record.args, `${label}.args`),
        doc: asOptionalString(record.doc),
        icon: asOptionalString(record.icon),
        color: asOptionalString(record.color),
        group,
        status,
        children: childrenValue as NodeDef["children"],
    };
};

const normalizeOverrideMap = (value: unknown, label: string): TreeData["overrides"] => {
    if (value === undefined) {
        return {};
    }

    const record = expectPlainRecord(value, label);
    const normalized: TreeData["overrides"] = {};

    for (const [key, entry] of Object.entries(record)) {
        const patch = expectPlainRecord(entry, `${label}.${key}`);
        const argsValue = patch.args;
        if (argsValue !== undefined && !isPlainRecord(argsValue)) {
            throw new Error(`${label}.${key}.args must be an object`);
        }

        normalized[key] = {
            desc: asOptionalString(patch.desc),
            input:
                patch.input === undefined
                    ? undefined
                    : asStringArray(patch.input, `${label}.${key}.input`),
            output:
                patch.output === undefined
                    ? undefined
                    : asStringArray(patch.output, `${label}.${key}.output`),
            args: argsValue ? { ...argsValue } : undefined,
            debug: typeof patch.debug === "boolean" ? patch.debug : undefined,
            disabled: typeof patch.disabled === "boolean" ? patch.disabled : undefined,
        };
    }

    return normalized;
};

const normalizeCustomRecord = (value: unknown): TreeData["custom"] => {
    if (value === undefined) {
        return {};
    }

    const record = expectPlainRecord(value, "tree file custom");
    const normalized: TreeData["custom"] = {};
    for (const [key, entry] of Object.entries(record)) {
        if (typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean") {
            normalized[key] = entry;
            continue;
        }
        if (entry && typeof entry === "object") {
            normalized[key] = entry;
            continue;
        }
        throw new Error(`tree file custom.${key} must be a string, number, boolean, or object`);
    }
    return normalized;
};

const normalizeStableUuid = (record: PlainRecord): string => {
    if (typeof record.uuid === "string" && record.uuid) {
        return record.uuid;
    }
    if (typeof record.$id === "string" && record.$id) {
        return record.$id;
    }
    return generateUuid();
};

const normalizeNodeData = (value: unknown, label: string): NodeData => {
    const record = expectPlainRecord(value, label);
    const argsValue = record.args;
    if (argsValue !== undefined && !isPlainRecord(argsValue)) {
        throw new Error(`${label}.args must be an object`);
    }

    const childrenValue = record.children;
    if (childrenValue !== undefined && !Array.isArray(childrenValue)) {
        throw new Error(`${label}.children must be an array`);
    }

    return {
        uuid: normalizeStableUuid(record),
        id: record.id === undefined ? "" : String(record.id),
        name: asRequiredString(record.name, `${label}.name`),
        desc: asOptionalString(record.desc),
        args: argsValue ? { ...argsValue } : undefined,
        input: (() => {
            const input = asStringArray(record.input, `${label}.input`);
            return input.length > 0 ? input : undefined;
        })(),
        output: (() => {
            const output = asStringArray(record.output, `${label}.output`);
            return output.length > 0 ? output : undefined;
        })(),
        children:
            childrenValue?.map((child, index) =>
                normalizeNodeData(child, `${label}.children[${index}]`)
            ) ?? [],
        debug: typeof record.debug === "boolean" ? record.debug : undefined,
        disabled: typeof record.disabled === "boolean" ? record.disabled : undefined,
        path: typeof record.path === "string" && record.path.trim() ? record.path : undefined,
        $status:
            typeof record.$status === "number" && Number.isFinite(record.$status)
                ? record.$status
                : undefined,
    };
};

export const normalizeNodeDefCollection = (value: unknown): NodeDef[] => {
    const nodes = Array.isArray(value)
        ? value
        : expectPlainRecord(value, "node definition file").nodes;

    if (!Array.isArray(nodes)) {
        throw new Error("node definition file must be an array or an object with a nodes array");
    }

    return nodes.map((entry, index) => normalizeNodeDef(entry, `nodes[${index}]`));
};

export const parseNodeDefsContent = (content: string): NodeDef[] => {
    return normalizeNodeDefCollection(JSON.parse(content) as unknown);
};

export const normalizeWorkspaceModel = (value: unknown): WorkspaceModel => {
    const record = expectPlainRecord(value, "workspace file");
    const settingsValue = record.settings;
    if (settingsValue !== undefined && !isPlainRecord(settingsValue)) {
        throw new Error("workspace file settings must be an object");
    }

    const settingsRecord = (settingsValue ?? {}) as PlainRecord;
    const nodeColorsValue = settingsRecord.nodeColors;
    if (nodeColorsValue !== undefined && !isPlainRecord(nodeColorsValue)) {
        throw new Error("workspace settings.nodeColors must be an object");
    }

    return {
        settings: {
            checkExpr:
                typeof settingsRecord.checkExpr === "boolean"
                    ? settingsRecord.checkExpr
                    : undefined,
            buildScript: asOptionalString(settingsRecord.buildScript),
            nodeColors: nodeColorsValue
                ? Object.fromEntries(
                      Object.entries(nodeColorsValue).map(([key, color]) => {
                          if (typeof color !== "string") {
                              throw new Error(
                                  `workspace settings.nodeColors.${key} must be a string`
                              );
                          }
                          return [key, color];
                      })
                  )
                : undefined,
        },
    };
};

export const parseWorkspaceModelContent = (content: string): WorkspaceModel => {
    return normalizeWorkspaceModel(JSON.parse(content) as unknown);
};

export const normalizeTreeData = (value: unknown): TreeData => {
    const record = expectPlainRecord(value, "tree file");
    const overridesValue = record.overrides === undefined ? record.$override : record.overrides;
    const variablesValue = record.variables;
    const variablesRecord =
        variablesValue === undefined
            ? undefined
            : expectPlainRecord(variablesValue, "tree file variables");

    return {
        version: asRequiredString(record.version, "tree file version"),
        name: asRequiredString(record.name, "tree file name"),
        prefix: asOptionalString(record.prefix) ?? "",
        desc: asOptionalString(record.desc),
        export: typeof record.export === "boolean" ? record.export : undefined,
        group: asStringArray(record.group, "tree file group"),
        variables: {
            imports: asStringArray(
                variablesRecord?.imports ?? record.import,
                variablesRecord ? "tree file variables.imports" : "tree file import"
            ),
            locals: asVarDeclArray(
                variablesRecord?.locals ?? record.vars,
                variablesRecord ? "tree file variables.locals" : "tree file vars"
            ),
        },
        custom: normalizeCustomRecord(record.custom),
        root: normalizeNodeData(record.root, "tree file root"),
        overrides: normalizeOverrideMap(overridesValue, "tree file overrides"),
    };
};

export const parseTreeContent = (content: string): TreeData => {
    return normalizeTreeData(JSON.parse(content) as unknown);
};
