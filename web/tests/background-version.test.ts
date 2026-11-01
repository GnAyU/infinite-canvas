import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

test("version mount and release viewing do not fetch without separate consent", () => {
    const hook = readFileSync(new URL("../src/hooks/use-version-check.ts", import.meta.url), "utf8");
    expect(hook).toContain('useBackgroundPermission("version")');
    expect(hook).toContain('if (isBackgroundAllowed("version")) void checkLatestVersion()');
    expect(hook.match(/const openReleaseModal[\s\S]*?\}, \[[^\]]*\]\);/)?.[0]).not.toContain("checkLatestRelease");
});
