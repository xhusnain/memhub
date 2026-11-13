import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clientByKey, detectClients, registerClient, unregisterClient } from "../src/clients.js";

const home = () => mkdtempSync(join(tmpdir(), "mh-"));

describe("registerClient (file-based adapters)", () => {
  it("gemini: writes mcpServers.memhub into ~/.gemini/settings.json", () => {
    const h = home();
    registerClient("gemini", h, () => {});
    const cfg = JSON.parse(readFileSync(join(h, ".gemini", "settings.json"), "utf8"));
    expect(cfg.mcpServers.memhub).toEqual({ command: "memhub", args: ["serve"], env: { MEMHUB_CLIENT: "gemini" } });
  });

  it("gemini: preserves unrelated settings when merging", () => {
    const h = home();
    mkdirSync(join(h, ".gemini"), { recursive: true });
    writeFileSync(join(h, ".gemini", "settings.json"), JSON.stringify({ theme: "dark", mcpServers: { other: { command: "x" } } }));
    registerClient("gemini", h, () => {});
    const cfg = JSON.parse(readFileSync(join(h, ".gemini", "settings.json"), "utf8"));
    expect(cfg.theme).toBe("dark");
    expect(cfg.mcpServers.other).toEqual({ command: "x" });
    expect(cfg.mcpServers.memhub.command).toBe("memhub");
  });

  it("refuses to clobber a malformed JSON config", () => {
    const h = home();
    mkdirSync(join(h, ".gemini"), { recursive: true });
    writeFileSync(join(h, ".gemini", "settings.json"), "{not json");
    expect(() => registerClient("gemini", h, () => {})).toThrow(/not valid JSON/);
    expect(readFileSync(join(h, ".gemini", "settings.json"), "utf8")).toBe("{not json");
  });

  it("accepts a BOM-prefixed valid JSON config", () => {
    const h = home();
    mkdirSync(join(h, ".gemini"), { recursive: true });
    writeFileSync(join(h, ".gemini", "settings.json"), "\uFEFF" + JSON.stringify({ theme: "dark" }));
    registerClient("gemini", h, () => {});
    const cfg = JSON.parse(readFileSync(join(h, ".gemini", "settings.json"), "utf8"));
    expect(cfg.theme).toBe("dark");
    expect(cfg.mcpServers.memhub.command).toBe("memhub");
  });

  it("rejects a config whose root is not a JSON object", () => {
    const h = home();
    mkdirSync(join(h, ".cursor"), { recursive: true });
    writeFileSync(join(h, ".cursor", "mcp.json"), "[1,2]");
    expect(() => registerClient("cursor", h, () => {})).toThrow(/not a JSON object/);
    expect(readFileSync(join(h, ".cursor", "mcp.json"), "utf8")).toBe("[1,2]");
  });

  it("rejects a config whose mcpServers key is not an object", () => {
    const h = home();
    mkdirSync(join(h, ".gemini"), { recursive: true });
    writeFileSync(join(h, ".gemini", "settings.json"), JSON.stringify({ mcpServers: "disabled" }));
    expect(() => registerClient("gemini", h, () => {})).toThrow(/not a JSON object/);
    const cfg = JSON.parse(readFileSync(join(h, ".gemini", "settings.json"), "utf8"));
    expect(cfg.mcpServers).toBe("disabled");
  });

  it("opencode: local-type server with merged command array", () => {
    const h = home();
    registerClient("opencode", h, () => {});
    const cfg = JSON.parse(readFileSync(join(h, ".config", "opencode", "opencode.json"), "utf8"));
    expect(cfg.mcp.memhub).toEqual({
      type: "local",
      command: ["memhub", "serve"],
      enabled: true,
      environment: { MEMHUB_CLIENT: "opencode" },
    });
  });

  it("openclaw: nested mcp.servers entry", () => {
    const h = home();
    registerClient("openclaw", h, () => {});
    const cfg = JSON.parse(readFileSync(join(h, ".openclaw", "openclaw.json"), "utf8"));
    expect(cfg.mcp.servers.memhub).toEqual({ command: "memhub", args: ["serve"] });
  });

  it("cursor: mcpServers entry in ~/.cursor/mcp.json", () => {
    const h = home();
    registerClient("cursor", h, () => {});
    const cfg = JSON.parse(readFileSync(join(h, ".cursor", "mcp.json"), "utf8"));
    expect(cfg.mcpServers.memhub).toEqual({ command: "memhub", args: ["serve"], env: { MEMHUB_CLIENT: "cursor" } });
  });
});

