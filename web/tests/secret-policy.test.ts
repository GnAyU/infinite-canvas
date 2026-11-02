import { afterAll, expect, test } from "bun:test";
import { createJSONStorage } from "zustand/middleware";
const descriptors = ["window", "localStorage"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
const disk = new Map<string, string>();
const storage = { getItem: (key: string) => disk.get(key) ?? null, setItem: (key: string, value: string) => { disk.set(key, value); }, removeItem: (key: string) => { disk.delete(key); } };
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: storage } });
const s = await import("../src/stores/use-config-store");
s.useConfigStore.persist.setOptions({ storage: createJSONStorage(() => storage) });
afterAll(() => { for (const [key, descriptor] of descriptors) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); });

test("failed or silent forget cannot resolve the legacy choice or permit recipient rebinding", async () => {
    for (const failure of ["throw", "silent", "read"] as const) {
        disk.set(s.CONFIG_STORE_KEY, JSON.stringify({ version: 0, state: { config: { ...s.defaultConfig, channels: [{ ...s.defaultConfig.channels[0], apiKey: "synthetic-failed-forget" }] }, webdav: s.defaultWebdavSyncConfig } }));
        await s.useConfigStore.persist.rehydrate();
        const set = storage.setItem, get = storage.getItem;
        const original = disk.get(s.CONFIG_STORE_KEY);
        storage.setItem = (key, value) => { if (failure === "throw") throw new Error("synthetic quota"); if (failure !== "silent") set(key, value); };
        if (failure === "read") storage.getItem = () => { throw new Error("synthetic unreadable"); };
        try {
            expect(() => s.chooseSecretPersistence("channel:default", "forget")).toThrow();
            expect(s.secretPersistenceStatus("channel:default")).toBe("legacy");
            expect(() => s.useConfigStore.getState().updateConfig("channels", [{ ...s.useConfigStore.getState().config.channels[0], baseUrl: "https://changed.invalid" }])).toThrow(/旧|选择/);
            expect(disk.get(s.CONFIG_STORE_KEY)).toBe(original);
        } finally { storage.setItem = set; storage.getItem = get; }
    }
});

test("unresolved legacy secret bytes are not trimmed by hydration or unrelated writes", async () => {
    const apiKey = " synthetic-legacy-byte-exact ";
    disk.set(s.CONFIG_STORE_KEY, JSON.stringify({ version: 0, state: { config: { ...structuredClone(s.defaultConfig), channels: [{ ...s.defaultConfig.channels[0], apiKey }] }, webdav: { ...s.defaultWebdavSyncConfig } } }));
    await s.useConfigStore.persist.rehydrate();
    s.useConfigStore.getState().updateConfig("quality", "high");
    expect(s.useConfigStore.getState().config.channels[0].apiKey).toBe(apiKey);
    expect(JSON.parse(disk.get(s.CONFIG_STORE_KEY)!).state.config.channels[0].apiKey).toBe(apiKey);
});

test("remember write and read-back failures never acknowledge a successful plaintext choice", async () => {
    for (const failure of ["throw", "silent", "read-before", "read-after"]) {
        disk.clear(); await s.useConfigStore.persist.rehydrate();
        s.useConfigStore.setState({ config: { ...structuredClone(s.defaultConfig), channels: [{ ...s.defaultConfig.channels[0], apiKey: "synthetic-remember-failure" }] }, webdav: { ...s.defaultWebdavSyncConfig } });
        const set = storage.setItem, get = storage.getItem; let wrote = false;
        storage.setItem = (key, value) => { wrote = true; if (failure === "throw") throw new Error("synthetic quota"); if (failure !== "silent") set(key, value); };
        storage.getItem = key => { if (failure === "read-before" || (failure === "read-after" && wrote)) throw new Error("synthetic read"); return get(key); };
        try { expect(() => s.chooseSecretPersistence("channel:default", "remember")).toThrow(); expect(s.secretPersistenceStatus("channel:default")).toBe("session"); }
        finally { storage.setItem = set; storage.getItem = get; }
    }
});

