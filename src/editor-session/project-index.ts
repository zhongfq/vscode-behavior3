import * as path from "path";
import * as vscode from "vscode";
import type { PersistedNodeModel, PersistedTreeModel } from "../../webview/shared/contracts";
import { normalizeWorkdirRelativePath } from "../../webview/shared/protocol";
import { parsePersistedTreeContent } from "../../webview/shared/tree";

export interface VarDeclResult {
    usingVars: Record<string, { name: string; desc: string }>;
    importDecls: Array<{ path: string; vars: Array<{ name: string; desc: string }> }>;
    subtreeDecls: Array<{ path: string; vars: Array<{ name: string; desc: string }> }>;
}

interface CachedTreeEntry {
    content: string;
    tree: PersistedTreeModel | null;
}

const isSameUri = (left: vscode.Uri, right: vscode.Uri) =>
    left.fsPath === right.fsPath || left.toString() === right.toString();

const collectSubtreePaths = (node: PersistedNodeModel | undefined): string[] => {
    if (!node) {
        return [];
    }

    const paths: string[] = [];
    const stack: PersistedNodeModel[] = [node];
    while (stack.length > 0) {
        const current = stack.pop()!;
        if (current.path) {
            paths.push(current.path);
        }
        current.children?.forEach((child) => stack.push(child));
    }
    return paths;
};

export class ProjectIndex {
    private readonly treeCache = new Map<string, CachedTreeEntry>();
    private allFilesCache: string[] | null = null;

    constructor(private readonly workdir: vscode.Uri) {}

    invalidateFile(uri: vscode.Uri): void {
        const relativePath = this.uriToWorkdirRelative(uri);
        if (!relativePath) {
            return;
        }
        this.treeCache.delete(relativePath);
        this.allFilesCache = null;
    }

    clear(): void {
        this.treeCache.clear();
        this.allFilesCache = null;
    }

    async getAllFiles(): Promise<string[]> {
        if (this.allFilesCache) {
            return [...this.allFilesCache];
        }

        const allFiles: string[] = [];
        try {
            const uris = await vscode.workspace.findFiles(
                new vscode.RelativePattern(this.workdir, "**/*.json"),
                "**/node_modules/**"
            );
            for (const uri of uris) {
                const relativePath = this.uriToWorkdirRelative(uri);
                if (relativePath) {
                    allFiles.push(relativePath);
                }
            }
            allFiles.sort();
        } catch {
            // workspace may not be open
        }

        this.allFilesCache = allFiles;
        return [...allFiles];
    }

    async getTransitiveSubtreeRelativePaths(mainContent: string): Promise<Set<string>> {
        const loaded = new Set<string>();

        let tree: PersistedTreeModel;
        try {
            tree = parsePersistedTreeContent(mainContent);
        } catch {
            return loaded;
        }

        const pending = new Set<string>();
        for (const subtreePath of collectSubtreePaths(tree.root)) {
            pending.add(normalizeWorkdirRelativePath(subtreePath));
        }

        while (pending.size > 0) {
            const iterator = pending.values().next();
            if (iterator.done) {
                break;
            }

            const relativePath = iterator.value;
            pending.delete(relativePath);
            if (loaded.has(relativePath)) {
                continue;
            }
            loaded.add(relativePath);

            const subtree = await this.readTreeFile(relativePath);
            if (!subtree) {
                continue;
            }

            for (const childPath of collectSubtreePaths(subtree.root)) {
                const normalizedPath = normalizeWorkdirRelativePath(childPath);
                if (!loaded.has(normalizedPath)) {
                    pending.add(normalizedPath);
                }
            }
        }

        return loaded;
    }

    async buildUsingVars(mainContent: string): Promise<VarDeclResult | null> {
        let tree: PersistedTreeModel;
        try {
            tree = parsePersistedTreeContent(mainContent);
        } catch {
            return null;
        }

        const usingVars: Record<string, { name: string; desc: string }> = {};
        for (const entry of tree.vars ?? []) {
            if (entry.name) {
                usingVars[entry.name] = { name: entry.name, desc: entry.desc ?? "" };
            }
        }

        const visited = new Set<string>();
        const importSeeds = (tree.import ?? []).filter((entry): entry is string => typeof entry === "string");

        for (const importPath of importSeeds) {
            await this.readVarsFromFile(importPath, visited, usingVars);
        }

        for (const subtreePath of collectSubtreePaths(tree.root)) {
            await this.readVarsFromFile(subtreePath, visited, usingVars);
        }

        const importDecls = (
            await this.collectOrderedTransitiveImportPaths(importSeeds)
        ).map((relativePath) => ({
            path: relativePath,
            vars: this.getLocalVarsFromTree(relativePath),
        }));

        const subtreeDecls = (
            await this.collectOrderedTransitiveSubtreePaths(tree.root)
        ).map((relativePath) => ({
            path: relativePath,
            vars: this.getLocalVarsFromTree(relativePath),
        }));

        return {
            usingVars,
            importDecls,
            subtreeDecls,
        };
    }

