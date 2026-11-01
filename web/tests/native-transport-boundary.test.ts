import { afterAll, expect, test } from "bun:test";
import axios from "axios";

const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
const storage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: storage, setTimeout, clearTimeout } });
const { defaultConfig } = await import("../src/stores/use-config-store");
const { fetchImageModels, requestGeneration, requestEdit, requestImageQuestion } = await import("../src/services/api/image");
const { requestAudioGeneration } = await import("../src/services/api/audio");
const { testWebdavConnection, uploadWebdavFile, downloadWebdavFile } = await import("../src/services/webdav-sync");
const key = "SYNTHETIC_NATIVE_CANARY";
const baseUrl = "https://channel.invalid/gateway";
const configFor = (apiFormat: "openai" | "gemini" = "openai", url = baseUrl) => ({
    ...defaultConfig, baseUrl: url, apiKey: key, apiFormat, model: "default::test-model", count: "1",
    channels: [{ ...defaultConfig.channels[0], baseUrl: url, apiKey: key, apiFormat, models: [{ name: "test-model", capability: "image" as const }] }],
});
const calls: Array<{ url: string; method: string; redirect?: string; headers: Headers; body?: unknown }> = [];
const originalFetch = globalThis.fetch;
const originalAdapter = axios.defaults.adapter;
let status = 200;
let payload: unknown = {};
let body = "";
function respond(url: string) {
    if (status !== 200) return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
    if (url.includes("/audio/speech")) return new Response("synthetic audio", { headers: { "Content-Type": "audio/mpeg" } });
    if (url.includes("streamGenerateContent")) return new Response('data: {"candidates":[{"content":{"parts":[{"text":"synthetic answer"}]}}]}\n\n');
    if (url.endsWith("/responses")) return new Response('data: {"type":"response.output_text.delta","delta":"synthetic answer"}\n\n');
    if (url.includes("generateContent")) return Response.json({ candidates: [{ content: { parts: [{ inlineData: { data: "c3ludGhldGlj", mimeType: "image/png" } }] } }] });
    if (url.endsWith("/models")) return Response.json({ data: [{ id: "test-model" }], models: [{ name: "models/test-model" }] });
    if (url.includes("/images/")) return Response.json({ data: [{ b64_json: "c3ludGhldGlj" }] });
    return new Response(body || "synthetic file");
}
globalThis.fetch = (async (input, init) => {
    const request = input instanceof Request ? input : null;
    const url = request?.url || String(input);
    calls.push({ url, method: init?.method || request?.method || "GET", redirect: init?.redirect || request?.redirect, headers: new Headers(init?.headers || request?.headers), body: init?.body || request?.body });
    return respond(url);
}) as typeof fetch;
axios.defaults.adapter = async (request) => {
    calls.push({ url: request.url || "", method: request.method || "get", headers: new Headers(request.headers as Record<string, string>), body: request.data });
    const response = respond(request.url || "");
    return { data: request.responseType === "blob" ? await response.blob() : await response.json(), status: response.status, statusText: "OK", headers: {}, config: request };
};
afterAll(() => {
    globalThis.fetch = originalFetch;
    axios.defaults.adapter = originalAdapter;
    for (const [name, descriptor] of [["window", windowDescriptor], ["localStorage", storageDescriptor]] as const) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
    }
});

test("native discovery refuses redirects at transport instead of browser XHR", async () => {
    calls.length = 0;
    expect(await fetchImageModels(configFor())).toEqual(["test-model"]);
    expect(calls).toHaveLength(1);
    expect(calls[0].redirect).toBe("error");
    expect(calls[0].url).toBe(`${baseUrl}/v1/models`);
    expect(calls[0].headers.get("Authorization")).toBe(`Bearer ${key}`);
});

test("native authenticated image, FormData, streaming, Gemini and audio preserve direct-provider controls", async () => {
    calls.length = 0;
    const openai = configFor();
    expect(await requestGeneration(openai, "synthetic")).toHaveLength(1);
    expect(await requestEdit(openai, "synthetic", [])).toHaveLength(1);
    expect(await requestImageQuestion(openai, [], () => {})).toBe("synthetic answer");
    const gemini = configFor("gemini");
    expect(await fetchImageModels(gemini)).toEqual(["test-model"]);
    expect(await requestGeneration(gemini, "synthetic")).toHaveLength(1);
    expect(await requestImageQuestion(gemini, [], () => {})).toBe("synthetic answer");
    expect(await requestAudioGeneration(openai, "synthetic")).toBeInstanceOf(Blob);
    expect(calls).toHaveLength(7);
    for (const call of calls) {
        expect(call.redirect).toBe("error");
        expect(call.url).not.toContain(key);
        expect(call.headers.get(call.url.includes("v1beta") ? "x-goog-api-key" : "Authorization")).toBe(call.url.includes("v1beta") ? key : `Bearer ${key}`);
    }
});

test("malformed native recipients are rejected before fetch or Axios", async () => {
    for (const url of ["https://u:p@channel.invalid", "https:/channel.invalid", "https://[broken", "file:///secret", `https://channel.invalid?key=${key}`, "//attacker.invalid"]) {
        calls.length = 0;
        await expect(fetchImageModels(configFor("openai", url))).rejects.toThrow();
        expect(calls).toHaveLength(0);
    }
});

test("manual HTTPS WebDAV keeps Basic headers, directory methods and Blob downloads without redirects", async () => {
    calls.length = 0;
    const config = { url: "https://dav.invalid/root", username: "SYNTHETIC_DAV_USER", password: "SYNTHETIC_DAV_PASSWORD", directory: "boundary-test", lastSyncedAt: "" };
    await testWebdavConnection(config);
    await uploadWebdavFile(config, "nested/file.json", new Blob(["synthetic"]));
    expect(await downloadWebdavFile(config, "nested/file.json")).toBeInstanceOf(Blob);
    expect(calls.map((call) => call.method)).toEqual(["MKCOL", "PROPFIND", "MKCOL", "MKCOL", "PUT", "GET"]);
    for (const call of calls) {
        expect(call.redirect).toBe("error");
        expect(call.headers.get("Authorization")).toBe(`Basic ${btoa(`${config.username}:${config.password}`)}`);
        expect(call.url).not.toContain(config.username);
        expect(call.url).not.toContain(config.password);
    }
    for (const url of ["http://dav.invalid", "https://u:p@dav.invalid", "https:/dav.invalid", `https://dav.invalid/?password=${config.password}`]) {
        calls.length = 0;
        await expect(testWebdavConnection({ ...config, url })).rejects.toThrow();
        expect(calls).toHaveLength(0);
    }
});
