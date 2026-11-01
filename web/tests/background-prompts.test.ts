import { afterAll, expect, test } from "bun:test";
import localforage from "localforage";
import { useBackgroundStore } from "../src/stores/use-background-store";


const oldCreate = localforage.createInstance;
const oldFetch = globalThis.fetch;
const oldStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null, setItem() {}, removeItem() {} } });
const cache = new Map<string, unknown>();
const requests: string[] = [];
let beforeRead: (() => void) | undefined;
localforage.createInstance = (() => ({ getItem: async (key: string) => { beforeRead?.(); return cache.get(key) ?? null; }, setItem: async (key: string, value: unknown) => { cache.set(key, value); return value; } })) as unknown as typeof localforage.createInstance;
globalThis.fetch = (async (url: string | URL | Request) => {
    requests.push(String(url));
    return Response.json([{ id: "synthetic", title: "Synthetic", prompt: "Test", coverUrl: "https://images.invalid/cover.png" }]);
}) as typeof fetch;
afterAll(() => { localforage.createInstance = oldCreate; globalThis.fetch = oldFetch; useBackgroundStore.getState().setConsent("promptFeed", false); if (oldStorage) Object.defineProperty(globalThis, "localStorage", oldStorage); else Reflect.deleteProperty(globalThis, "localStorage"); });

test("prompt cache reads and due ticks cannot fetch without consent; manual refresh stays usable", async () => {
    const api = await import("../src/services/api/prompts");
    const { usePromptSourceStore } = await import("../src/stores/use-prompt-source-store");
    const source = { id: "synthetic", name: "Synthetic", url: "https://feed.invalid/feed.json", homepage: "https://feed.invalid", enabled: true, builtIn: false };
    usePromptSourceStore.setState({ sources: [source], schedule: { intervalMinutes: 30, lastFetchedAt: "" } });
    useBackgroundStore.getState().setConsent("promptFeed", false);
    expect((await api.fetchPrompts()).items).toEqual([]);
    await api.refreshDueSources(0);
    expect(requests).toEqual([]);
    await api.refreshSource(source.id);
    expect(requests).toEqual([source.url]);
    await api.refreshDueSources(0);
    expect(requests).toHaveLength(1);
    useBackgroundStore.getState().setConsent("promptFeed", true);
    await api.refreshDueSources(0);
    expect(requests).toHaveLength(2);
    useBackgroundStore.getState().setConsent("promptFeed", false);
    await api.refreshDueSources(0);
    expect(requests).toHaveLength(2);
    expect((await api.fetchPrompts()).items).toHaveLength(1);
});

test("opt-out while an automatic refresh awaits storage fences the next network request", async () => {
    const api = await import("../src/services/api/prompts");
    const { usePromptSourceStore } = await import("../src/stores/use-prompt-source-store");
    usePromptSourceStore.setState({ sources: [{ id: "race", name: "Race", url: "https://feed.invalid/race.json", homepage: "", enabled: true, builtIn: false }] });
    for (const optOutRead of [1, 2]) {
        let reads = 0;
        const before = requests.length;
        useBackgroundStore.getState().setConsent("promptFeed", true);
        beforeRead = () => { if (++reads === optOutRead) useBackgroundStore.getState().setConsent("promptFeed", false); };
        try {
            await api.refreshDueSources(0);
            expect(reads).toBe(optOutRead);
            expect(requests).toHaveLength(before);
        } finally { beforeRead = undefined; }
    }
});