test("bootstrap-only values cannot falsely acknowledge plaintext remembering", async () => {
    disk.clear(); await s.useConfigStore.persist.rehydrate();
    s.useConfigStore.setState({ config: structuredClone(s.defaultConfig), webdav: { ...s.defaultWebdavSyncConfig } });
    s.useConfigStore.getState().importBootstrapCredentials("https://bootstrap.invalid/exact/v1", "synthetic-bootstrap-choice");
    const id = `channel:${s.useConfigStore.getState().config.channels.at(-1)!.id}`;
    expect(() => s.chooseSecretPersistence(id, "remember")).toThrow(/URL|内存|会话/);
    expect(s.secretPersistenceStatus(id)).toBe("session");
    expect(disk.get(s.CONFIG_STORE_KEY)).not.toContain("synthetic-bootstrap-choice");
});

test("changing a remembered secret away and back never revives the earlier choice", async () => {
    disk.clear(); await s.useConfigStore.persist.rehydrate();
    s.useConfigStore.setState({ config: structuredClone(s.defaultConfig), webdav: { ...s.defaultWebdavSyncConfig } });
    s.useConfigStore.getState().updateConfig("channels", [{ ...s.defaultConfig.channels[0], apiKey: "synthetic-no-revival" }]);
    s.chooseSecretPersistence("channel:default", "remember");
    const channel = s.useConfigStore.getState().config.channels[0];
    s.useConfigStore.getState().updateConfig("channels", [{ ...channel, apiKey: "synthetic-temporary-edit" }]);
    s.useConfigStore.getState().updateConfig("channels", [channel]);
    expect(disk.get(s.CONFIG_STORE_KEY)).not.toContain("synthetic-no-revival");
});

test("legacy values survive unrelated writes until explicit choice; changed values never inherit remembering", async () => {
    disk.set(s.CONFIG_STORE_KEY, JSON.stringify({ version: 0, state: { config: { ...s.defaultConfig, channels: [{ ...s.defaultConfig.channels[0], apiKey: "synthetic-legacy-api" }] }, webdav: { ...s.defaultWebdavSyncConfig, username: "synthetic-user", password: "synthetic-legacy-dav" } } }));
    await s.useConfigStore.persist.rehydrate();
    s.useConfigStore.getState().updateConfig("quality", "high");
    expect(disk.get(s.CONFIG_STORE_KEY)).toContain("synthetic-legacy-api");
    expect(disk.get(s.CONFIG_STORE_KEY)).toContain("synthetic-legacy-dav");
    const before = disk.get(s.CONFIG_STORE_KEY);
    expect(() => s.useConfigStore.getState().updateConfig("channels", [])).toThrow(/旧|选择/);
    expect(disk.get(s.CONFIG_STORE_KEY)).toBe(before);
    s.chooseSecretPersistence("channel:default", "forget");
    expect(disk.get(s.CONFIG_STORE_KEY)).not.toContain("synthetic-legacy-api");
    expect(s.useConfigStore.getState().config.channels[0].apiKey).toBe("synthetic-legacy-api");
    expect(disk.get(s.CONFIG_STORE_KEY)).toContain("synthetic-legacy-dav");
    s.chooseSecretPersistence("webdav", "remember");
    await s.useConfigStore.persist.rehydrate();
    expect(s.useConfigStore.getState().webdav.password).toBe("synthetic-legacy-dav");
    s.chooseSecretPersistence("webdav", "forget");
    s.useConfigStore.getState().updateConfig("channels", [{ ...s.defaultConfig.channels[0], apiKey: "synthetic-remember-api" }]);
    s.chooseSecretPersistence("channel:default", "remember");
    expect(disk.get(s.CONFIG_STORE_KEY)).toContain("synthetic-remember-api");
    await s.useConfigStore.persist.rehydrate();
    expect(s.useConfigStore.getState().config.channels[0].apiKey).toBe("synthetic-remember-api");
    s.chooseSecretPersistence("channel:default", "remember");
    s.useConfigStore.getState().updateConfig("channels", [{ ...s.useConfigStore.getState().config.channels[0], apiKey: "synthetic-changed-api" }]);
    expect(disk.get(s.CONFIG_STORE_KEY)).not.toContain("synthetic-changed-api");
    expect(disk.get(s.CONFIG_STORE_KEY)).not.toContain("synthetic-remember-api");
    expect(JSON.parse(disk.get(s.CONFIG_STORE_KEY)!).state.config.quality).toBe("high");
});
