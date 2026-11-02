import { afterAll, beforeEach, expect, test } from "bun:test";
import { createJSONStorage } from "zustand/middleware";

const descriptors = ["window", "localStorage"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
const disk = new Map<string, string>();
const writes: string[] = [];
const storage = {
    getItem: (key: string) => disk.get(key) ?? null,
    setItem: (key: string, value: string) => { writes.push(key); disk.set(key, value); },
    removeItem: (key: string) => { writes.push(key); disk.delete(key); },
};
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: storage, confirm: () => true } });
const c = await import("../src/stores/use-config-store");
const p = await import("../src/stores/use-prompt-source-store");
const { DEFAULT_PROMPT_SOURCES } = await import("../src/services/api/prompt-source-presets");
const files = await import("../src/services/config-file");
c.useConfigStore.persist.setOptions({ storage: createJSONStorage(() => storage) });
p.usePromptSourceStore.persist.setOptions({ storage: createJSONStorage(() => storage) });
afterAll(() => { for (const [key, descriptor] of descriptors) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); });
beforeEach(async () => {
    disk.clear();
    await c.useConfigStore.persist.rehydrate();
    await p.usePromptSourceStore.persist.rehydrate();
    c.useConfigStore.setState({ config: structuredClone(c.defaultConfig), webdav: { ...c.defaultWebdavSyncConfig } });
    p.usePromptSourceStore.setState({ sources: structuredClone(DEFAULT_PROMPT_SOURCES), schedule: { intervalMinutes: 30, lastFetchedAt: "" } });
    writes.length = 0;
});
const file = (data: unknown) => new File([JSON.stringify(data)], "synthetic-config.json");

test("redacted v1 import retains exact-recipient credentials without persisting session secrets", async () => {
    c.useConfigStore.getState().updateConfig("channels", [{ ...c.defaultConfig.channels[0], apiKey: "synthetic-import-session" }]);
    c.useConfigStore.getState().updateWebdavConfig("url", "https://dav.invalid/files");
    c.useConfigStore.getState().updateWebdavConfig("username", "synthetic-import-user");
    c.useConfigStore.getState().updateWebdavConfig("password", "synthetic-import-dav");
    const data = files.createAppConfigExport();
    await files.importAppConfig(file(data));
    expect(c.useConfigStore.getState().config.channels[0].apiKey).toBe("synthetic-import-session");
    expect(c.useConfigStore.getState().webdav.password).toBe("synthetic-import-dav");
    expect(disk.get(c.CONFIG_STORE_KEY)).not.toContain("synthetic-import");
    await c.useConfigStore.persist.rehydrate();
    expect(c.useConfigStore.getState().config.channels[0].apiKey).toBe("");
});

test("second-store failure independently restores live data and exact raw before-images", async () => {
    const before = { config: structuredClone(c.useConfigStore.getState().config), prompt: structuredClone(p.usePromptSourceStore.getState().sources), raw: new Map(disk) };
    const data = files.createAppConfigExport();
    data.config.quality = "high";
    data.promptSources.sources[0].enabled = false;
    const setItem = storage.setItem;
    let failed = false;
    storage.setItem = (key, value) => { if (key.includes("prompt_source") && !failed) { failed = true; throw new Error("synthetic apply failure"); } setItem(key, value); };
    try {
        const error = await files.importAppConfig(file(data)).catch(error => error);
        expect(error.restoration).toBe("verified");
        expect(c.useConfigStore.getState().config).toEqual(before.config);
        expect(p.usePromptSourceStore.getState().sources).toEqual(before.prompt);
        expect(disk).toEqual(before.raw);
    } finally { storage.setItem = setItem; }
});

test("detected durable divergence never triggers a compensating persist setter or recovery-state write", async () => {
    const { useConfigImportRecovery } = await import("../src/services/config-import");
    const data = files.createAppConfigExport();
    data.config.quality = "high";
    const setItem = storage.setItem;
    let intervened = false;
    const foreign = "synthetic-durable-intervention";
    storage.setItem = (key, value) => { setItem(key, value); if (!intervened) { intervened = true; disk.set(key, foreign); } };
    try {
        const error = await files.importAppConfig(file(data)).catch(error => error);
        expect(error.restoration).toBe("incomplete");
        expect(error.reason).toBe("divergence");
        expect(error.compensationAttempts).toBe(0);
        expect(writes).toEqual([c.CONFIG_STORE_KEY]);
        expect(disk.get(c.CONFIG_STORE_KEY)).toBe(foreign);
        expect(useConfigImportRecovery.getState().failure).toBe(error);
        useConfigImportRecovery.setState({ failure: null });
        useConfigImportRecovery.setState({ failure: error });
        expect(writes).toEqual([c.CONFIG_STORE_KEY]);
        c.useConfigStore.getState().openConfigDialog(false, "channels");
        c.useConfigStore.getState().setConfigDialogOpen(false);
        c.useConfigStore.getState().clearPromptContinue();
        expect(writes).toEqual([c.CONFIG_STORE_KEY]);
        expect(disk.get(c.CONFIG_STORE_KEY)).toBe(foreign);
    } finally { storage.setItem = setItem; }
});

