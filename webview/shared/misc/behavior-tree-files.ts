import b3path from "./b3path";

const SKIP_JSON_BASENAMES = new Set([
    "package.json",
    "package-lock.json",
    "jsconfig.json",
    "components.json",
]);

export const isBehaviorTreeJsonPath = (filePath: string): boolean => {
    const normalized = b3path.posixPath(filePath);
    if (!normalized.toLowerCase().endsWith(".json")) {
        return false;
    }

    const base = b3path.basename(normalized);
    const lowerBase = base.toLowerCase();
    if (SKIP_JSON_BASENAMES.has(lowerBase)) {
        return false;
    }

    if (lowerBase === "tsconfig.json" || /^tsconfig\..*\.json$/i.test(base)) {
        return false;
    }

    const lowerPath = `/${normalized.toLowerCase().replace(/^[/\\]+/, "")}`;
    return !["/.vscode/", "/.git/", "/node_modules/", "/dist/", "/build/"].some((marker) =>
        lowerPath.includes(marker)
    );
};
