import type { NodeArgCheckContext } from "vscode-behavior3/build";

@behavior3.check("positive")
export class PositiveChecker {
  validate(value: unknown, ctx: NodeArgCheckContext) {
    if (value === undefined || value === null || value === "") {
      return;
    }
    if (typeof value !== "number") {
      return `${ctx.argName} must be a number`;
    }
    if (value <= 0) {
      return `${ctx.argName} must be greater than 0`;
    }
  }
}