test("cancelled import writes nothing and confirmation-time edits supply the final inherited credential", async () => {
    const data = files.createAppConfigExport();
    expect((await files.importAppConfig(file(data), async () => false)).cancelled).toBe(true);
    expect(writes).toEqual([]);
    await files.importAppConfig(file(data), async warning => {
        expect(warning).toContain("不是跨存储事务");
        c.useConfigStore.getState().updateConfig("channels", [{ ...c.defaultConfig.channels[0], apiKey: "synthetic-final-snapshot" }]);
        return true;
    });
    expect(c.useConfigStore.getState().config.channels[0].apiKey).toBe("synthetic-final-snapshot");
    expect(disk.get(c.CONFIG_STORE_KEY)).not.toContain("synthetic-final-snapshot");
});

test("credential fields distinguish explicit clear, supplied value and changed-recipient omission", async () => {
    c.useConfigStore.getState().updateConfig("channels", [{ ...c.defaultConfig.channels[0], apiKey: "synthetic-three-state-old" }]);
    c.useConfigStore.getState().updateWebdavConfig("url", "https://dav.invalid/files");
    c.useConfigStore.getState().updateWebdavConfig("username", "synthetic-three-state-user");
    c.useConfigStore.getState().updateWebdavConfig("password", "synthetic-three-state-dav");
    const data = files.createAppConfigExport();
    data.config.channels[0].baseUrl += "/changed-path";
    data.webdav.directory += "/changed-directory";
    data.webdav.username = "synthetic-supplied-user";
    await files.importAppConfig(file(data));
    expect(c.useConfigStore.getState().config.channels[0].apiKey).toBe("");
    expect(c.useConfigStore.getState().webdav.password).toBe("");
    expect(c.useConfigStore.getState().webdav.username).toBe("synthetic-supplied-user");
    data.config.channels[0].apiKey = "synthetic-supplied-key";
    data.webdav.username = "";
    await files.importAppConfig(file(data));
    expect(c.useConfigStore.getState().config.channels[0].apiKey).toBe("synthetic-supplied-key");
    expect(c.useConfigStore.getState().webdav.username).toBe("");
    expect(disk.get(c.CONFIG_STORE_KEY)).not.toContain("synthetic-");
});

test("first apply failure restores exact absent storage keys and preserves actions", async () => {
    disk.clear();
    const action = c.useConfigStore.getState().updateConfig;
    const data = files.createAppConfigExport();
    data.config.quality = "high";
    const setItem = storage.setItem;
    let fail = true;
    storage.setItem = (key, value) => { if (fail) { fail = false; throw new Error("synthetic first apply"); } setItem(key, value); };
    try {
        const error = await files.importAppConfig(file(data)).catch(error => error);
        expect(error.restoration).toBe("verified");
        expect(error.reason).toBe("apply");
        expect(disk.size).toBe(0);
        expect(c.useConfigStore.getState().config.quality).toBe(c.defaultConfig.quality);
        expect(c.useConfigStore.getState().updateConfig).toBe(action);
    } finally { storage.setItem = setItem; }
});

test("first-store compensation failure cannot skip second-store restoration", async () => {
    const data = files.createAppConfigExport();
    data.config.quality = "high";
    data.promptSources.sources[0].enabled = false;
    const originalPromptRaw = disk.get(p.usePromptSourceStore.persist.getOptions().name!);
    const setItem = storage.setItem;
    let configCalls = 0, promptCalls = 0;
    storage.setItem = (key, value) => {
        if (key === c.CONFIG_STORE_KEY && ++configCalls > 1) throw new Error("synthetic config compensation");
        if (key.includes("prompt_source") && ++promptCalls === 1) throw new Error("synthetic second apply");
        setItem(key, value);
    };
    try {
        const error = await files.importAppConfig(file(data)).catch(error => error);
        expect(error.restoration).toBe("incomplete");
        expect(error.reason).toBe("apply");
        expect(error.compensationAttempts).toBe(2);
        expect(promptCalls).toBeGreaterThan(1);
        expect(disk.get(p.usePromptSourceStore.persist.getOptions().name!)).toBe(originalPromptRaw);
        expect(p.usePromptSourceStore.getState().sources[0].enabled).toBe(true);
    } finally { storage.setItem = setItem; }
});

