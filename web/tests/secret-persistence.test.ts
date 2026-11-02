import { afterAll, expect, test } from "bun:test";
import { createJSONStorage } from "zustand/middleware";

const originals = ["window", "localStorage"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
const saved = new Map<string, string>();
const storage = { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => { saved.set(key, value); }, removeItem: (key: string) => { saved.delete(key); } };
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: storage } });
afterAll(() => { for (const [key, descriptor] of originals) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); });
const { useConfigStore, defaultConfig, defaultWebdavSyncConfig, CONFIG_STORE_KEY } = await import("../src/stores/use-config-store");
useConfigStore.persist.setOptions({ storage: createJSONStorage(() => storage) });

test("fresh API and WebDAV secrets stay in memory while non-secret settings persist", async () => {
    saved.clear();
    useConfigStore.setState({ config: structuredClone(defaultConfig), webdav: { ...defaultWebdavSyncConfig } });
    useConfigStore.getState().updateConfig("channels", [{ ...defaultConfig.channels[0], apiKey: "synthetic-fresh-api-canary" }]);
    useConfigStore.getState().updateConfig("apiKey", "synthetic-flat-api-canary");
    useConfigStore.getState().updateWebdavConfig("password", "synthetic-fresh-webdav-canary");
    useConfigStore.getState().updateWebdavConfig("url", "https://dav.invalid/files");
    const live = useConfigStore.getState();
    expect(live.config.channels[0].apiKey).toBe("synthetic-fresh-api-canary");
    expect(live.webdav.password).toBe("synthetic-fresh-webdav-canary");
    const disk = saved.get(CONFIG_STORE_KEY)!;
    expect(disk).not.toContain("synthetic-");
    expect(JSON.parse(disk).state.config.channels[0].id).toBe("default");
    expect(JSON.parse(disk).state.webdav.url).toBe("https://dav.invalid/files");
    await useConfigStore.persist.rehydrate();
    expect(useConfigStore.getState().config.channels[0].apiKey).toBe("");
    expect(useConfigStore.getState().webdav.password).toBe("");
});
