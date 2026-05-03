export type BuildLogger = {
  log: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

export type BuildScriptEnv = {
  fs: typeof import("fs");
  path: {
    [key: string]: unknown;
    join: (...paths: string[]) => string;
    dirname: (p: string) => string;
    basename: (p: string) => string;
    extname: (p: string) => string;
    relative: (from: string, to: string) => string;
    normalize: (p: string) => string;
    resolve: (...paths: string[]) => string;
  };
  workdir: string;
  nodeDefs: Map<string, unknown>;
  logger: BuildLogger;
};

export type BuildNode = {
  id: string;
  name: string;
  desc?: string;
  args?: Record<string, unknown>;
  input?: string[];
  output?: string[];
  children?: BuildNode[];
  debug?: boolean;
  disabled?: boolean;
  path?: string;
};

export type BuildTree = {
  version: string;
  name: string;
  desc?: string;
  export?: boolean;
  prefix: string;
  group: string[];
  variables: {
    imports: string[];
    locals: Array<{ name: string; desc: string }>;
  };
  root: BuildNode;
};

export type BatchScript = {
  onProcessTree?: (tree: BuildTree, path: string, errors: string[]) => BuildTree | null;
  onProcessNode?: (node: BuildNode, errors: string[]) => BuildNode | null;
  onWriteFile?: (path: string, tree: BuildTree) => void;
  onComplete?: (status: "success" | "failure") => void;
};

export declare class Hook implements BatchScript {
  constructor(env: BuildScriptEnv);
  onProcessTree?(tree: BuildTree, path: string, errors: string[]): BuildTree | null;
  onProcessNode?(node: BuildNode, errors: string[]): BuildNode | null;
  onWriteFile?(path: string, tree: BuildTree): void;
  onComplete?(status: "success" | "failure"): void;
}
