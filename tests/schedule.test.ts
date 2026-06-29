import { describe, it, expect } from "vitest";
import { buildCronLine, buildLaunchdPlist } from "../src/schedule.js";

describe("buildCronLine", () => {
  it("includes a PATH prefix and the dream command", () => {
    const line = buildCronLine({ pathDirs: ["/a/bin", "/b/bin"] });
    expect(line).toMatch(/^0 3 \* \* \* PATH=\/a\/bin:\/b\/bin:\$PATH memhub dream >> \$HOME\/\.memhub\/dream\.log 2>&1$/);
  });
  it("omits PATH prefix when no dirs", () => {
    expect(buildCronLine({})).toBe("0 3 * * * memhub dream >> $HOME/.memhub/dream.log 2>&1");
  });
});

describe("buildLaunchdPlist", () => {
  it("produces a valid LaunchAgent plist with program, PATH env, and 3am schedule", () => {
    const p = buildLaunchdPlist({ memhubPath: "/x/bin/memhub", pathDirs: ["/x/bin", "/y/bin"], logPath: "/Users/h/.memhub/dream.log" });
    expect(p).toMatch(/<key>Label<\/key><string>com\.memhub\.dream<\/string>/);
    expect(p).toContain("<string>/x/bin/memhub</string>");
    expect(p).toContain("<string>dream</string>");
    expect(p).toMatch(/<key>PATH<\/key><string>\/x\/bin:\/y\/bin:\/usr\/bin:\/bin<\/string>/);
    expect(p).toMatch(/<key>Hour<\/key><integer>3<\/integer>/);
    expect(p).toContain("/Users/h/.memhub/dream.log");
  });
});
