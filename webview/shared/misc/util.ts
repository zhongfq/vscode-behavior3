// Browser + extension host: string-based readTree for webview; file-based helpers use getFs (after setFs).
import { customAlphabet } from "nanoid";
import { VERSION, type TreeData, type WorkspaceModel } from "./b3type";
import { getFs } from "./b3fs";
import { createNode, dfs } from "./b3util";
import b3path from "./b3path";
import { stringifyJson } from "./stringify";

export const nanoid = customAlphabet(
  "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ",
  10
);

export const parseJson = <T>(text: string): T => {
  return JSON.parse(text) as T;
};

/**
 * 与原版 `writeTree` 写入磁盘的对象结构一致（version/name/root(createNode)/…），供 postMessage 等传对象用。
 */
export const treeDataForPersistence = (data: TreeData, name: string): TreeData => {
  return {
    version: VERSION,
    name,
    desc: data.desc,
    prefix: data.prefix,
    export: data.export,
    group: data.group,
    import: data.import,
    vars: data.vars,
    root: createNode(data.root),
    custom: data.custom,
    $override: data.$override,
  };
};

/** 原版：writeJson(writeTree(...)) → stringifyJson，禁止 JSON.stringify 整棵 editor.data */
export const writeTree = (data: TreeData, name: string): string => {
  return stringifyJson(treeDataForPersistence(data, name), { indent: 2 });
};

const applyTreeDefaults = (data: TreeData): TreeData => {
  data.version = data.version ?? VERSION;
  data.prefix = data.prefix ?? "";
  data.group = data.group || [];
  data.import = data.import || [];
  data.vars = data.vars || [];
  data.root = data.root || {};
  data.$override = data.$override || {};
  data.custom = data.custom || {};

  dfs(data.root, (node) => {
    node.id = node.id.toString();
    if (!node.$id) {
      node.$id = nanoid();
    }
  });

  return data;
};

/** Parse tree JSON from editor / postMessage string content. */
export const readTree = (text: string): TreeData => {
  return applyTreeDefaults(JSON.parse(text) as TreeData);
};

// ─── Node-only (after setFs) — used by buildProject / createBuildData ───

export const readJson = <T>(path: string): T => {
  const str = getFs().readFileSync(path, "utf-8");
  return JSON.parse(str) as T;
};

export const writeJson = <T>(path: string, data: T) => {
  const str = stringifyJson(data, { indent: 2 });
  getFs().writeFileSync(path, str, "utf-8");
};

export const readWorkspace = (path: string) => {
  const data = readJson(path) as WorkspaceModel;
  data.settings = data.settings ?? {};
  return data;
};

/** Load tree from disk path (extension build). */
export const readTreeFromFile = (path: string): TreeData => {
  return applyTreeDefaults(readJson(path) as TreeData);
};

export const writeTreeToFile = (path: string, data: TreeData) => {
  writeJson<TreeData>(path, {
    version: VERSION,
    name: b3path.basenameWithoutExt(path),
    desc: data.desc,
    prefix: data.prefix,
    export: data.export,
    group: data.group,
    import: data.import,
    vars: data.vars,
    root: data.root,
    custom: data.custom,
    $override: data.$override,
  });
};

export function mergeClassNames(...cls: (string | boolean)[]): string {
  return cls.filter((v) => !!v).join(" ");
}

/** Extract basename without extension from a file path */
export const basenameWithoutExt = (path: string): string => {
  const base = path.split(/[\\/]/).pop() ?? path;
  const dotIdx = base.lastIndexOf(".");
  return dotIdx > 0 ? base.slice(0, dotIdx) : base;
};

/** Get dirname from a file path */
export const dirname = (path: string): string => {
  const normalized = path.replace(/\\/g, "/");
  const idx = normalized.lastIndexOf("/");
  return idx >= 0 ? normalized.slice(0, idx) : ".";
};

/** Join path segments (posix style) */
export const joinPath = (...parts: string[]): string => {
  return parts.join("/").replace(/\/+/g, "/");
};

/** Get relative path from base to target */
export const relativePath = (from: string, to: string): string => {
  const fromParts = from.replace(/\\/g, "/").split("/");
  const toParts = to.replace(/\\/g, "/").split("/");
  let i = 0;
  while (i < fromParts.length && i < toParts.length && fromParts[i] === toParts[i]) {
    i++;
  }
  const ups = fromParts.length - i;
  const rel = [...Array(ups).fill(".."), ...toParts.slice(i)].join("/");
  return rel || ".";
};
