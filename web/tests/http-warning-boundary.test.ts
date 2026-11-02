import { afterAll, expect, test } from "bun:test";
import { createJSONStorage } from "zustand/middleware";
const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const disk = new Map<string, string>();
const storage = { getItem: (key: string) => disk.get(key) ?? null, setItem: (key: string, value: string) => { disk.set(key, value); }, removeItem: (key: string) => { disk.delete(key); } };
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: storage } });
const store = await import("../src/stores/use-config-store");
const { importAppConfig } = await import("../src/services/config-file");
const { usePromptSourceStore } = await import("../src/stores/use-prompt-source-store");
const { DEFAULT_PROMPT_SOURCES } = await import("../src/services/api/prompt-source-presets");
store.useConfigStore.persist.setOptions({ storage: createJSONStorage(() => storage) });
usePromptSourceStore.persist.setOptions({ storage: createJSONStorage(() => storage) });
afterAll(() => {
    for (const [name, descriptor] of [["window", windowDescriptor], ["localStorage", storageDescriptor]] as const) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
    }
});

test("HTTP configure/save and imports expose the same plaintext warning without changing retained values", async () => {
    const channel = { ...store.defaultConfig.channels[0], baseUrl: "http://explicit-channel.invalid/gateway" };
    const config = { ...store.defaultConfig, channels: [channel], proxyEnabled: true, proxyUrl: "https://proxy.invalid", systemPrompt: "unrelated synthetic value" };
    const warnings = store as typeof store & { channelPlaintextWarning: (url: string) => string };
    expect(typeof warnings.channelPlaintextWarning).toBe("function");
    expect(warnings.channelPlaintextWarning(channel.baseUrl)).toContain("明文");
    expect(warnings.channelPlaintextWarning("https://channel.invalid")).toBe("");
    await store.useConfigStore.persist.rehydrate();
    await usePromptSourceStore.persist.rehydrate();
    const file = new File([JSON.stringify({ app: "infinite-canvas", version: 1, exportedAt: new Date().toISOString(), config, webdav: store.defaultWebdavSyncConfig, promptSources: { sources: DEFAULT_PROMPT_SOURCES, schedule: { intervalMinutes: 30, lastFetchedAt: "" } } })], "synthetic.json");
    expect(await importAppConfig(file, async () => true)).toEqual({ cancelled: false, warnings: [warnings.channelPlaintextWarning(channel.baseUrl)] });
    expect(store.useConfigStore.getState().config).toEqual(config);
    for (const path of ["../src/components/layout/channel-editor-drawer.tsx", "../src/components/layout/app-config-modal.tsx"]) {
        const source = await Bun.file(new URL(path, import.meta.url)).text();
        expect(source).toContain("channelPlaintextWarning");
        expect(source).toContain('type="warning"');
    }
});

test("remaining authorized canvas generic error sites use the redaction wrapper", async () => {
    for (const path of ["../src/components/canvas/canvas-side-panel.tsx", "../src/pages/canvas/project.tsx"]) {
        const source = await Bun.file(new URL(path, import.meta.url)).text();
        expect(source).not.toContain("console.error(");
        expect(source).toContain('from "@/lib/secret-redaction"');
    }
});