test("nested malformed identities, credential types and unstable hydration reject before all writes", async () => {
    const mutations = [
        (data: ReturnType<typeof files.createAppConfigExport>) => { data.config.channels.push({ ...data.config.channels[0] }); },
        (data: ReturnType<typeof files.createAppConfigExport>) => { data.config.channels[0].id = " default"; },
        (data: ReturnType<typeof files.createAppConfigExport>) => { data.config.channels[0].apiKey = null as never; },
        (data: ReturnType<typeof files.createAppConfigExport>) => { data.config.channels[0].models[0].script = " return 'synthetic'; "; },
        (data: ReturnType<typeof files.createAppConfigExport>) => { data.promptSources.sources[0].name = "not the built-in name"; },
        (data: ReturnType<typeof files.createAppConfigExport>) => { data.promptSources.sources.push({ ...data.promptSources.sources[0], builtIn: false }); },
        (data: ReturnType<typeof files.createAppConfigExport>) => { data.config.imageModel = "missing::model"; },
    ];
    for (const mutate of mutations) {
        const before = new Map(disk);
        const data = files.createAppConfigExport();
        mutate(data);
        await expect(files.importAppConfig(file(data))).rejects.toThrow();
        expect(writes).toEqual([]);
        expect(disk).toEqual(before);
    }
});

test("unresolved legacy secrets reject the whole replacement even when omitted secrets would be retained", async () => {
    disk.set(c.CONFIG_STORE_KEY, JSON.stringify({ state: { config: { ...c.defaultConfig, channels: [{ ...c.defaultConfig.channels[0], apiKey: "synthetic-unresolved-legacy" }] }, webdav: c.defaultWebdavSyncConfig }, version: 0 }));
    await c.useConfigStore.persist.rehydrate();
    const data = files.createAppConfigExport();
    const before = new Map(disk);
    writes.length = 0;
    await expect(files.importAppConfig(file(data))).rejects.toThrow(/旧|选择/);
    expect(writes).toEqual([]);
    expect(disk).toEqual(before);
    c.chooseSecretPersistence("channel:default", "forget");
    await files.importAppConfig(file(data));
    expect(c.useConfigStore.getState().config.channels[0].apiKey).toBe("synthetic-unresolved-legacy");
    expect(disk.get(c.CONFIG_STORE_KEY)).not.toContain("synthetic-unresolved-legacy");
});

test("read errors and silent or mismatched persistence never report a successful import", async () => {
    for (const phase of ["before-config", "before-prompt", "after-config", "after-prompt", "silent", "mismatch"] as const) {
        const data = files.createAppConfigExport();
        data.config.quality = "high";
        data.promptSources.sources[0].enabled = false;
        const original = new Map(disk);
        const before = structuredClone({ config: c.useConfigStore.getState().config, sources: p.usePromptSourceStore.getState().sources });
        const get = storage.getItem, set = storage.setItem;
        let attempts = 0;
        writes.length = 0;
        storage.getItem = key => {
            if ((phase === "before-config" && key === c.CONFIG_STORE_KEY) || (phase === "before-prompt" && key.includes("prompt_source")) || (phase === "after-config" && attempts === 1) || (phase === "after-prompt" && attempts === 2)) throw new Error("synthetic read failure");
            return get(key);
        };
        storage.setItem = (key, value) => { attempts++; if (phase === "silent") return; set(key, phase === "mismatch" ? "synthetic-unexplained-bytes" : value); };
        try {
            const error = await files.importAppConfig(file(data)).catch(error => error);
            expect(error).toBeInstanceOf(Error);
            if (phase.startsWith("before")) {
                expect(attempts).toBe(0);
                expect(disk).toEqual(original);
                expect(c.useConfigStore.getState().config).toEqual(before.config);
                expect(p.usePromptSourceStore.getState().sources).toEqual(before.sources);
            } else {
                expect(error.restoration).toBe("incomplete");
                expect(error.reason).toBe(phase.startsWith("after") ? "unverified" : "divergence");
                expect(error.compensationAttempts).toBe(0);
                expect(attempts).toBe(phase === "after-prompt" ? 2 : 1);
            }
        } finally {
            storage.getItem = get; storage.setItem = set;
            disk.clear(); for (const [key, value] of original) disk.set(key, value);
            await c.useConfigStore.persist.rehydrate(); await p.usePromptSourceStore.persist.rehydrate();
        }
    }
});

