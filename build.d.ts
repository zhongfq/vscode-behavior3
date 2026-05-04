import type { BuildRuntime } from "./webview/shared/misc/b3build-model";
export type { NodeData, TreeData } from "./webview/shared/misc/b3model";
export type {
  BuildEnv,
  BuildDecorator,
  BuildHookClass,
  BuildLogger,
  BuildRuntime,
  BuildScript,
  FsLike,
  Hook,
  PathLike,
} from "./webview/shared/misc/b3build-model";

declare global {
  const behavior3: BuildRuntime;
}
