import { describe, it, expect } from "vitest";
import { redactUrl } from "../src/redact.js";

describe("redactUrl", () => {
  it("redacts a postgres connection string with credentials", () => {
    const msg = "connect ECONNREFUSED postgres://user:s3cret@db.example.com:5432/app";
    const out = redactUrl(msg);
    expect(out).not.toContain("s3cret");
    expect(out).not.toContain("user:");
    expect(out).toContain("postgres://***redacted***");
  });

  it("redacts the postgresql:// scheme too", () => {
    expect(redactUrl("bad url postgresql://a:b@h/d")).toContain("postgres://***redacted***");
  });

  it("leaves messages without a connection string unchanged", () => {
    expect(redactUrl("model not found: text-embedding-3-small")).toBe("model not found: text-embedding-3-small");
  });
});
