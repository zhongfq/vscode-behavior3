export interface NodeData {
    id: string;
    name: string;
    desc?: string;
    args?: { [key: string]: unknown };
    input?: string[];
    output?: string[];
    children?: NodeData[];
    debug?: boolean;
    disabled?: boolean;
    path?: string;

    // Stable node identity, for overrides
    uuid: string;

    // for runtime
    $mtime?: number;
    $size?: number[];
    $status?: number;
}

export interface VarDecl {
    name: string;
    desc: string;
}

export interface TreeVariables {
    imports: string[];
    locals: VarDecl[];
}

export interface GroupDecl {
    name: string;
    value: boolean;
}

export interface ImportDecl {
    path: string;
    modified?: number;
    vars: VarDecl[];
    depends: {
        path: string;
        modified: number;
    }[];
}

export interface FileVarDecl {
    import: ImportDecl[];
    subtree: ImportDecl[];
    vars: VarDecl[];
}

export interface TreeData {
    version: string;
    name: string;
    prefix: string;
    desc?: string;
    export?: boolean;
    group: string[];
    variables: TreeVariables;
    custom: Record<string, string | number | boolean | object>;
    root: NodeData;

    overrides: {
        [key: string]: Pick<NodeData, "desc" | "input" | "output" | "args" | "debug" | "disabled">;
    };
}
