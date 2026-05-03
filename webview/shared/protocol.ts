import type { HostToEditorMessage } from "./message-protocol";
import type {
    HostInitPayload,
    HostVarsPayload,
    ImportDecl,
    NodeDef,
    Settings,
    WorkdirRelativeJsonPath,
} from "./contracts";

const URI_SCHEME_PATTERN = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const WINDOWS_ABSOLUTE_PATTERN = /^[a-zA-Z]:[\\/]/;

const normalizeSeparators = (value: string): string => value.replace(/\\/g, "/");

export const parseWorkdirRelativeJsonPath = (
    value: unknown
): WorkdirRelativeJsonPath | null => {
    if (typeof value !== "string") {
        return null;
    }

    const raw = value.trim();
    if (!raw || raw.includes("\0")) {
        return null;
    }
    if (
        raw.startsWith("/") ||
        raw.startsWith("\\") ||
        WINDOWS_ABSOLUTE_PATTERN.test(raw) ||
        URI_SCHEME_PATTERN.test(raw)
    ) {
        return null;
    }

    let normalized = normalizeSeparators(raw);
    while (normalized.startsWith("./")) {
        normalized = normalized.slice(2);
    }
    if (!normalized || normalized.startsWith("/") || normalized.endsWith("/")) {
        return null;
    }

    const segments = normalized.split("/");
    if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
        return null;
    }
    if (!normalized.toLowerCase().endsWith(".json")) {
        return null;
    }

    return normalized as WorkdirRelativeJsonPath;
};

export const normalizeWorkdirRelativePath = (path: string): WorkdirRelativeJsonPath => {
    const normalized = parseWorkdirRelativeJsonPath(path);
    if (!normalized) {
        throw new Error(`Invalid workdir-relative JSON path: ${path}`);
    }
    return normalized;
};

export const deriveGroupDefs = (defs: NodeDef[]): string[] => {
    const groups = new Set<string>();
    for (const def of defs) {
        const maybeGroup = (def as NodeDef & { group?: string[] }).group;
        for (const group of maybeGroup ?? []) {
            groups.add(group);
        }
    }
    return Array.from(groups).sort();
};

export const normalizeImportDecl = (decl: {
    path: string;
    vars: Array<{ name: string; desc: string }>;
}): ImportDecl => {
    return {
        path: normalizeWorkdirRelativePath(decl.path),
        vars: decl.vars.map((entry) => ({ name: entry.name, desc: entry.desc ?? "" })),
        depends: [],
    };
};

export const normalizeHostInitMessage = (
    message: Extract<HostToEditorMessage, { type: "init" }>
): HostInitPayload => {
    const settings: Settings = {
        checkExpr: message.checkExpr,
        subtreeEditable: message.subtreeEditable,
        language: message.language,
        theme: message.theme,
        nodeColors: message.nodeColors,
    };

    return {
        filePath: message.filePath,
        workdir: message.workdir,
        content: message.content,
        nodeDefs: message.nodeDefs,
        allFiles: (message.allFiles ?? []).map(normalizeWorkdirRelativePath),
        settings,
    };
};

export const normalizeHostVarsMessage = (
    message: Extract<HostToEditorMessage, { type: "varDeclLoaded" }>
): HostVarsPayload => {
    const usingVars: HostVarsPayload["usingVars"] = {};
    for (const variable of message.usingVars) {
        usingVars[variable.name] = { name: variable.name, desc: variable.desc ?? "" };
    }

    return {
        usingVars,
        allFiles: message.allFiles?.map(normalizeWorkdirRelativePath),
        importDecls: (message.importDecls ?? []).map(normalizeImportDecl),
        subtreeDecls: (message.subtreeDecls ?? []).map(normalizeImportDecl),
    };
};
