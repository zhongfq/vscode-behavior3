import type { NodeData } from "vscode-behavior3/build";

export const shouldReportWaitNode = (node: NodeData) => node.name === "Wait";

export const formatProcessedNode = (node: NodeData) =>
  `node ${node.id}(${node.name}) processed by build.ts`;
