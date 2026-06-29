import { execFileSync } from "node:child_process";

export type McpRunner = (file: string, args: string[]) => void;

const defaultRun: McpRunner = (file, args) => {
  execFileSync(file, args, { stdio: "inherit" });
};

export function registerUserMcp(command: string, args: string[], run: McpRunner = defaultRun): void {
  // Make registration idempotent: drop any prior entry, then add fresh.
  try {
    run("claude", ["mcp", "remove", "--scope", "user", "memhub"]);
  } catch {
    // no prior entry — fine
  }
  run("claude", ["mcp", "add", "--scope", "user", "memhub", "--", command, ...args]);
}
