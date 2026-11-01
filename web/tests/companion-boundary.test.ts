import { afterAll, expect, test } from "bun:test";
import { createJSONStorage } from "zustand/middleware";

const values = new Map<string, string>();
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
} });
const originalFetch = globalThis.fetch;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: globalThis.localStorage } });
let requests = 0;
globalThis.fetch = (async () => { requests++; return Response.json({ ok: true, proxy: "synthetic" }); }) as typeof fetch;
afterAll(() => {
    globalThis.fetch = originalFetch;
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
});
const agent = await import("../src/services/api/canvas-agent");
const { testLocalProxy } = await import("../src/services/api/local-proxy");
const { defaultConfig, useConfigStore, withLocalProxy } = await import("../src/stores/use-config-store");
const { useAgentStore } = await import("../src/stores/use-agent-store");

test("companion API entrypoints reject without transport", async () => {
    requests = 0;
    const endpoint = "https://companion.invalid";
    for (const call of [
        () => agent.postState(endpoint, "synthetic-token", "client", null),
        () => agent.activateAgentClient(endpoint, "synthetic-token", "client"),
        () => agent.fetchAgentJson(endpoint, "synthetic-token", "/config"),
        () => agent.discoverAgentConfig(endpoint),
        () => testLocalProxy(endpoint),
    ]) await expect(call()).rejects.toThrow("当前配置不支持");
    expect(requests).toBe(0);
});

test("persisted/imported proxy flags and direct Agent connect stay inert without erasing values", async () => {
    useConfigStore.persist.setOptions({ storage: createJSONStorage(() => globalThis.localStorage) });
    const config = { ...defaultConfig, proxyEnabled: true, proxyUrl: "https://proxy.invalid" };
    values.set("infinite-canvas:ai_config_store", JSON.stringify({ state: { config }, version: 0 }));
    await useConfigStore.persist.rehydrate();
    expect(withLocalProxy("https://provider.invalid/v1/models")).toBe("https://provider.invalid/v1/models");
    expect(useConfigStore.getState().config.proxyUrl).toBe(config.proxyUrl);
    useConfigStore.setState({ config });
    expect(withLocalProxy("https://provider.invalid/v1/models")).toBe("https://provider.invalid/v1/models");
    useAgentStore.getState().setAgentState({ url: "https://companion.invalid", token: "synthetic-token", enabled: true, connected: true, fragmentBootstrap: true });
    useAgentStore.getState().connectAgent({ silent: true });
    expect(useAgentStore.getState().enabled).toBe(false);
    expect(useAgentStore.getState().connected).toBe(false);
    expect(useAgentStore.getState().fragmentBootstrap).toBe(false);
    expect(useAgentStore.getState().token).toBe("synthetic-token");
});

test("Agent assets cannot produce a token-bearing companion URL", () => {
    expect(agent.resolveAgentMessageAssetUrl("https://companion.invalid", "synthetic-token", `agent-asset:${"a".repeat(64)}/${"b".repeat(64)}.png`)).toBe("");
    expect(agent.resolveAgentMessageAssetUrl("", "", "blob:local-preview")).toBe("blob:local-preview");
});
