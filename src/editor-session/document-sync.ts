import * as vscode from "vscode";
import { stringifyJson } from "../../webview/shared/misc/stringify";
import { basenameWithoutExt, readTree, writeTree } from "../../webview/shared/misc/util";

interface SuppressedDocumentChange {
    raw: string;
    normalizedLineEndings: string;
    canonicalJson: string | null;
}

const normalizeLineEndings = (content: string): string => {
    return content.replace(/\r\n/g, "\n");
};

const normalizeJsonContent = (content: string): string | null => {
    try {
        return stringifyJson(JSON.parse(content), { indent: 2 });
    } catch {
        return null;
    }
};

const normalizeJsonContentForWrite = (content: string): string => {
    return normalizeJsonContent(content) ?? content;
};

export const normalizeTreeContentForWrite = (content: string, filePath: string): string => {
    try {
        const tree = readTree(content);
        const name = basenameWithoutExt(filePath);
        tree.name = name;
        return writeTree(tree, name);
    } catch {
        return normalizeJsonContentForWrite(content);
    }
};

const buildSuppressedDocumentChange = (content: string): SuppressedDocumentChange => {
    return {
        raw: content,
        normalizedLineEndings: normalizeLineEndings(content),
        canonicalJson: normalizeJsonContent(content),
    };
};

const suppressedDocumentChangesMatch = (
    left: SuppressedDocumentChange,
    right: SuppressedDocumentChange
): boolean => {
    if (left.raw === right.raw) {
        return true;
    }

    if (left.normalizedLineEndings === right.normalizedLineEndings) {
        return true;
    }

    return (
        left.canonicalJson !== null &&
        right.canonicalJson !== null &&
        left.canonicalJson === right.canonicalJson
    );
};

export async function readFileContentFromDisk(fileUri: vscode.Uri): Promise<string> {
    const raw = await vscode.workspace.fs.readFile(fileUri);
    return Buffer.from(raw).toString("utf-8");
}

export class TreeEditorDocument implements vscode.CustomDocument {
    private _content: string;
    private _isDirty: boolean;
    private _ownFileWrites: SuppressedDocumentChange[] = [];

    constructor(
        public readonly uri: vscode.Uri,
        content: string,
        opts?: { dirty?: boolean }
    ) {
        this._content = content;
        this._isDirty = opts?.dirty ?? false;
    }

    get content(): string {
        return this._content;
    }

    get isDirty(): boolean {
        return this._isDirty;
    }

    updateContent(
        content: string,
        opts?: {
            markDirty?: boolean;
            markSaved?: boolean;
        }
    ): boolean {
        const changed = this._content !== content;
        this._content = content;

        if (opts?.markSaved) {
            this._isDirty = false;
        } else if (opts?.markDirty !== false && changed) {
            this._isDirty = true;
        }

        return changed;
    }

    markSaved(content = this._content): void {
        this._content = content;
        this._isDirty = false;
    }

    rememberOwnWrite(content: string): void {
        this._ownFileWrites.push(buildSuppressedDocumentChange(content));
    }

    consumeOwnWrite(content: string): boolean {
        const actualChange = buildSuppressedDocumentChange(content);
        const index = this._ownFileWrites.findIndex((change) =>
            suppressedDocumentChangesMatch(change, actualChange)
        );
        if (index < 0) {
            return false;
        }
        this._ownFileWrites.splice(index, 1);
        return true;
    }

    clearOwnWrites(): void {
        this._ownFileWrites = [];
    }

    dispose(): void {
        this.clearOwnWrites();
    }
}
