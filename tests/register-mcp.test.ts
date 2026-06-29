import { describe, it, expect } from "vitest";
import { registerUserMcp } from "../src/wizard/register-mcp.js";

describe("registerUserMcp", () => {
  it("removes then adds the server at user scope with the right argv", () => {
    const calls: Array<[string, string[]]> = [];
    registerUserMcp("memhub", ["serve"], (file, args) => { calls.push([file, args]); });
    expect(calls).toEqual([
      ["claude", ["mcp", "remove", "--scope", "user", "memhub"]],
      ["claude", ["mcp", "add", "--scope", "user", "memhub", "--", "memhub", "serve"]],
    ]);
  });

  it("ignores a failing remove but still runs add", () => {
    const calls: string[][] = [];
    registerUserMcp("memhub", ["serve"], (file, args) => {
      if (args[1] === "remove") throw new Error("not found");
      calls.push([file, ...args]);
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("add");
  });
});
