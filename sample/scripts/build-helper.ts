import type { BuildNode } from "./build-script";

export const shouldReportWaitNode = (node: BuildNode) => node.name === "Wait";

export const formatProcessedNode = (node: BuildNode) =>
  `node ${node.id}(${node.name}) processed by build.ts`;
