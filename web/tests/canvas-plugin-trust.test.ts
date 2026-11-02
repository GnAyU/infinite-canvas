import { afterAll, expect, test } from "bun:test";
import { createJSONStorage } from "zustand/middleware";
const oldWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const oldStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: localStorage });
Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage } });
const oldFetch = globalThis.fetch;
const { usePluginStore } = await import("../src/stores/canvas/use-plugin-store");
const loader = await import("../src/lib/canvas/plugin-loader");
const trust = await import("../src/lib/executable-trust");
const disk = new Map<string, string>();
usePluginStore.persist.setOptions({ storage: createJSONStorage(() => ({ getItem: key => disk.get(key) ?? null, setItem: (key, value) => { disk.set(key, value); }, removeItem: key => { disk.delete(key); } })) });
const source = "globalThis.__canvasExecutionCanary = (globalThis.__canvasExecutionCanary || 0) + 1; export default { id: 'synthetic-canvas', name: 'Synthetic', version: '1', nodes: [{ type: 'synthetic:node' }] };";
globalThis.fetch = (async url => String(url) === "/plugins/index.json" ? Response.json(["/plugins/synthetic.js"]) : new Response(source, { headers: { "Content-Type": "text/javascript" } })) as typeof fetch;
afterAll(() => { globalThis.fetch = oldFetch; Reflect.deleteProperty(globalThis, "__canvasExecutionCanary"); if (oldStorage) Object.defineProperty(globalThis, "localStorage", oldStorage); else Reflect.deleteProperty(globalThis, "localStorage"); if (oldWindow) Object.defineProperty(globalThis, "window", oldWindow); else Reflect.deleteProperty(globalThis, "window"); });

test("URL intake and local discovery never evaluate source or legacy enabled cache", async () => {
    Reflect.set(globalThis, "__canvasExecutionCanary", 0);
    const record = await loader.installPluginFromUrl("https://synthetic.invalid/plugin.js");
    expect(Reflect.get(globalThis, "__canvasExecutionCanary")).toBe(0);
    expect(record.enabled).toBe(false);
    disk.set("infinite-canvas:plugin_store", JSON.stringify({ version: 0, state: { plugins: [{ ...record, enabled: true }] } }));
    await usePluginStore.persist.rehydrate();
    expect(usePluginStore.getState().plugins[0].id).toBe(record.id);
    expect(usePluginStore.getState().plugins[0].enabled).toBe(false);
    await loader.ensurePluginsLoaded();
    expect(Reflect.get(globalThis, "__canvasExecutionCanary")).toBe(0);
    expect(usePluginStore.getState().plugins.every(item => !item.enabled)).toBe(true);
});

test("local approval runs exact source; remote replacement and revocation stay inert", async () => {
    const record = usePluginStore.getState().plugins.find(item => item.local)!;
    await expect(loader.setPluginEnabled(record, true)).rejects.toThrow(/授权|信任/);
    await trust.approveExecutable(loader.pluginTrustScope(record.id), source, async () => true);
    await loader.setPluginEnabled(record, true);
    expect(Reflect.get(globalThis, "__canvasExecutionCanary")).toBe(1);
    expect(JSON.parse(disk.get("infinite-canvas:plugin_store")!).state.plugins.every((item: { enabled: boolean }) => !item.enabled)).toBe(true);
    const changed = source + "\n// changed remote bytes";
    globalThis.fetch = (async () => new Response(changed)) as typeof fetch;
    await expect(loader.setPluginEnabled(record, true)).rejects.toThrow(/授权|信任/);
    expect(Reflect.get(globalThis, "__canvasExecutionCanary")).toBe(1);
    await trust.approveExecutable(loader.pluginTrustScope(record.id), changed, async () => true);
    await loader.setPluginEnabled(record, false);
    await usePluginStore.persist.rehydrate();
    await expect(loader.setPluginEnabled(record, true)).rejects.toThrow(/授权|信任/);
    expect(Reflect.get(globalThis, "__canvasExecutionCanary")).toBe(1);
});

test("revocation during module loading blocks a factory before it can execute", async () => {
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    Reflect.set(globalThis, "__factoryEntered", entered.resolve);
    Reflect.set(globalThis, "__factoryRelease", release.promise);
    Reflect.set(globalThis, "__factoryExecutionCanary", 0);
    const code = "globalThis.__factoryEntered(); await globalThis.__factoryRelease; export default () => {globalThis.__factoryExecutionCanary++;return {id:'synthetic-revoked-factory',nodes:[{type:'synthetic-revoked:node'}]}}";
    globalThis.fetch = (async () => new Response(code)) as typeof fetch;
    const record = await loader.installPluginFromUrl("https://synthetic.invalid/revoked-factory.js");
    await trust.approveExecutable(loader.pluginTrustScope(record.id), code, async () => true);
    const enabling = loader.setPluginEnabled(record, true);
    await entered.promise;
    await loader.setPluginEnabled(record, false);
    release.resolve();
    try { await expect(enabling).rejects.toThrow(/授权|信任/); expect(Reflect.get(globalThis, "__factoryExecutionCanary")).toBe(0); }
    finally { for (const key of ["__factoryEntered", "__factoryRelease", "__factoryExecutionCanary"]) Reflect.deleteProperty(globalThis, key); }
});

test("unbound dependency source is disabled before consent or evaluation", async () => {
    for (const module of ["data:text/javascript,export default 1", "https://esm.sh/marked@14", "https://esm.sh/three@0.180.0"]) {
        const code = `globalThis.__canvasExecutionCanary++; const dependency = await import('${module}'); export default {};`;
        globalThis.fetch = (async () => new Response(code)) as typeof fetch;
        const record = await loader.installPluginFromUrl(`https://synthetic.invalid/plugin-${module.length}.js`);
        let confirmations = 0;
        await expect(trust.approveExecutable(loader.pluginTrustScope(record.id), code, async () => { confirmations++; return true; })).rejects.toThrow(/依赖|禁用/);
        expect(confirmations).toBe(0);
        await expect(loader.setPluginEnabled(record, true)).rejects.toThrow(/依赖|禁用/);
        expect(Reflect.get(globalThis, "__canvasExecutionCanary")).toBe(1);
    }
});
