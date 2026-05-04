/* TypeScript batch script example (ESM-only, decorator-based hooks). */
import type { BuildScriptEnv, BuildNode, BuildTree } from "./build-script";
import { formatProcessedNode, shouldReportWaitNode } from "./build-helper.ts";

@behavior3.build
export class SampleBuild {
  constructor(private readonly env: BuildScriptEnv) {}

  onProcessTree(tree: BuildTree, _path: string, _errors: string[]) {
    return tree;
  }

  onProcessNode(node: BuildNode, errors: string[]) {
    if (shouldReportWaitNode(node) && !errors.length) {
      errors.push(formatProcessedNode(node));
      this.env.logger.info("processed node:", node.id, node.name);
    }
    return node;
  }

  onComplete(status: "success" | "failure") {
    this.env.logger.info("onComplete (ts)", status);
  }
}