test("second-store compensation failure cannot hide the verified first-store restoration", async () => {
    const data = files.createAppConfigExport();
    data.config.quality = "high";
    data.promptSources.sources[0].enabled = false;
    const original = new Map(disk), set = storage.setItem;
    let promptAttempts = 0;
    storage.setItem = (key, value) => { if (key.includes("prompt_source") && ++promptAttempts) throw new Error("synthetic prompt apply/compensation failure"); set(key, value); };
    try {
        const error = await files.importAppConfig(file(data)).catch(error => error);
        expect(error.restoration).toBe("verified"); // Throwing writes can still leave the exact old bytes and restored memory.
        expect(error.reason).toBe("apply");
        expect(error.compensationAttempts).toBe(2);
        expect(promptAttempts).toBe(3);
        expect(disk).toEqual(original);
        expect(c.useConfigStore.getState().config.quality).toBe(c.defaultConfig.quality);
        expect(p.usePromptSourceStore.getState().sources[0].enabled).toBe(true);
    } finally { storage.setItem = set; }
});

test("actual redacted export missing recipient addresses rejects the entire file with actionable field diagnostics", async () => {
    const channels = structuredClone(c.defaultConfig.channels);
    channels.push({ ...structuredClone(channels[0]), id: "missing-address-one", baseUrl: "https://one.invalid/v1?api_key=synthetic-address-one" });
    channels.push({ ...structuredClone(channels[0]), id: "missing-address-two", baseUrl: "https://two.invalid/v1?token=synthetic-address-two" });
    c.useConfigStore.getState().updateConfig("channels", channels);
    const data = files.createAppConfigExport();
    expect(JSON.stringify(data)).not.toContain("synthetic-address-");
    expect(Object.hasOwn(JSON.parse(JSON.stringify(data)).config.channels[1], "baseUrl")).toBe(false);
    const before = c.useConfigStore.getState();
    const original = new Map(disk);
    writes.length = 0;
    let confirmations = 0;
    const error = await files.importAppConfig(file(data), async () => { confirmations++; return true; }).catch(error => error);
    expect(error.message).toContain("config.channels[1].baseUrl");
    expect(error.message).toContain("config.channels[2].baseUrl");
    expect(error.message).toContain("重新导出");
    expect(error.message).toContain("手动重新配置");
    expect(error.message).not.toContain("synthetic-address-");
    expect(confirmations).toBe(0);
    expect(writes).toEqual([]);
    expect(disk).toEqual(original);
    expect(c.useConfigStore.getState()).toBe(before);
});

test("unavailable, async, failed and incomplete hydration reject before import writes", async () => {
    const data = files.createAppConfigExport();
    const options = c.useConfigStore.persist.getOptions();
    const original = new Map(disk), before = c.useConfigStore.getState();
    c.useConfigStore.persist.setOptions({ storage: undefined });
    await expect(files.importAppConfig(file(data))).rejects.toThrow(/存储/);
    expect(writes).toEqual([]);
    c.useConfigStore.persist.setOptions(options);
    const originalGet = storage.getItem;
    let release!: (value: null) => void;
    const pendingRead = new Promise<null>(resolve => { release = resolve; });
    c.useConfigStore.persist.setOptions({ storage: { ...options.storage!, getItem: () => pendingRead } });
    const hydrating = c.useConfigStore.persist.rehydrate();
    expect(c.useConfigStore.persist.hasHydrated()).toBe(false);
    await expect(files.importAppConfig(file(data))).rejects.toThrow(/水合/);
    expect(writes).toEqual([]);
    release(null); await hydrating;
    await expect(files.importAppConfig(file(data))).rejects.toThrow(/同步/);
    expect(writes).toEqual([]);
    c.useConfigStore.persist.setOptions(options);
    storage.getItem = () => { throw new Error("synthetic hydration read"); };
    await c.useConfigStore.persist.rehydrate();
    storage.getItem = originalGet;
    expect(c.useConfigStore.persist.hasHydrated()).toBe(false);
    await expect(files.importAppConfig(file(data))).rejects.toThrow(/水合/);
    expect(writes).toEqual([]);
    expect(disk).toEqual(original);
    expect(c.useConfigStore.getState().config).toEqual(before.config);
    await c.useConfigStore.persist.rehydrate();
});

