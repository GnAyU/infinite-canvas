import { afterAll, expect, test } from "bun:test";
import axios from "axios";
const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const storage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: storage } });
const { defaultConfig } = await import("../src/stores/use-config-store");
const { createVideoGenerationTask, storeGeneratedVideo } = await import("../src/services/api/video");
const { requestGeneration } = await import("../src/services/api/image");
const { requestAudioGeneration } = await import("../src/services/api/audio");
const key = "SYNTHETIC_RETURN_CANARY";
const baseUrl = "https://channel.invalid/prefix";
const configFor = (apiFormat: "openai" | "gemini" = "openai", script?: string) => ({ ...defaultConfig, baseUrl, apiKey: key, apiFormat, model: "default::test", count: "1", channels: [{ ...defaultConfig.channels[0], baseUrl, apiKey: key, apiFormat, models: [{ name: "test", capability: "video" as const, script }] }] });
const originalFetch = globalThis.fetch;
const originalAdapter = axios.defaults.adapter;
let payload: unknown = {};
const calls: string[] = [];
globalThis.fetch = (async (input) => { const url = input instanceof Request ? input.url : String(input); calls.push(url); return Response.json(payload); }) as typeof fetch;
axios.defaults.adapter = async (request) => { calls.push(request.url || ""); return { data: payload, status: 200, statusText: "OK", headers: {}, config: request }; };
afterAll(() => { globalThis.fetch = originalFetch; axios.defaults.adapter = originalAdapter; for (const [name, d] of [["window", windowDescriptor], ["localStorage", storageDescriptor]] as const) { if (d) Object.defineProperty(globalThis, name, d); else Reflect.deleteProperty(globalThis, name); } });

test("provider task identifiers cannot return the selected key into history metadata", async () => {
    for (const format of ["openai", "gemini"] as const) {
        payload = format === "openai" ? { id: `task-${key}` } : { name: `operations/${key}` };
        await expect(createVideoGenerationTask(configFor(format), "synthetic")).rejects.toThrow();
    }
});

test("native and scripted image results reject secret-bearing URLs before persistence", async () => {
    for (const script of [undefined, `return [{ url: baseUrl + '/image.png?other=' + apiKey }];`]) {
        payload = { data: [{ url: `${baseUrl}/image.png?other=${key}` }] };
        await expect(requestGeneration(configFor("openai", script), "synthetic")).rejects.toThrow();
    }
});

test("script audio results reject selected keys and unapproved recipients before a download", async () => {
    for (const url of [`${baseUrl}/audio.mp3?other=${key}`, "https://cdn.invalid/audio.mp3"]) {
        calls.length = 0;
        await expect(requestAudioGeneration(configFor("openai", `return { url: ${JSON.stringify(url)} };`), "synthetic")).rejects.toThrow();
        expect(calls).toHaveLength(0);
    }
});

test("cancellation after a video script returns prevents its media download and task cache", async () => {
    calls.length = 0;
    const controller = new AbortController();
    const script = `await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); return { url: baseUrl + '/media.mp4' };`;
    const task = createVideoGenerationTask(configFor("openai", script), "synthetic", [], { signal: controller.signal });
    setTimeout(() => controller.abort(), 0);
    await expect(task).rejects.toThrow();
    expect(calls).toHaveLength(0);
});

test("direct video storage refuses remote URL bypasses instead of downloading outside channel context", async () => {
    for (const url of [`${baseUrl}/${key}/video.mp4`, `${baseUrl}/video.mp4`]) {
        calls.length = 0;
        await expect(storeGeneratedVideo({ url })).rejects.toThrow();
        expect(calls).toHaveLength(0);
    }
});

test("script video media JSON errors cannot echo a key absent from stored config", async () => {
    payload = { error: { message: `provider echo ${key}` } };
    let message = "";
    try { await createVideoGenerationTask(configFor("openai", `return {url: baseUrl + '/video.mp4'};`), "synthetic"); }
    catch (error) { message = (error as Error).message; }
    expect(message).not.toBe("");
    expect(message).not.toContain(key);
});
