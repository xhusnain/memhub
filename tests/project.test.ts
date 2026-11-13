import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectKey, projectScope } from "../src/project.js";

describe("projectKey", () => {
  it("uses the nearest git root's folder name from any subfolder", () => {
    const home = mkdtempSync(join(tmpdir(), "home-"));
    const repo = join(home, "code", "My Shop");
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(join(repo, "src", "deep"), { recursive: true });
    expect(projectKey(join(repo, "src", "deep"), home)).toBe("my-shop");
    expect(projectKey(repo, home)).toBe("my-shop");
  });

  it("falls back to the folder name outside a repo and is null at home", () => {
    const home = mkdtempSync(join(tmpdir(), "home-"));
    mkdirSync(join(home, "notes"), { recursive: true });
    expect(projectKey(join(home, "notes"), home)).toBe("notes");
    expect(projectKey(home, home)).toBeNull();
    expect(projectKey(undefined, home)).toBeNull();
  });

  it("builds a scope string", () => {
    expect(projectScope("alpha")).toBe("project:alpha");
    expect(projectScope(null)).toBeNull();
  });
});