test("partially written second store with failed compensation is incomplete, first restoration still verified", async () => {
    const data = files.createAppConfigExport();
    data.config.quality = "high"; data.promptSources.sources[0].enabled = false;
    const original = new Map(disk), set = storage.setItem;
    const promptKey = p.usePromptSourceStore.persist.getOptions().name!;
    let attempts = 0;
    storage.setItem = (key, value) => {
        if (key === promptKey) { if (++attempts === 1) set(key, value); throw new Error("synthetic partial apply and failed compensation"); }
        set(key, value);
    };
    try {
        const error = await files.importAppConfig(file(data)).catch(error => error);
        expect(error.restoration).toBe("incomplete"); expect(error.reason).toBe("apply");
        expect(error.compensationAttempts).toBe(2); expect(attempts).toBe(3);
        expect(disk.get(c.CONFIG_STORE_KEY)).toBe(original.get(c.CONFIG_STORE_KEY));
        expect(disk.get(promptKey)).not.toBe(original.get(promptKey));
        expect(c.useConfigStore.getState().config.quality).toBe(c.defaultConfig.quality);
        expect(p.usePromptSourceStore.getState().sources[0].enabled).toBe(true);
        expect(error.recovery).toBeDefined();
    } finally { storage.setItem = set; }
});

test("divergence discovered after first compensation stops later writes and reports actual history", async () => {
    const data = files.createAppConfigExport();
    data.config.quality = "high";
    const set = storage.setItem; let configAttempts = 0, promptAttempts = 0;
    storage.setItem = (key, value) => {
        if (key.includes("prompt_source") && ++promptAttempts === 1) throw new Error("synthetic second apply");
        set(key, value);
        if (key === c.CONFIG_STORE_KEY && ++configAttempts === 2) disk.set(key, "synthetic-post-compensation-intervention");
    };
    try {
        const error = await files.importAppConfig(file(data)).catch(error => error);
        expect(error.restoration).toBe("incomplete"); expect(error.reason).toBe("divergence");
        expect(error.compensationAttempts).toBe(1);
        expect(error.message).toContain("此前已尝试部分补偿");
        expect(error.message).not.toContain("未尝试覆盖式恢复");
        expect(promptAttempts).toBe(1); expect(configAttempts).toBe(2);
        expect(disk.get(c.CONFIG_STORE_KEY)).toBe("synthetic-post-compensation-intervention");
        const count = writes.length;
        c.useConfigStore.getState().openConfigDialog(); c.useConfigStore.getState().setConfigDialogOpen(false);
        expect(writes.length).toBe(count);
    } finally { storage.setItem = set; }
});

test("silent or mismatched writes in either apply lane stop without overwriting unexplained bytes", async () => {
    for (const lane of ["config", "prompt"] as const) for (const mode of ["silent", "mismatch"] as const) {
        c.useConfigStore.setState({ config: structuredClone(c.defaultConfig), webdav: { ...c.defaultWebdavSyncConfig } });
        p.usePromptSourceStore.setState({ sources: structuredClone(DEFAULT_PROMPT_SOURCES), schedule: { intervalMinutes: 30, lastFetchedAt: "" } });
        const data = files.createAppConfigExport(); data.config.quality = "high"; data.promptSources.sources[0].enabled = false;
        const key = lane === "config" ? c.CONFIG_STORE_KEY : p.usePromptSourceStore.persist.getOptions().name!;
        const original = disk.get(key), set = storage.setItem; let attempts = 0; writes.length = 0;
        storage.setItem = (target, value) => { attempts++; if (target !== key) set(target, value); else if (mode === "mismatch") set(target, "synthetic-lane-divergence"); };
        try {
            const error = await files.importAppConfig(file(data)).catch(error => error);
            expect(error.restoration).toBe("incomplete"); expect(error.reason).toBe("divergence"); expect(error.compensationAttempts).toBe(0);
            expect(attempts).toBe(lane === "config" ? 1 : 2); expect(disk.get(key)).toBe(mode === "silent" ? original : "synthetic-lane-divergence");
        } finally { storage.setItem = set; }
    }
});

