import * as fs from "fs";
import * as path from "path";
import { buildProjectWithContext } from "../../webview/shared/misc/b3build";
import { getLogger, setLogger, type Logger } from "../../webview/shared/misc/logger";
import { createBuildProjectContext } from "../../webview/shared/misc/b3util";
import { setFs } from "../../webview/shared/misc/b3fs";
import {
    findBehaviorSettingFileSync,
    findBehaviorWorkspaceFileSync,
} from "../project-path-discovery";

setFs(fs);

export interface BehaviorBuildPaths {
    workspaceFile: string;
    settingFile: string;
    workdir: string;
    outputDir: string;
}

export interface BehaviorBuildProjectOptions {
    outputDir: string;
    projectPath?: string;
    workspaceFile?: string;
    settingFile?: string;
    workspaceRoot?: string;
    checkExpr?: boolean;
    buildScriptDebug?: boolean;
    logger?: Logger;
}

export interface BehaviorBuildProjectResult {
    hasError: boolean;
    paths: BehaviorBuildPaths;
}

const normalizePosixPath = (filePath: string) => filePath.replace(/\\/g, "/");

const ensureExistingFile = (filePath: string, suffix: string, label: string): string => {
    const resolved = path.resolve(filePath);
    if (!resolved.endsWith(suffix)) {
        throw new Error(`${label} must point to a ${suffix} file.`);
    }
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
        throw new Error(`${label} does not exist: ${resolved}`);
    }
    return resolved;
};

export const resolveBehaviorBuildPaths = (
    options: BehaviorBuildProjectOptions
): BehaviorBuildPaths => {
    const projectPath = path.resolve(options.projectPath ?? process.cwd());
    const workspaceRoot = options.workspaceRoot ? path.resolve(options.workspaceRoot) : undefined;
    const outputDir = path.resolve(options.outputDir);

    const workspaceFile = options.workspaceFile
        ? ensureExistingFile(options.workspaceFile, ".b3-workspace", "workspaceFile")
        : findBehaviorWorkspaceFileSync(projectPath, { rootDir: workspaceRoot });

    if (!workspaceFile) {
        throw new Error(
            `No .b3-workspace file found when walking up from ${projectPath}. ` +
                "Pass --workspace-file explicitly if your project layout is unusual."
        );
    }

    const settingFile = options.settingFile
        ? ensureExistingFile(options.settingFile, ".b3-setting", "settingFile")
        : findBehaviorSettingFileSync(path.dirname(workspaceFile), {
              rootDir: workspaceRoot,
          });

    if (!settingFile) {
        throw new Error(
            `No .b3-setting file found for workspace ${workspaceFile}. ` +
                "Pass --setting-file explicitly if it is stored elsewhere."
        );
    }

    return {
        workspaceFile,
        settingFile,
        workdir: path.dirname(workspaceFile),
        outputDir,
    };
};

export const buildBehaviorProject = async (
    options: BehaviorBuildProjectOptions
): Promise<BehaviorBuildProjectResult> => {
    const paths = resolveBehaviorBuildPaths(options);
    const previousLogger = options.logger ? getLogger() : null;

    if (options.logger) {
        setLogger(options.logger);
    }

    try {
        fs.mkdirSync(paths.outputDir, { recursive: true });
        const buildContext = createBuildProjectContext({
            workdir: normalizePosixPath(paths.workdir),
            settingFile: normalizePosixPath(paths.settingFile),
            checkExpr: options.checkExpr ?? true,
            buildScriptDebug: options.buildScriptDebug,
            alertError: () => {},
        });
        const hasError = await buildProjectWithContext(
            normalizePosixPath(paths.workspaceFile),
            normalizePosixPath(paths.outputDir),
            buildContext
        );

        return {
            hasError,
            paths,
        };
    } finally {
        if (previousLogger) {
            setLogger(previousLogger);
        }
    }
};

const HELP_TEXT = `behavior3-build

Usage:
  behavior3-build --output <dir> [--project <path>] [--workspace-file <file>] [--setting-file <file>]

Options:
  -o, --output <dir>          Output directory for built JSON files
  -p, --project <path>        Tree file, project directory, or .b3-workspace file to resolve from
      --workspace-file <file> Use an explicit .b3-workspace file
      --setting-file <file>   Use an explicit .b3-setting file
      --workspace-root <dir>  Limit upward workspace discovery to this directory
      --check-expr            Enable expression validation (default)
      --no-check-expr         Disable expression validation
      --build-script-debug    Enable sourcemapped build script debugging
  -h, --help                  Show this help text
`;

class HelpRequested extends Error {}

const readOptionValue = (args: string[], index: number, option: string): string => {
    const value = args[index + 1];
    if (!value || value.startsWith("-")) {
        throw new Error(`Missing value for ${option}`);
    }
    return value;
};

const parseCliArgs = (args: string[]): BehaviorBuildProjectOptions => {
    const options: Partial<BehaviorBuildProjectOptions> = {
        checkExpr: true,
    };

    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        switch (arg) {
            case "-o":
            case "--output":
                options.outputDir = readOptionValue(args, index, arg);
                index += 1;
                break;
            case "-p":
            case "--project":
                options.projectPath = readOptionValue(args, index, arg);
                index += 1;
                break;
            case "--workspace-file":
                options.workspaceFile = readOptionValue(args, index, arg);
                index += 1;
                break;
            case "--setting-file":
                options.settingFile = readOptionValue(args, index, arg);
                index += 1;
                break;
            case "--workspace-root":
                options.workspaceRoot = readOptionValue(args, index, arg);
                index += 1;
                break;
            case "--check-expr":
                options.checkExpr = true;
                break;
            case "--no-check-expr":
                options.checkExpr = false;
                break;
            case "--build-script-debug":
                options.buildScriptDebug = true;
                break;
            case "-h":
            case "--help":
                throw new HelpRequested();
            default:
                throw new Error(`Unknown argument: ${arg}`);
        }
    }

    if (!options.outputDir) {
        throw new Error("Missing required --output <dir> option.");
    }

    return options as BehaviorBuildProjectOptions;
};

export const runBuildCli = async (args = process.argv.slice(2)): Promise<number> => {
    try {
        const options = parseCliArgs(args);
        const result = await buildBehaviorProject(options);
        if (result.hasError) {
            console.error(
                `Build finished with validation errors. Output directory: ${result.paths.outputDir}`
            );
            return 1;
        }
        console.log(`Build completed: ${result.paths.outputDir}`);
        return 0;
    } catch (error) {
        if (error instanceof HelpRequested) {
            console.log(HELP_TEXT);
            return 0;
        }
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Build failed: ${message}`);
        return 1;
    }
};

if (typeof require !== "undefined" && require.main === module) {
    void runBuildCli().then((code) => {
        process.exitCode = code;
    });
}
