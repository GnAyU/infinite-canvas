import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { runInNewContext } from "node:vm";

test("container entrypoint exposes deny-only flags without turning configured IDs into consent", () => {
    const directory = mkdtempSync(join(tmpdir(), "web-b-runtime-"));
    try {
        const destination = join(directory, "config.js");
        const script = readFileSync(new URL("../docker-entrypoint.sh", import.meta.url), "utf8").replace("/usr/share/nginx/html/config.js", destination);
        execFileSync("/bin/sh", ["-c", script], { env: { PATH: process.env.PATH, ANALYTICS_GA4_ID: "G-SYNTHETIC", DISABLE_ANALYTICS: "true", DISABLE_VERSION_CHECK: "true", DISABLE_PROMPT_FEED: "true" } });
        const window = { __RUNTIME_CONFIG__: {} };
        runInNewContext(readFileSync(destination, "utf8"), { window });
        expect(window.__RUNTIME_CONFIG__).toEqual({ ANALYTICS_GA4_ID: "G-SYNTHETIC", ANALYTICS_BAIDU_ID: "", DISABLE_ANALYTICS: "true", DISABLE_VERSION_CHECK: "true", DISABLE_PROMPT_FEED: "true" });
        execFileSync("/bin/sh", ["-c", script], { env: { PATH: process.env.PATH, DISABLE_ANALYTICS: '\";throw new Error("synthetic");//' } });
        const fallback = { __RUNTIME_CONFIG__: {} };
        runInNewContext(readFileSync(destination, "utf8"), { window: fallback });
        expect(fallback.__RUNTIME_CONFIG__).toEqual({ ANALYTICS_GA4_ID: "", ANALYTICS_BAIDU_ID: "", DISABLE_ANALYTICS: "false", DISABLE_VERSION_CHECK: "false", DISABLE_PROMPT_FEED: "false" });
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("either deployment layer can force traffic off; runtime false cannot override a build-time denial", () => {
    const source = readFileSync(new URL("../src/constant/runtime-config.ts", import.meta.url), "utf8");
    const code = new Bun.Transpiler({ loader: "ts" }).transformSync(source).replaceAll("export ", "").replaceAll("import.meta.env", "build");
    const disabled = runInNewContext(code + "; BACKGROUND_DISABLED", {
        window: { __RUNTIME_CONFIG__: { DISABLE_ANALYTICS: "false", DISABLE_VERSION_CHECK: "true", DISABLE_PROMPT_FEED: "false", ENABLE_ANALYTICS: "true" } },
        build: { VITE_DISABLE_ANALYTICS: "true", VITE_DISABLE_VERSION_CHECK: "false", VITE_DISABLE_PROMPT_FEED: "true" },
    });
    expect(disabled).toEqual({ analytics: true, version: true, promptFeed: true });
});
