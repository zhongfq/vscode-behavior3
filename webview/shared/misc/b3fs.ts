/**
 * Node `fs` is only available in the extension host. Webview never calls `setFs`;
 * use `hasFs()` before any disk path in shared code.
 */
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

let impl: FsLike | null = null;

export function setFs(fs: FsLike): void {
    impl = fs;
}

export function hasFs(): boolean {
    return impl !== null;
}

export function getFs(): FsLike {
    if (!impl) {
        throw new Error(
            "[b3fs] Node fs not set. Extension build must call setFs(require('fs')) first."
        );
    }
    return impl;
}
