import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyCaptureSnippet } from "../src/wizard/capture-snippet.js";

const MARK = /memhub:auto-capture/g;

describe("applyCaptureSnippet", () => {
  it("auto adds exactly one managed block to a new file", () => {
    const p = join(mkdtempSync(join(tmpdir(), "cm-")), "sub", "CLAUDE.md");
    applyCaptureSnippet(p, "auto");
    const text = readFileSync(p, "utf8");
    expect(text).toMatch(/auto-capture START/);
    expect(text.match(MARK)?.length).toBe(2); // START + END markers
  });

  it("auto is idempotent (re-running does not duplicate the block)", () => {
    const p = join(mkdtempSync(join(tmpdir(), "cm-")), "CLAUDE.md");
    applyCaptureSnippet(p, "auto");
    applyCaptureSnippet(p, "auto");
    expect(readFileSync(p, "utf8").match(/auto-capture START/g)?.length).toBe(1);
  });

  it("preserves user content and removes the block on manual", () => {
    const p = join(mkdtempSync(join(tmpdir(), "cm-")), "CLAUDE.md");
    writeFileSync(p, "# My notes\n\nkeep me\n");
    applyCaptureSnippet(p, "auto");
    expect(readFileSync(p, "utf8")).toContain("keep me");
    applyCaptureSnippet(p, "manual");
    const text = readFileSync(p, "utf8");
    expect(text).toContain("keep me");
    expect(text).not.toMatch(MARK);
  });

  it("manual on a nonexistent file does not create one", () => {
    const p = join(mkdtempSync(join(tmpdir(), "cm-")), "none", "CLAUDE.md");
    applyCaptureSnippet(p, "manual");
    expect(existsSync(p)).toBe(false);
  });

  it("auto block includes reconciliation guidance", () => {
    const p = join(mkdtempSync(join(tmpdir(), "cm-")), "CLAUDE.md");
    applyCaptureSnippet(p, "auto");
    const text = readFileSync(p, "utf8");
    expect(text).toMatch(/supersede/i);
    expect(text).toMatch(/confirm/i);
    expect(text).toMatch(/review/i);
  });
});
