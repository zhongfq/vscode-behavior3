import { getFs } from "./b3fs";

type ParsedPath = {
    root: string;
    parts: string[];
    absolute: boolean;
};

type B3Path = {
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

const toSlashes = (value: string) => value.replace(/\\/g, "/");

const parsePath = (value: string): ParsedPath => {
    const slashed = toSlashes(value);
    const driveMatch = /^([A-Za-z]:)(?:\/|$)/.exec(slashed);
    const root = driveMatch ? `${driveMatch[1]}/` : slashed.startsWith("/") ? "/" : "";
    const body = root ? slashed.slice(root.length) : slashed;
    return {
        root,
        absolute: Boolean(root),
        parts: body.split("/").filter((part) => part.length > 0),
    };
};

const normalizeParts = (parts: string[], absolute: boolean) => {
    const normalized: string[] = [];
    for (const part of parts) {
        if (part === ".") {
            continue;
        }
        if (part === "..") {
            if (normalized.length && normalized[normalized.length - 1] !== "..") {
                normalized.pop();
            } else if (!absolute) {
                normalized.push(part);
            }
            continue;
        }
        normalized.push(part);
    }
    return normalized;
};

const formatPath = (root: string, parts: string[], fallback = ".") => {
    if (root) {
        return root + parts.join("/");
    }
    return parts.join("/") || fallback;
};

const normalize = (value: string) => {
    const parsed = parsePath(value);
    const parts = normalizeParts(parsed.parts, parsed.absolute);
    return formatPath(parsed.root, parts);
};

const posixPath = (value: string) => normalize(value);

const isAbsolute = (value: string) => parsePath(value).absolute;

const dirname = (value: string) => {
    const normalized = normalize(value);
    const parsed = parsePath(normalized);
    const parts = normalizeParts(parsed.parts, parsed.absolute);
    parts.pop();
    return formatPath(parsed.root, parts, ".");
};

const basename = (value: string, suffix?: string) => {
    const normalized = normalize(value).replace(/\/+$/, "");
    const base = normalized.slice(normalized.lastIndexOf("/") + 1);
    if (suffix && base.endsWith(suffix)) {
        return base.slice(0, -suffix.length);
    }
    return base;
};

const extname = (value: string) => {
    const base = basename(value);
    const index = base.lastIndexOf(".");
    if (index <= 0) {
        return "";
    }
    return base.slice(index);
};

const basenameWithoutExt = (value: string) => basename(value, extname(value));

const join = (...paths: string[]) => {
    const joined = paths.filter((part) => part.length > 0).join("/");
    return normalize(joined);
};

const resolve = (...paths: string[]) => {
    let resolved = "";
    for (const part of paths) {
        if (!part) {
            continue;
        }
        resolved = isAbsolute(part) ? part : join(resolved, part);
    }
    return normalize(resolved);
};

const relative = (from: string, to: string) => {
    const fromParsed = parsePath(normalize(from));
    const toParsed = parsePath(normalize(to));
    if (fromParsed.root.toLowerCase() !== toParsed.root.toLowerCase()) {
        return normalize(to);
    }

    const fromParts = normalizeParts(fromParsed.parts, fromParsed.absolute);
    const toParts = normalizeParts(toParsed.parts, toParsed.absolute);
    let index = 0;
    while (index < fromParts.length && fromParts[index] === toParts[index]) {
        index += 1;
    }
    const ups = fromParts.slice(index).map(() => "..");
    const downs = toParts.slice(index);
    return [...ups, ...downs].join("/") || "";
};

const lsdir = (dir: string, recursive?: boolean) => {
    const fs = getFs();
    return fs
        .readdirSync(dir, { encoding: "utf8", recursive })
        .map((file) => posixPath(join(dir, file)))
        .sort();
};

const b3path: B3Path = {
    basename,
    basenameWithoutExt,
    dirname,
    extname,
    isAbsolute,
    join,
    lsdir,
    normalize,
    posixPath,
    relative,
    resolve,
};

export default b3path;