describe("registerClient (command adapters)", () => {
  it("claude: remove then add at user scope with client env", () => {
    const calls: Array<[string, string[]]> = [];
    registerClient("claude", home(), (f, a) => calls.push([f, a]));
    expect(calls).toEqual([
      ["claude", ["mcp", "remove", "--scope", "user", "memhub"]],
      ["claude", ["mcp", "add", "--scope", "user", "--env", "MEMHUB_CLIENT=claude", "memhub", "--", "memhub", "serve"]],
    ]);
  });

  it("claude: a failing remove does not stop the add", () => {
    const calls: string[][] = [];
    registerClient("claude", home(), (f, a) => {
      if (a[1] === "remove") throw new Error("not found");
      calls.push([f, ...a]);
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("add");
  });

  it("codex: remove then add with client env", () => {
    const calls: Array<[string, string[]]> = [];
    registerClient("codex", home(), (f, a) => calls.push([f, a]));
    expect(calls).toEqual([
      ["codex", ["mcp", "remove", "memhub"]],
      ["codex", ["mcp", "add", "memhub", "--env", "MEMHUB_CLIENT=codex", "--", "memhub", "serve"]],
    ]);
  });

  it("throws on an unknown client key", () => {
    expect(() => registerClient("vscode", home(), () => {})).toThrow(/unknown client/i);
  });
});

describe("unregisterClient", () => {
  it("removes the memhub entry and preserves the rest of the config", () => {
    const h = home();
    mkdirSync(join(h, ".gemini"), { recursive: true });
    writeFileSync(join(h, ".gemini", "settings.json"), JSON.stringify({ theme: "dark", mcpServers: { other: { command: "x" } } }));
    registerClient("gemini", h, () => {});
    unregisterClient("gemini", h, () => {});
    const cfg = JSON.parse(readFileSync(join(h, ".gemini", "settings.json"), "utf8"));
    expect(cfg.mcpServers.memhub).toBeUndefined();
    expect(cfg.mcpServers.other).toEqual({ command: "x" });
    expect(cfg.theme).toBe("dark");
  });

  it("is a no-op on a missing or malformed config file", () => {
    const h = home();
    expect(() => unregisterClient("cursor", h, () => {})).not.toThrow();
    mkdirSync(join(h, ".cursor"), { recursive: true });
    writeFileSync(join(h, ".cursor", "mcp.json"), "{broken");
    expect(() => unregisterClient("cursor", h, () => {})).not.toThrow();
    expect(readFileSync(join(h, ".cursor", "mcp.json"), "utf8")).toBe("{broken");
  });

  it("claude: runs mcp remove and swallows failures", () => {
    const calls: Array<[string, string[]]> = [];
    unregisterClient("claude", home(), (f, a) => calls.push([f, a]));
    expect(calls).toEqual([["claude", ["mcp", "remove", "--scope", "user", "memhub"]]]);
    expect(() => unregisterClient("claude", home(), () => { throw new Error("gone"); })).not.toThrow();
  });
});

describe("detectClients", () => {
  it("detects via config dir or binary, not otherwise", () => {
    const h = home();
    mkdirSync(join(h, ".codex"), { recursive: true });
    mkdirSync(join(h, ".openclaw"), { recursive: true });
    const found = detectClients(h, (bin) => bin === "gemini");
    expect(found).toContain("codex");
    expect(found).toContain("openclaw");
    expect(found).toContain("gemini");
    expect(found).not.toContain("cursor");
    expect(found).not.toContain("opencode");
  });

  it("detects cursor through any of its known binary names", () => {
    const h = home();
    expect(detectClients(h, (bin) => bin === "cursor")).toContain("cursor");
    expect(detectClients(h, (bin) => bin === "cursor-agent")).toContain("cursor");
  });
});

describe("instructions files", () => {
  it("maps each client to its documented instructions file", () => {
    const h = "/h";
    expect(clientByKey("claude")!.instructionsFile(h)).toBe("/h/.claude/CLAUDE.md");
    expect(clientByKey("codex")!.instructionsFile(h)).toBe("/h/.codex/AGENTS.md");
    expect(clientByKey("gemini")!.instructionsFile(h)).toBe("/h/.gemini/GEMINI.md");
    expect(clientByKey("opencode")!.instructionsFile(h)).toBe("/h/.config/opencode/AGENTS.md");
    expect(clientByKey("openclaw")!.instructionsFile(h)).toBe("/h/.openclaw/workspace/AGENTS.md");
    expect(clientByKey("cursor")!.instructionsFile(h)).toBeNull();
  });
});

describe("claude hooks", () => {
  const settings = (h: string) => JSON.parse(readFileSync(join(h, ".claude", "settings.json"), "utf8"));
  const claude = clientByKey("claude")!;

  it("installs the four memory hooks and is idempotent", () => {
    const h = home();
    claude.installHooks!(h);
    claude.installHooks!(h);
    const hooks = settings(h).hooks;
    expect(Object.keys(hooks).sort()).toEqual(["PreCompact", "SessionEnd", "SessionStart", "UserPromptSubmit"]);
    expect(hooks.UserPromptSubmit).toEqual([{ hooks: [{ type: "command", command: "memhub hook prompt", timeout: 10 }] }]);
    expect(hooks.SessionStart[0].hooks[0].command).toBe("memhub hook session-start");
    expect(hooks.SessionEnd[0].hooks[0].command).toBe("memhub hook session-end");
    expect(hooks.PreCompact[0].hooks[0].command).toBe("memhub hook pre-compact");
  });

  it("preserves the user's own hooks and settings on install and removal", () => {
    const h = home();
    mkdirSync(join(h, ".claude"), { recursive: true });
    const mine = { matcher: "Bash", hooks: [{ type: "command", command: "echo mine" }] };
    writeFileSync(join(h, ".claude", "settings.json"), JSON.stringify({
      model: "opus",
      hooks: { PreToolUse: [mine], SessionStart: [{ hooks: [{ type: "command", command: "echo hi" }] }] },
    }));
    claude.installHooks!(h);
    let s = settings(h);
    expect(s.model).toBe("opus");
    expect(s.hooks.PreToolUse).toEqual([mine]);
    expect(s.hooks.SessionStart).toHaveLength(2);
    claude.removeHooks!(h);
    s = settings(h);
    expect(s.hooks).toEqual({ PreToolUse: [mine], SessionStart: [{ hooks: [{ type: "command", command: "echo hi" }] }] });
  });

  it("removal leaves no empty hooks object and tolerates a missing file", () => {
    const h = home();
    claude.removeHooks!(h);
    claude.installHooks!(h);
    claude.removeHooks!(h);
    expect(settings(h).hooks).toBeUndefined();
  });

  it("only claude has hook installation for now", () => {
    expect(clientByKey("codex")!.installHooks).toBeUndefined();
    expect(clientByKey("gemini")!.installHooks).toBeUndefined();
  });
});
