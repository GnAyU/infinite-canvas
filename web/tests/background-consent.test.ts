import { afterAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const original = Object.getOwnPropertyDescriptor(globalThis, "window");
Object.defineProperty(globalThis, "window", { configurable: true, value: { __RUNTIME_CONFIG__: { ANALYTICS_GA4_ID: "G-SYNTHETIC", ENABLE_ANALYTICS: "true" } } });
afterAll(() => { if (original) Object.defineProperty(globalThis, "window", original); else Reflect.deleteProperty(globalThis, "window"); });

test("background traffic requires separate session consent, never persisted or imported flags", async () => {
    const { useBackgroundStore, isBackgroundAllowed } = await import("../src/stores/use-background-store");
    for (const kind of ["analytics", "version", "promptFeed"] as const) expect(isBackgroundAllowed(kind)).toBe(false);
    useBackgroundStore.getState().setConsent("analytics", true);
    expect(isBackgroundAllowed("analytics")).toBe(true);
    expect(isBackgroundAllowed("promptFeed")).toBe(false);
    useBackgroundStore.getState().setConsent("version", true);
    expect(isBackgroundAllowed("version")).toBe(true);
    useBackgroundStore.getState().setConsent("version", false);
    useBackgroundStore.getState().setConsent("analytics", false);
    expect(isBackgroundAllowed("analytics")).toBe(false);
    expect("persist" in useBackgroundStore).toBe(false);
});

test("runtime deployment flags only deny, never manufacture consent", () => {
    const source = readFileSync(new URL("../src/constant/runtime-config.ts", import.meta.url), "utf8");
    const code = new Bun.Transpiler({ loader: "ts" }).transformSync(source).replaceAll("export ", "").replaceAll("import.meta.env", "build");
    const disabled = runInNewContext(code + "; BACKGROUND_DISABLED", { window: { __RUNTIME_CONFIG__: { DISABLE_VERSION_CHECK: "true", ENABLE_ANALYTICS: "true" } }, build: {} });
    expect(disabled).toEqual({ analytics: false, version: true, promptFeed: false });
});