    private uriToWorkdirRelative(uri: vscode.Uri): string | undefined {
        if (uri.scheme !== "file") {
            return undefined;
        }
        const relativePath = path.relative(this.workdir.fsPath, uri.fsPath).replace(/\\/g, "/");
        if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
            return undefined;
        }
        return normalizeWorkdirRelativePath(relativePath);
    }

    private async readWorkspaceFileContent(fileUri: vscode.Uri): Promise<string> {
        const openDocument = vscode.workspace.textDocuments.find((document) =>
            isSameUri(document.uri, fileUri)
        );

        if (openDocument) {
            return openDocument.getText();
        }

        const raw = await vscode.workspace.fs.readFile(fileUri);
        return Buffer.from(raw).toString("utf-8");
    }

    private async readTreeFile(relativePath: string): Promise<PersistedTreeModel | null> {
        const normalizedPath = normalizeWorkdirRelativePath(relativePath);
        const fileUri = vscode.Uri.joinPath(this.workdir, normalizedPath);
        const content = await this.readWorkspaceFileContent(fileUri).catch(() => null);
        if (content === null) {
            this.treeCache.set(normalizedPath, {
                content: "",
                tree: null,
            });
            return null;
        }

        const cached = this.treeCache.get(normalizedPath);
        if (cached && cached.content === content) {
            return cached.tree;
        }

        try {
            const tree = parsePersistedTreeContent(content, normalizedPath);
            this.treeCache.set(normalizedPath, {
                content,
                tree,
            });
            return tree;
        } catch {
            this.treeCache.set(normalizedPath, {
                content,
                tree: null,
            });
            return null;
        }
    }

    private getLocalVarsFromTree(relativePath: string): Array<{ name: string; desc: string }> {
        const tree = this.treeCache.get(normalizeWorkdirRelativePath(relativePath))?.tree;
        if (!tree) {
            return [];
        }
        return (tree.vars ?? [])
            .filter((entry) => entry.name)
            .map((entry) => ({ name: entry.name, desc: entry.desc ?? "" }));
    }

    private async readVarsFromFile(
        relativePath: string,
        visitedForGlobal: Set<string>,
        globalVars: Record<string, { name: string; desc: string }>
    ): Promise<Array<{ name: string; desc: string }>> {
        const localVars: Array<{ name: string; desc: string }> = [];
        const normalizedPath = normalizeWorkdirRelativePath(relativePath);
        if (visitedForGlobal.has(normalizedPath)) {
            return localVars;
        }
        visitedForGlobal.add(normalizedPath);

        const tree = await this.readTreeFile(normalizedPath);
        if (!tree) {
            return localVars;
        }

        for (const entry of tree.vars ?? []) {
            if (!entry.name) {
                continue;
            }
            const variable = { name: entry.name, desc: entry.desc ?? "" };
            localVars.push(variable);
            if (!globalVars[entry.name]) {
                globalVars[entry.name] = variable;
            }
        }

        for (const importPath of tree.import ?? []) {
            await this.readVarsFromFile(importPath, visitedForGlobal, globalVars);
        }

        for (const subtreePath of collectSubtreePaths(tree.root)) {
            await this.readVarsFromFile(subtreePath, visitedForGlobal, globalVars);
        }

        return localVars;
    }

    private async collectOrderedTransitiveImportPaths(seedImports: string[]): Promise<string[]> {
        const ordered: string[] = [];
        const seen = new Set<string>();
        const queue: string[] = [];

        for (const importPath of seedImports) {
            const normalizedPath = normalizeWorkdirRelativePath(importPath);
            if (!seen.has(normalizedPath)) {
                seen.add(normalizedPath);
                queue.push(normalizedPath);
            }
        }

        while (queue.length > 0) {
            const relativePath = queue.shift()!;
            ordered.push(relativePath);

            const tree = await this.readTreeFile(relativePath);
            if (!tree) {
                continue;
            }

            for (const importPath of tree.import ?? []) {
                const normalizedPath = normalizeWorkdirRelativePath(importPath);
                if (!seen.has(normalizedPath)) {
                    seen.add(normalizedPath);
                    queue.push(normalizedPath);
                }
            }
        }

        return ordered;
    }

    private async collectOrderedTransitiveSubtreePaths(
        root: PersistedNodeModel | undefined
    ): Promise<string[]> {
        const ordered: string[] = [];
        const seen = new Set<string>();
        const queue: string[] = [];

        for (const subtreePath of collectSubtreePaths(root)) {
            const normalizedPath = normalizeWorkdirRelativePath(subtreePath);
            if (!seen.has(normalizedPath)) {
                seen.add(normalizedPath);
                queue.push(normalizedPath);
            }
        }

        while (queue.length > 0) {
            const relativePath = queue.shift()!;
            ordered.push(relativePath);

            const tree = await this.readTreeFile(relativePath);
            if (!tree) {
                continue;
            }

            for (const subtreePath of collectSubtreePaths(tree.root)) {
                const normalizedPath = normalizeWorkdirRelativePath(subtreePath);
                if (!seen.has(normalizedPath)) {
                    seen.add(normalizedPath);
                    queue.push(normalizedPath);
                }
            }
        }

        return ordered;
    }
}
