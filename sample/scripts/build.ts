/* TypeScript batch script example (ESM-only, decorator-based hooks). */
import type { BuildEnv, NodeData, TreeData } from "vscode-behavior3/build";
import { formatProcessedNode, shouldReportWaitNode } from "./build-helper.ts";

@behavior3.build
export class SampleBuild {
  constructor(private readonly env: BuildEnv) {}

  onProcessTree(tree: TreeData, _path: string, _errors: string[]) {
    return tree;
  }

  onProcessNode(node: NodeData, errors: string[]) {
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