test("ordinary memory-restoration failure still attempts the other lane and preserves exact durable originals", async () => {
    const data = files.createAppConfigExport(); data.config.quality = "high"; data.promptSources.sources[0].enabled = false;
    const original = new Map(disk), setter = c.useConfigStore.setState, set = storage.setItem;
    let configCalls = 0, promptCalls = 0;
    c.useConfigStore.setState = ((...args: Parameters<typeof setter>) => { if (++configCalls > 1) throw new Error("synthetic memory restore failure"); return (setter as Function)(...args); }) as typeof setter;
    storage.setItem = (key, value) => { if (key.includes("prompt_source") && ++promptCalls === 1) throw new Error("synthetic second apply"); set(key, value); };
    try {
        const error = await files.importAppConfig(file(data)).catch(error => error);
        expect(error.restoration).toBe("incomplete"); expect(error.reason).toBe("apply"); expect(error.compensationAttempts).toBe(2);
        expect(configCalls).toBe(2); expect(promptCalls).toBeGreaterThan(1); expect(disk).toEqual(original);
        expect(c.useConfigStore.getState().config.quality).toBe("high"); expect(p.usePromptSourceStore.getState().sources[0].enabled).toBe(true); expect(error.recovery).toBeDefined();
    } finally { c.useConfigStore.setState = setter; storage.setItem = set; }
});

test("complete v1 schema negatives reject before writes without normalizing identities or preferences", async () => {
    const mutations: Array<(data: any) => void> = [
        data => { data.app = "other-app"; }, data => { data.version = 2; }, data => { delete data.version; }, data => { data.exportedAt = 0; },
        data => { data.config = []; }, data => { data.webdav = null; }, data => { data.promptSources.sources = {}; }, data => { data.promptSources.schedule.intervalMinutes = 31; },
        data => { data.config.quality = false; }, data => { data.config.proxyEnabled = "true"; }, data => { data.config.channels[0].apiFormat = "other"; },
        data => { data.config.channels[0].id = "a::b"; }, data => { data.config.channels[0].name = " padded "; }, data => { data.config.channels[0].models.push({ ...data.config.channels[0].models[0] }); },
        data => { data.config.models.push("unknown::model"); }, data => { data.config.audioSpeed = ""; }, data => { data.config.reasoningEffort = "other"; }, data => { data.config.autoFocusOnSelect = 1; },
        data => { data.promptSources.sources.push({ ...data.promptSources.sources[0], id: "synthetic-fake-built-in", builtIn: true }); },
    ];
    for (const mutate of mutations) {
        const data = files.createAppConfigExport(); mutate(data);
        const state = c.useConfigStore.getState(), prompt = p.usePromptSourceStore.getState(), original = new Map(disk); writes.length = 0;
        await expect(files.importAppConfig(file(data))).rejects.toThrow();
        expect(c.useConfigStore.getState()).toBe(state); expect(p.usePromptSourceStore.getState()).toBe(prompt); expect(disk).toEqual(original); expect(writes).toEqual([]);
    }
});

test("saving a changed script preserves separately approved new bytes but revokes old bytes", async () => {
    const trust = await import("../src/lib/executable-trust");
    const { runModelPlugin } = await import("../src/services/api/model-plugin");
    const old = "return 'synthetic-old-editor'", script = "return 'synthetic-new-editor'";
    const channel = { ...structuredClone(c.defaultConfig.channels[0]), models: [{ name: "gpt-5.5", capability: "text" as const, script: old }] };
    c.useConfigStore.getState().updateConfig("channels", [channel]);
    await trust.approveExecutable("model", old, async () => true);
    await trust.approveExecutable("model", script, async () => true);
    c.useConfigStore.getState().updateConfig("channels", [{ ...channel, models: [{ ...channel.models[0], script }] }]);
    expect(await runModelPlugin({ config: c.useConfigStore.getState().config, capability: "text", script })).toBe("synthetic-new-editor");
    await expect(runModelPlugin({ config: c.useConfigStore.getState().config, capability: "text", script: old })).rejects.toThrow(/信任|授权/);
});

test("changing configured executable bytes invalidates old consent even if the source is restored", async () => {
    const trust = await import("../src/lib/executable-trust");
    const { runModelPlugin } = await import("../src/services/api/model-plugin");
    const script = "return 'synthetic-script-revival'";
    const channel = { ...structuredClone(c.defaultConfig.channels[0]), models: [{ name: "gpt-5.5", capability: "text" as const, script }] };
    c.useConfigStore.getState().updateConfig("channels", [channel]);
    await trust.approveExecutable("model", script, async () => true);
    c.useConfigStore.getState().updateConfig("channels", [{ ...channel, models: [{ ...channel.models[0], script: script + ";" }] }]);
    c.useConfigStore.getState().updateConfig("channels", [channel]);
    await expect(runModelPlugin({ config: c.useConfigStore.getState().config, capability: "text", script })).rejects.toThrow(/信任|授权/);
});

