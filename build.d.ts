import type { BuildRuntime } from "./webview/shared/misc/b3build-model";
export type { NodeDef } from "behavior3";
export type { NodeData, TreeData } from "./webview/shared/misc/b3model";
export type {
  BuildEnv,
  CheckDecorator,
  BuildDecorator,
  BuildHookClass,
  BuildLogger,
  BuildRuntime,
  BuildScript,
  FsLike,
  Hook,
  NodeArg,
  NodeArgCheckContext,
  NodeArgChecker,
  NodeArgCheckerClass,
  NodeArgCheckResult,
  PathLike,
} from "./webview/shared/misc/b3build-model";

declare global {
  const behavior3: BuildRuntime;
}
