import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// Pin the entrypoint boundary too: importing/mounting a canvas must never be a manager action.
test("canvas startup never loads plugin catalogs or evaluates plugin code", () => {
    const host = readFileSync(new URL("../src/pages/canvas/hooks/use-plugin-host.tsx", import.meta.url), "utf8");
    expect(host).not.toContain("ensurePluginsLoaded");
});