test("importing executable source never reuses session execution approval", async () => {
    const trust = await import("../src/lib/executable-trust");
    const { runModelPlugin } = await import("../src/services/api/model-plugin");
    const script = "return 'synthetic-import-trust'";
    c.useConfigStore.getState().updateConfig("channels", [{ ...c.defaultConfig.channels[0], models: c.defaultConfig.channels[0].models.map((model, index) => index ? model : { ...model, script }) }]);
    await trust.approveExecutable("model", script, async () => true);
    const data = await files.createSensitiveAppConfigExport(async () => true);
    await files.importAppConfig(file(data));
    await expect(runModelPlugin({ config: c.useConfigStore.getState().config, capability: "text", script })).rejects.toThrow(/信任|授权/);
});

test("failed replacement restores exact remember choices without changing bootstrap guards", async () => {
    const state = c.useConfigStore.getState();
    state.updateConfig("channels", [{ ...state.config.channels[0], apiKey: "synthetic-policy-before" }]);
    c.chooseSecretPersistence("channel:default", "remember");
    state.importBootstrapCredentials("https://bootstrap.invalid/exact/v1", "synthetic-policy-bootstrap");
    const bootstrap = c.useConfigStore.getState().config.channels.at(-1)!;
    const before = new Map(disk);
    const data = files.createAppConfigExport();
    data.config.channels[0].apiKey = "synthetic-policy-before";
    const set = storage.setItem; let failed = false;
    storage.setItem = (key, value) => { if (key.includes("prompt_source") && !failed) { failed = true; throw new Error("synthetic rollback policy"); } set(key, value); };
    try {
        const error = await files.importAppConfig(file(data)).catch(error => error);
        expect(error.restoration).toBe("verified");
        expect(disk).toEqual(before);
        expect(c.secretPersistenceStatus("channel:default")).toBe("remember");
        expect(() => c.assertBootstrapRecipient({ ...bootstrap, baseUrl: "https://changed.invalid" })).toThrow();
    } finally { storage.setItem = set; }
    state.updateConfig("quality", "high");
    expect(disk.get(c.CONFIG_STORE_KEY)).toContain("synthetic-policy-before");
    expect(disk.get(c.CONFIG_STORE_KEY)).not.toContain("synthetic-policy-bootstrap");
});

test("every secret field independently distinguishes omission, supplied value, clear and invalid type", async () => {
    const old = { flat: "synthetic-matrix-flat", channel: "synthetic-matrix-channel", username: "synthetic-matrix-user", password: "synthetic-matrix-password" };
    const fields = ["flat", "channel", "username", "password"] as const;
    for (const target of fields) for (const mode of ["omitted", "set", "clear", "null", "number", "object", "boolean"] as const) {
        disk.clear(); await c.useConfigStore.persist.rehydrate();
        c.useConfigStore.setState({ config: { ...structuredClone(c.defaultConfig), apiKey: old.flat, channels: [{ ...structuredClone(c.defaultConfig.channels[0]), apiKey: old.channel }] }, webdav: { ...c.defaultWebdavSyncConfig, url: "https://dav.invalid/exact", username: old.username, password: old.password } });
        const data = files.createAppConfigExport();
        const container = target === "flat" ? data.config : target === "channel" ? data.config.channels[0] : data.webdav;
        const key = target === "flat" || target === "channel" ? "apiKey" : target;
        const values = { set: "synthetic-matrix-new", clear: "", null: null, number: 1, object: {}, boolean: true };
        if (mode !== "omitted") (container as Record<string, unknown>)[key] = values[mode];
        const before = new Map(disk), current = c.useConfigStore.getState(); writes.length = 0;
        if (["null", "number", "object", "boolean"].includes(mode)) {
            await expect(files.importAppConfig(file(data))).rejects.toThrow();
            expect(writes).toEqual([]); expect(disk).toEqual(before); expect(c.useConfigStore.getState()).toBe(current);
        } else {
            await files.importAppConfig(file(data));
            const { config, webdav } = c.useConfigStore.getState();
            const actual = { flat: config.apiKey, channel: config.channels[0].apiKey, username: webdav.username, password: webdav.password };
            for (const field of fields) expect(actual[field]).toBe(field === target && mode === "set" ? values.set : field === target && mode === "clear" ? "" : old[field]);
            expect(disk.get(c.CONFIG_STORE_KEY)).not.toContain("synthetic-matrix");
        }
    }
});

