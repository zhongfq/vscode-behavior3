/**
 * Node `fs` is only available in the extension host. Webview never calls `setFs`;
 * use `hasFs()` before any disk path in shared code.
 */
import type { FsLike } from "./b3build-model";

export type { FsLike } from "./b3build-model";

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
