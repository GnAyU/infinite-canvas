import { afterAll, expect, test } from "bun:test";
import axios from "axios";
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null, setItem: () => {}, removeItem: () => {} } });
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: globalThis.localStorage } });
afterAll(() => { if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow); else Reflect.deleteProperty(globalThis, "window"); });
const { defaultConfig } = await import("../src/stores/use-config-store");
const { pollVideoGenerationTask } = await import("../src/services/api/video");
const { getPluginTemplates } = await import("../src/services/api/model-plugin");
const { runTrustedModelPlugin: runModelPlugin } = await import("./helpers/model-consent");
const key = "SYNTHETIC_MEDIA_CANARY";
const baseUrl = "https://channel.invalid/prefix";
const channel = { ...defaultConfig.channels[0], baseUrl, apiKey: key, apiFormat: "gemini" as const, models: [{ name: "veo", capability: "video" as const }] };
const config = { ...defaultConfig, baseUrl, apiKey: key, apiFormat: "gemini" as const, channels: [channel], model: "default::veo", videoModel: "default::veo" };
const task = { id: "operations/synthetic", provider: "gemini" as const, model: "default::veo" };
const calls: Array<{ url: string; init?: RequestInit }> = [];
let uri = "https://channel.invalid/prefix/media.mp4";
let mediaStatus = 200;
const response = (url: string) => url.includes("predictLongRunning") ? Response.json({ name: task.id }) : url.includes("/operations/") ? Response.json({ done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri } }] } } }) : new Response("synthetic video", { status: mediaStatus, headers: { "Content-Type": "video/mp4" } });
const originalFetch = globalThis.fetch;
const originalAdapter = axios.defaults.adapter;
globalThis.fetch = (async (url, init) => { calls.push({ url: String(url), init }); return response(String(url)); }) as typeof fetch;
axios.defaults.adapter = async (request) => {
    calls.push({ url: request.url || "", init: { headers: request.headers as HeadersInit } });
    const r = response(request.url || "");
    return { data: request.responseType === "blob" ? await r.blob() : await r.json(), status: r.status, statusText: "OK", headers: {}, config: request };
};
afterAll(() => {
    globalThis.fetch = originalFetch;
    axios.defaults.adapter = originalAdapter;
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage); else Reflect.deleteProperty(globalThis, "localStorage");
});

test("native Gemini media rejects provider-returned external origins without a media request", async () => {
    for (uri of ["https://cdn.invalid/video.mp4", "https://storage.googleapis.com/video.mp4", "https://channel.invalid.attacker.invalid/x.mp4", "https://channel.invalid:444/x.mp4", "http://channel.invalid/x.mp4", "//attacker.invalid/x.mp4", "https://user:pass@channel.invalid/x.mp4", `https://channel.invalid/x.mp4?key=${key}`]) {
        calls.length = 0;
        await expect(pollVideoGenerationTask(config, task)).rejects.toThrow();
        expect(calls).toHaveLength(1);
    }
});

test("native and shipped Gemini paths download on-origin media using only Google headers and return a Blob", async () => {
    uri = "https://channel.invalid/prefix/media.mp4";
    mediaStatus = 200;
    for (const native of [true, false]) {
        calls.length = 0;
        const result = native ? (await pollVideoGenerationTask(config, task) as { result: { blob: Blob } }).result.blob : await runModelPlugin({ config, capability: "video", script: getPluginTemplates().video[1].script });
        expect(result).toBeInstanceOf(Blob);
        for (const call of calls) {
            expect(call.url).not.toContain(key);
            expect(call.url).not.toContain("key=");
            expect(call.init?.redirect).toBe("error");
            expect(new Headers(call.init?.headers).get("x-goog-api-key")).toBe(key);
        }
    }
});

test("native Gemini failed-state errors never expose the selected channel canary", async () => {
    const savedFetch = globalThis.fetch;
    globalThis.fetch = (async () => Response.json({ done: true, error: { message: `Authorization: Bearer ${key}; https://channel.invalid/x#token=${key}` } })) as typeof fetch;
    try {
        const state = await pollVideoGenerationTask(config, task);
        expect(state.status).toBe("failed");
        expect(JSON.stringify(state)).not.toContain(key);
    } finally { globalThis.fetch = savedFetch; }
});

test("header-auth failure is explicit and has no URL fallback or query retry", async () => {
    uri = "https://channel.invalid/prefix/media.mp4";
    mediaStatus = 403;
    calls.length = 0;
    await expect(pollVideoGenerationTask(config, task)).rejects.toThrow("请求头认证");
    expect(calls).toHaveLength(2);
    expect(JSON.stringify(calls.map((c) => c.url))).not.toContain(key);
    mediaStatus = 200;
});
