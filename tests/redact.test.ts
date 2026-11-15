import { describe, it, expect } from "vitest";
import { redactUrl, redactErr } from "../src/redact.js";

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

  it("names the failure when a connection error has no message of its own", () => {
    const refused = Object.assign(new Error("connect ETIMEDOUT 3.14.1.1:5432"), { code: "ETIMEDOUT" });
    const unreachable = Object.assign(new Error("connect EHOSTUNREACH ::1:5432"), { code: "EHOSTUNREACH" });
    const agg = new AggregateError([refused, unreachable, refused], "");
    expect(redactErr(agg)).toBe("could not connect (ETIMEDOUT, EHOSTUNREACH)");
    expect(redactErr(Object.assign(new Error(""), { code: "ECONNRESET" }))).toBe("ECONNRESET");
    expect(redactErr(new Error(""))).toBe("Error");
  });
});
