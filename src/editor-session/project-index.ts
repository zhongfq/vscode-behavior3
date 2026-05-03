import * as path from "path";
import * as vscode from "vscode";
import type { PersistedNodeModel, PersistedTreeModel } from "../../webview/shared/contracts";
import { isBehaviorTreeJsonPath } from "../../webview/shared/misc/behavior-tree-files";
import { normalizeWorkdirRelativePath } from "../../webview/shared/protocol";
import {
    collectReachableSubtreePaths,
    collectTransitivePaths,
    parsePersistedTreeContent,
} from "../../webview/shared/tree";

/**
 * Extension-host cache for project tree files.
 * It serves var-decl lookups and subtree dependency tracking without reparsing
 * the same JSON repeatedly across watchers and webview requests.
 */
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

const collectSubtreePaths = (node: PersistedNodeModel | undefined): string[] =>
    node ? collectReachableSubtreePaths(node) : [];

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
                if (relativePath && isBehaviorTreeJsonPath(relativePath)) {
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
        /** Used by watchers to decide which external subtree edits affect this editor. */
        const loaded = new Set<string>();

        let tree: PersistedTreeModel;
        try {
            tree = parsePersistedTreeContent(mainContent);
        } catch {
            return loaded;
        }

        const orderedPaths = await collectTransitivePaths(
            collectSubtreePaths(tree.root).map((subtreePath) =>
                normalizeWorkdirRelativePath(subtreePath)
            ),
            async (relativePath) => {
                const subtree = await this.readTreeFile(relativePath);
                return subtree?.root
                    ? collectSubtreePaths(subtree.root).map((childPath) =>
                          normalizeWorkdirRelativePath(childPath)
                      )
                    : [];
            }
        );

        for (const relativePath of orderedPaths) {
            loaded.add(relativePath);
        }

        return loaded;
    }

    async buildUsingVars(mainContent: string): Promise<VarDeclResult | null> {
        /**
         * Build the merged variable view exposed to the webview while also
         * returning ordered import/subtree declarations for inspection UIs.
         */
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

        /** Cache both parse success and parse failure so repeated lookups stay cheap. */
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
        return collectTransitivePaths(
            seedImports.map((importPath) => normalizeWorkdirRelativePath(importPath)),
            async (relativePath) => {
                const tree = await this.readTreeFile(relativePath);
                return (tree?.import ?? []).map((importPath) =>
                    normalizeWorkdirRelativePath(importPath)
                );
            }
        );
    }

    private async collectOrderedTransitiveSubtreePaths(
        root: PersistedNodeModel | undefined
    ): Promise<string[]> {
        /** Preserve traversal order so the UI shows subtree declarations deterministically. */
        return collectTransitivePaths(
            collectSubtreePaths(root).map((subtreePath) => normalizeWorkdirRelativePath(subtreePath)),
            async (relativePath) => {
                const tree = await this.readTreeFile(relativePath);
                return tree?.root
                    ? collectSubtreePaths(tree.root).map((subtreePath) =>
                          normalizeWorkdirRelativePath(subtreePath)
                      )
                    : [];
            }
        );
    }
}
