/* TypeScript batch script example (ESM-only, class-based hooks). */
import type { BuildScriptEnv, BuildNode, BuildTree } from "./build-script";

export class Hook {
  constructor(private readonly env: BuildScriptEnv) {}

  onProcessTree(tree: BuildTree, _path: string, _errors: string[]) {
    return tree;
  }

  onProcessNode(node: BuildNode, errors: string[]) {
    if (node.name === "Wait" && !errors.length) {
      errors.push(`node ${node.id}(${node.name}) processed by build.ts`);
      this.env.logger.info("processed node:", node.id, node.name);
    }
    return node;
  }

  onComplete(status: "success" | "failure") {
    this.env.logger.info("onComplete (ts)", status);
  }
}