test("same model on another channel and every changed address dimension never inherit credentials", async () => {
    const { prepareConfigImport, validateConfigImport } = await import("../src/services/config-import");
    const { fetchChannelModels } = await import("../src/services/api/image");
    const state = c.useConfigStore.getState();
    state.updateConfig("channels", [{ ...state.config.channels[0], baseUrl: "https://recipient.invalid:443/exact/v1", apiKey: "synthetic-no-transfer" }]);
    state.updateWebdavConfig("url", "https://dav.invalid/exact"); state.updateWebdavConfig("username", "synthetic-dav-user"); state.updateWebdavConfig("password", "synthetic-dav-pass");
    const before = { config: c.useConfigStore.getState().config, webdav: c.useConfigStore.getState().webdav };
    for (const recipient of ["http://recipient.invalid:443/exact/v1", "https://other.invalid:443/exact/v1", "https://recipient.invalid:444/exact/v1", "https://recipient.invalid:443/other/v1", "https://recipient.invalid:443/exact/v1/", "https://recipient.invalid:443/exact"]) {
        const data = files.createAppConfigExport(); data.config.channels[0].baseUrl = recipient;
        const candidate = prepareConfigImport(validateConfigImport(data), before);
        expect(candidate.config.channels[0].apiKey).toBe("");
    }
    const data = files.createAppConfigExport();
    data.config.channels[0].id = "other-channel";
    for (const key of ["model", "imageModel", "videoModel", "textModel", "audioModel"] as const) data.config[key] = data.config[key].replace("default::", "other-channel::");
    data.config.models = data.config.models.map(model => model.replace("default::", "other-channel::"));
    data.webdav.url += "/different";
    const candidate = prepareConfigImport(validateConfigImport(data), before);
    expect(candidate.config.channels[0].apiKey).toBe(""); expect(candidate.webdav.username).toBe(""); expect(candidate.webdav.password).toBe("");
    expect(candidate.config.channels[0].models).toEqual(before.config.channels[0].models);
    expect(state.isAiConfigReady(candidate.config, candidate.config.textModel)).toBe(false);
    const fetch = globalThis.fetch; const headers: string[] = [];
    globalThis.fetch = (async (input, init) => { headers.push(new Headers(init?.headers || (input instanceof Request ? input.headers : {})).get("authorization") || ""); return Response.json({ data: [] }); }) as typeof fetch;
    try { await fetchChannelModels(candidate.config.channels[0]); expect(headers).toHaveLength(1); expect(headers.join()).not.toContain("synthetic-no-transfer"); }
    finally { globalThis.fetch = fetch; }
});

test("supplied import values do not reuse earlier remember consent even when bytes match", async () => {
    const state = c.useConfigStore.getState();
    state.updateConfig("apiKey", "synthetic-flat-repeat");
    state.updateConfig("channels", [{ ...state.config.channels[0], apiKey: "synthetic-channel-repeat" }]);
    state.updateWebdavConfig("username", "synthetic-user-repeat");
    state.updateWebdavConfig("password", "synthetic-password-retained");
    for (const id of ["flat", "channel:default", "webdav"]) c.chooseSecretPersistence(id, "remember");
    const data = files.createAppConfigExport();
    data.config.apiKey = "synthetic-flat-repeat";
    data.config.channels[0].apiKey = "synthetic-channel-repeat";
    data.webdav.username = "synthetic-user-repeat";
    await files.importAppConfig(file(data));
    const raw = disk.get(c.CONFIG_STORE_KEY)!;
    for (const value of ["synthetic-flat-repeat", "synthetic-channel-repeat", "synthetic-user-repeat"]) expect(raw).not.toContain(value);
    expect(raw).toContain("synthetic-password-retained"); // Omitted field keeps its exact-recipient choice.
    expect(c.useConfigStore.getState().config.channels[0].apiKey).toBe("synthetic-channel-repeat");
    expect(c.useConfigStore.getState().webdav.username).toBe("synthetic-user-repeat");
});

test("malformed nested v1 import is rejected with zero writes and no live mutation", async () => {
    const before = c.useConfigStore.getState().config;
    const original = new Map(disk);
    const data = files.createAppConfigExport();
    data.config.channels[0].models[0].capability = "not-a-capability" as never;
    await expect(files.importAppConfig(file(data))).rejects.toThrow();
    expect(writes).toEqual([]);
    expect(disk).toEqual(original);
    expect(c.useConfigStore.getState().config).toBe(before);
});
