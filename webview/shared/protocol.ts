import type { HostToEditorMessage } from "../../src/types";
import type {
    HostInitPayload,
    HostVarsPayload,
    ImportDecl,
    NodeDef,
    Settings,
    WorkdirRelativeJsonPath,
} from "./contracts";

export const createRequestId = () => Math.random().toString(36).slice(2);

export const normalizeWorkdirRelativePath = (path: string): WorkdirRelativeJsonPath => {
    return path
        .replace(/\\/g, "/")
        .replace(/^[/\\]+/, "")
        .replace(/^\.\//, "");
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
