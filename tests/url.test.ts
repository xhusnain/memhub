import { describe, it, expect } from "vitest";
import { adjustPostgresUrl } from "../src/db/url.js";

describe("adjustPostgresUrl", () => {
  it("turns a Neon pooled URL into the direct one and says why", () => {
    const r = adjustPostgresUrl("postgresql://u:p@ep-cool-dawn-123456-pooler.c-8.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require");
    expect(r.url).toBe("postgresql://u:p@ep-cool-dawn-123456.c-8.us-east-2.aws.neon.tech/neondb?sslmode=verify-full&channel_binding=require");
    expect(r.notes).toHaveLength(1);
    expect(r.notes[0]).toMatch(/direct/);
  });

  it("leaves a Neon direct URL's host alone and reports nothing", () => {
    const r = adjustPostgresUrl("postgresql://u:p@ep-cool-dawn-123456.us-east-2.aws.neon.tech/neondb?sslmode=require");
    expect(r.url).toBe("postgresql://u:p@ep-cool-dawn-123456.us-east-2.aws.neon.tech/neondb?sslmode=verify-full");
    expect(r.notes).toEqual([]);
  });

  it("never touches other hosts, local URLs, or text that is not a URL", () => {
    for (const url of [
      "postgres://postgres:pw@localhost:5432/postgres",
      "postgres://u:p@db-pooler.example.com:6543/app?sslmode=require",
      "postgres://u:p@aws-0-eu.pooler.supabase.com:5432/postgres",
      "not a url",
      "",
    ]) {
      expect(adjustPostgresUrl(`  ${url} `)).toEqual({ url, notes: [] });
    }
  });
});
