import type { NodeDef } from "behavior3";
import type { NodeData, TreeData } from "./b3model";

export type NodeArg = Exclude<NodeDef["args"], undefined>[number];

export type BuildLogger = {
    log: (...args: unknown[]) => void;
    debug: (...args: unknown[]) => void;
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
};

export type FsLike = {
    readFileSync(path: string, encoding: "utf8" | "utf-8"): string;
    writeFileSync(path: string, data: string, encoding?: "utf8" | "utf-8"): void;
    readdirSync(path: string): string[];
    readdirSync(path: string, options: { encoding: "utf8" | "utf-8"; recursive?: boolean }): string[];
    statSync(path: string): { mtimeMs: number; isFile(): boolean };
    mkdirSync(path: string, options?: { recursive?: boolean }): unknown;
    copyFileSync(source: string, destination: string): void;
    unlinkSync(path: string): void;
};

export type PathLike = {
    [key: string]: unknown;
    basename(path: string, suffix?: string): string;
    basenameWithoutExt(path: string): string;
    dirname(path: string): string;
    extname(path: string): string;
    isAbsolute(path: string): boolean;
    join(...paths: string[]): string;
    lsdir(path: string, recursive?: boolean): string[];
    normalize(path: string): string;
    posixPath(path: string): string;
    relative(from: string, to: string): string;
    resolve(...paths: string[]): string;
};

export type BuildEnv = {
    fs: FsLike;
    path: PathLike;
    workdir: string;
    nodeDefs: ReadonlyMap<string, NodeDef>;
    logger: BuildLogger;
};

export type NodeArgCheckResult = string | string[] | null | undefined;

export type NodeArgCheckContext = {
    node: NodeData;
    tree: TreeData;
    nodeDef: NodeDef;
    arg: NodeArg;
    argName: string;
    treePath: string;
    env: BuildEnv;
};

export interface NodeArgChecker {
    validate(value: unknown, ctx: NodeArgCheckContext): NodeArgCheckResult;
}

export type BuildScript = {
    onProcessTree?: (tree: TreeData, path: string, errors: string[]) => TreeData | null;
    onProcessNode?: (node: NodeData, errors: string[]) => NodeData | null;
    onWriteFile?: (path: string, tree: TreeData) => void;
    onComplete?: (status: "success" | "failure") => void;
};

export type BuildHookClass<T extends BuildScript = BuildScript> = new (...args: any[]) => T;
export type NodeArgCheckerClass<T extends NodeArgChecker = NodeArgChecker> = new (
    ...args: any[]
) => T;

export type BuildDecorator = {
    <T extends BuildHookClass>(target: T): T | void;
    <T extends BuildHookClass>(target: T, context: ClassDecoratorContext<T>): T | void;
};

export type CheckDecorator = {
    <T extends NodeArgCheckerClass>(target: T): T | void;
    <T extends NodeArgCheckerClass>(target: T, context: ClassDecoratorContext<T>): T | void;
    (name?: string): <T extends NodeArgCheckerClass>(target: T) => T | void;
};

export type BuildRuntime = {
    build: BuildDecorator;
    check: CheckDecorator;
};

export declare class Hook implements BuildScript {
    constructor(env: BuildEnv);
    onProcessTree?(tree: TreeData, path: string, errors: string[]): TreeData | null;
    onProcessNode?(node: NodeData, errors: string[]): NodeData | null;
    onWriteFile?(path: string, tree: TreeData): void;
    onComplete?(status: "success" | "failure"): void;
}
