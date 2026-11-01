import { afterAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const originals = ["window", "document"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
const frames: any[] = [];
const messages: unknown[] = [];
let dispose: (() => void) | undefined;
Object.defineProperty(globalThis, "window", { configurable: true, value: { location: new URL("https://app.invalid/canvas/synthetic-title?secret=synthetic-query#synthetic-fragment"), __RUNTIME_CONFIG__: { ANALYTICS_GA4_ID: "G-SYNTHETIC", ANALYTICS_BAIDU_ID: "0123456789abcdef0123456789abcdef" } } });
Object.defineProperty(globalThis, "document", { configurable: true, value: {
    createElement: (tag: string) => ({ tag, setAttribute(key: string, value: string) { (this as any)[key] = value; }, contentWindow: { postMessage: (value: unknown) => messages.push(value) }, remove() { (this as any).removed = true; } }),
    body: { appendChild: (frame: any) => { frames.push(frame); frame.onload(); } },
} });
afterAll(() => { dispose?.(); for (const [key, descriptor] of originals) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); });

test("configured IDs cannot load analytics before consent; opt-out destroys the isolated provider context", async () => {
    const analytics = await import("../src/lib/analytics");
    const { useBackgroundStore } = await import("../src/stores/use-background-store");
    dispose = analytics.initAnalytics();
    expect(frames).toHaveLength(0);
    useBackgroundStore.getState().setConsent("analytics", true);
    expect(frames).toHaveLength(1);
    expect(frames[0].sandbox).toBe("allow-scripts");
    expect(frames[0].referrerPolicy).toBe("no-referrer");
    analytics.trackPageview("/canvas/synthetic-title?secret=synthetic-query#synthetic-fragment");
    expect(JSON.stringify(messages)).not.toContain("synthetic");
    expect(JSON.stringify(messages)).toContain("/canvas/:id");
    useBackgroundStore.getState().setConsent("analytics", false);
    expect(frames[0].removed).toBe(true);
    const before = messages.length;
    analytics.trackPageview("/image");
    expect(messages).toHaveLength(before);
});

test("analytics accepts static routes only and converts dynamic/unknown paths to templates", async () => {
    const { analyticsRoute } = await import("../src/lib/analytics");
    expect(analyticsRoute("/canvas/secret-title?x=y#z")).toBe("/canvas/:id");
    expect(analyticsRoute("/unknown-secret")).toBe("/not-found");
    expect(analyticsRoute("/prompts?title=secret")).toBe("/prompts");
});

test("sandbox queues safe defaults before scripts; foreign messages and unknown route text are ignored", () => {
    const frame = readFileSync(new URL("../public/analytics-frame.html", import.meta.url), "utf8");
    const src = frame.match(/<script>([\s\S]*?)<\/script>/)?.[1] || "";
    const scripts: any[] = [];
    const parent = {};
    const listeners: Record<string, Function> = {};
    const window: any = { parent, addEventListener: (name: string, fn: Function) => { listeners[name] = fn; } };
    runInNewContext(src, { window, document: { createElement: () => ({}), head: { appendChild: (el: unknown) => scripts.push(el) } } });
    listeners.message({ source: {}, data: { type: "ic-analytics-init", ga4: "G-SYNTHETIC" } });
    expect(scripts).toHaveLength(0);
    listeners.message({ source: parent, data: { type: "ic-analytics-init", ga4: "G-SYNTHETIC", baidu: "0123456789abcdef0123456789abcdef", route: "/canvas/:id" } });
    expect(scripts).toHaveLength(2);
    expect(window.dataLayer.find((entry: any[]) => entry[0] === "config")[2]).toMatchObject({ send_page_view: false, page_location: "https://infinite-canvas.invalid/canvas/:id", page_title: "Infinite Canvas", page_referrer: "" });
    expect(window._hmt[0]).toEqual(["_setAutoPageview", false]);
    expect(scripts.every((script) => script.referrerPolicy === "no-referrer")).toBe(true);
    const before = JSON.stringify([window.dataLayer, window._hmt]);
    listeners.message({ source: parent, data: { type: "ic-analytics-pageview", route: "/synthetic-secret" } });
    expect(JSON.stringify([window.dataLayer, window._hmt])).toBe(before);
});
