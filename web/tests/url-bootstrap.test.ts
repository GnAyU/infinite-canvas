import { afterAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { createJSONStorage } from "zustand/middleware";

const originals = ["window", "localStorage"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
const saved = new Map<string, string>();
const storage = { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => { saved.set(key, value); }, removeItem: (key: string) => { saved.delete(key); } };
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: storage } });
afterAll(() => { for (const [key, descriptor] of originals) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); });

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

test("the first inline script captures and scrubs credentials before any resource or router initialization", () => {
    const events: string[] = [];
    const window = { location: new URL("https://app.invalid/canvas/board?keep=ok&apiKey=synthetic-query-canary&baseUrl=https%3A%2F%2Fprovider.invalid%2Fv1#agentToken=synthetic-agent-canary&tab=layers"), history: { state: { retained: true }, replaceState(state: unknown, _: string, path: string) { events.push(path); expect(state).toEqual({ retained: true }); } } };
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] || "";
    runInNewContext(script, { window, URL, URLSearchParams, localStorage: storage, document: { documentElement: { classList: { toggle() {} }, style: {} } } });
    expect(events).toEqual(["/canvas/board?keep=ok#tab=layers"]);
    expect(html.indexOf("<script>")).toBeLessThan(html.indexOf('<link rel="icon"'));
    const bootstrap = (window as typeof window & { __IC_BOOTSTRAP__?: unknown }).__IC_BOOTSTRAP__;
    expect(bootstrap).toEqual({ baseUrl: "https://provider.invalid/v1", apiKey: "synthetic-query-canary" });
    expect(JSON.stringify(bootstrap)).not.toContain("synthetic-agent-canary");
});

test("bootstrap session credentials are inactive, exact-bound and absent from persisted state on reload", async () => {
    const { useConfigStore, defaultConfig, CONFIG_STORE_KEY } = await import("../src/stores/use-config-store");
    useConfigStore.persist.setOptions({ storage: createJSONStorage(() => storage) });
    useConfigStore.setState({ config: structuredClone(defaultConfig) });
    const before = useConfigStore.getState().config;
    const state = useConfigStore.getState();
    expect(typeof state.importBootstrapCredentials).toBe("function");
    const result = state.importBootstrapCredentials!("https://api.openai.com/v1", "synthetic-bootstrap-canary");
    expect(result.status).toBe("created");
    const config = useConfigStore.getState().config;
    expect(config.model).toBe(before.model);
    expect(config.imageModel).toBe(before.imageModel);
    expect(config.channels[0]).toEqual(before.channels[0]);
    const imported = config.channels.at(-1)!;
    expect(imported.baseUrl).toBe("https://api.openai.com/v1");
    expect(imported.apiKey).toBe("synthetic-bootstrap-canary");
    expect(imported.models).toEqual([]);
    expect(saved.get(CONFIG_STORE_KEY)).not.toContain("synthetic-bootstrap-canary");
    state.importBootstrapCredentials("https://api.openai.com", "synthetic-root-canary");
    state.importBootstrapCredentials("https://api.openai.com/v1", "synthetic-exact-canary");
    const channels = useConfigStore.getState().config.channels;
    expect(channels.slice(-3).map(({ baseUrl, apiKey }) => [baseUrl, apiKey])).toEqual([
        ["https://api.openai.com/v1", "synthetic-bootstrap-canary"],
        ["https://api.openai.com", "synthetic-root-canary"],
        ["https://api.openai.com/v1", "synthetic-exact-canary"],
    ]);
    expect(channels[0]).toEqual(before.channels[0]);
    expect(useConfigStore.getState().config.model).toBe(before.model);
    expect(saved.get(CONFIG_STORE_KEY)).not.toMatch(/synthetic-(bootstrap|root|exact)-canary/);
    await useConfigStore.persist.rehydrate();
    expect(JSON.stringify(useConfigStore.getState().config)).not.toMatch(/synthetic-(bootstrap|root|exact)-canary/);
    // Reimport to exercise an endpoint change while the transient credential is still live.
    state.importBootstrapCredentials("https://api.openai.com/v1", "synthetic-bootstrap-canary");
    const live = useConfigStore.getState().config.channels;
    const liveId = live.at(-1)!.id;
    useConfigStore.getState().updateConfig("channels", live.map((channel) => channel.id === liveId ? { ...channel, baseUrl: "https://api.openai.com" } : channel));
    expect(useConfigStore.getState().config.channels.at(-1)!.apiKey).toBe("");
    expect(saved.get(CONFIG_STORE_KEY)).not.toContain("synthetic-bootstrap-canary");
    await useConfigStore.persist.rehydrate();
    expect(JSON.stringify(useConfigStore.getState().config)).not.toContain("synthetic-bootstrap-canary");
});
