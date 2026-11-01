import { afterAll, expect, test } from "bun:test";
import axios from "axios";
import { Buffer } from "node:buffer";

const descriptors = ["window", "localStorage", "FileReader"].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
const storage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: storage, setTimeout, clearTimeout } });
const { defaultConfig, defaultWebdavSyncConfig, useConfigStore } = await import("../src/stores/use-config-store");
const { redactText, redactLogValue, logError, logInfo } = await import("../src/lib/secret-redaction");
const { runModelPlugin, getPluginTemplates } = await import("../src/services/api/model-plugin");
const { pollVideoGenerationTask, createVideoGenerationTask } = await import("../src/services/api/video");
const { channelAxios } = await import("../src/services/api/channel-request");
const { requestGeneration } = await import("../src/services/api/image");
const { requestAudioGeneration } = await import("../src/services/api/audio");
Object.defineProperty(globalThis, "FileReader", { configurable: true, value: class {
    result = ""; onload?: () => void;
    async readAsDataURL(blob: Blob) { this.result = `data:${blob.type};base64,${Buffer.from(await blob.arrayBuffer()).toString("base64")}`; this.onload?.(); }
} });
const key = "repair_selected_canary";
const baseUrl = "https://channel.invalid/prefix";
const configFor = (apiFormat: "openai" | "gemini" = "openai", script?: string) => ({
    ...defaultConfig, baseUrl, apiKey: key, apiFormat, model: "default::test", count: "1",
    channels: [{ ...defaultConfig.channels[0], baseUrl, apiKey: key, apiFormat, models: [{ name: "test", capability: "video" as const, script }] }],
});
const task = { id: "operations/test", provider: "gemini" as const, model: "default::test" };
const originalFetch = globalThis.fetch;
const originalAdapter = axios.defaults.adapter;
const calls: Array<{ url: string; init?: RequestInit; request?: Request }> = [];
let respond: (url: string) => Response = () => Response.json({});
globalThis.fetch = (async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const url = request?.url || String(input);
    if (url.startsWith("data:")) return originalFetch(input, init);
    calls.push({ url, init, request });
    return respond(url);
}) as typeof fetch;
axios.defaults.adapter = async (config) => { throw new Error(`Unexpected legacy adapter: ${config.url}`); };
afterAll(() => {
    globalThis.fetch = originalFetch;
    axios.defaults.adapter = originalAdapter;
    for (const [name, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
    }
});

const encoded = (value: string) => `%${value.charCodeAt(0).toString(16)}${value.slice(1)}`;

test("F3 unknown Error.name is never emitted without configured secret context", () => {
    useConfigStore.setState({ config: defaultConfig, webdav: defaultWebdavSyncConfig });
    const canary = "unstored_error_name_canary";
    const before = JSON.stringify(useConfigStore.getState());
    expect(before).not.toContain(canary);
    const error = new Error("safe message"); error.name = canary;
    const output: unknown[] = [], savedError = console.error, savedInfo = console.info;
    console.error = console.info = (...args) => { output.push(args); };
    try {
        logError(error);
        logInfo({ nested: [error] });
    } finally { console.error = savedError; console.info = savedInfo; }
    expect(JSON.stringify(output)).not.toContain(canary);
    expect(redactLogValue(error)).toEqual({ name: "Error", message: "safe message" });
    expect(output).toEqual([[{ name: "Error", message: "safe message" }], [{ nested: [{ name: "Error", message: "safe message" }] }]]);
    for (const name of ["Error", "EvalError", "RangeError", "ReferenceError", "SyntaxError", "TypeError", "URIError", "AggregateError", "AbortError", "TimeoutError"]) {
        const control = new Error("safe message"); control.name = name;
        expect(redactLogValue(control)).toEqual({ name, message: "safe message" });
    }
    expect(JSON.stringify(useConfigStore.getState())).toBe(before);
    expect(error.name).toBe(canary);
});

test("F3 logger sanitizes every emitted field, decoded URL names and WebDAV controls without mutating settings", () => {
    const username = "repair_dav_user", password = "repair_dav_password", unknown = "unknown_query_canary";
    useConfigStore.setState({ config: { ...defaultConfig, apiKey: key }, webdav: { ...defaultWebdavSyncConfig, username, password } });
    const before = JSON.stringify(useConfigStore.getState());
    const output: unknown[] = [], saved = console.error;
    const error = new Error(`provider echo ${encoded(key)}`); error.name = key;
    console.error = (...args) => { output.push(args); };
    try {
        logError(error, { [key]: "ordinary", "%61pi_key": unknown }, `https://channel.invalid/?%61pi_key=prefix%26${unknown}#%74oken=${unknown}`, `https://${username}:${password}@dav.invalid/`, { Authorization: `Basic ${btoa(`${username}:${password}`)}`, "x-goog-api-key": key });
    } finally { console.error = saved; }
    for (const secret of [key, username, password, unknown, btoa(`${username}:${password}`)]) expect(decodeURIComponent(JSON.stringify(output))).not.toContain(secret);
    expect(JSON.stringify(output)).toContain("REDACTED");
    expect(JSON.stringify(useConfigStore.getState())).toBe(before);
    expect(redactText(`provider ${encoded(key)}`, [key])).not.toContain(key);
});

test("F3 native and template errors redact partially encoded selected keys absent from global settings", async () => {
    useConfigStore.setState({ config: defaultConfig, webdav: defaultWebdavSyncConfig });
    respond = () => Response.json({ done: true, error: { message: `provider echo ${encoded(key)}` } });
    const state = await pollVideoGenerationTask(configFor("gemini"), task);
    expect(state.status).toBe("failed");
    expect(decodeURIComponent(JSON.stringify(state))).not.toContain(key);
    let message = "";
    try { await runModelPlugin({ config: configFor(), capability: "text", script: `throw new Error(${JSON.stringify(encoded(key))});` }); }
    catch (error) { message = String(error); }
    expect(message).not.toBe("");
    expect(decodeURIComponent(message)).not.toContain(key);
});

test("F4 final Axios URL mutations reject before any transport including defaults and serializers", async () => {
    respond = () => Response.json({ ok: true });
    for (const options of [
        { params: { key } },
        { baseURL: "https://attacker.invalid", allowAbsoluteUrls: false },
        { params: { benign: true }, paramsSerializer: () => `%61pi_key=${key}` },
    ]) {
        calls.length = 0;
        await expect(channelAxios(configFor(), "models", { headers: { Authorization: `Bearer ${key}` }, ...options })).rejects.toThrow();
        expect(calls).toHaveLength(0);
    }
    const saved = { params: axios.defaults.params, baseURL: axios.defaults.baseURL, allowAbsoluteUrls: axios.defaults.allowAbsoluteUrls, paramsSerializer: axios.defaults.paramsSerializer };
    try {
        for (const defaults of [{ ...saved, params: { token: key } }, { ...saved, baseURL: "https://attacker.invalid", allowAbsoluteUrls: false }, { ...saved, params: { harmless: 1 }, paramsSerializer: () => `other=${key}` }]) {
            Object.assign(axios.defaults, defaults);
            calls.length = 0;
            await expect(channelAxios(configFor(), "models", { headers: { Authorization: `Bearer ${key}` } })).rejects.toThrow();
            expect(calls).toHaveLength(0);
        }
    } finally { Object.assign(axios.defaults, saved); }
});

test("F4 valid Axios params, FormData and response streams retain auth and redirect semantics", async () => {
    calls.length = 0;
    respond = () => new Response("stream control");
    const form = new FormData(); form.set("prompt", "synthetic");
    const response = await channelAxios<ReadableStream>(configFor(), "models", { method: "POST", data: form, params: { page: 2 }, timeout: 1000, responseType: "stream", headers: { Authorization: `Bearer ${key}`, "Content-Type": "multipart/form-data" } });
    expect(await new Response(response.data).text()).toBe("stream control");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${baseUrl}/v1/models?page=2`);
    expect(calls[0].request?.headers.get("Authorization")).toBe(`Bearer ${key}`);
    expect(calls[0].request?.headers.get("Content-Type")).toContain("multipart/form-data; boundary=");
    expect(calls[0].init?.redirect).toBe("error");
    expect(calls[0].init?.credentials).toBe("omit");
    const controller = new AbortController(); controller.abort(); calls.length = 0;
    await expect(channelAxios(configFor(), "models", { signal: controller.signal })).rejects.toThrow();
    expect(calls).toHaveLength(0);
});

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3S8AAAAASUVORK5CYII=";
const mediaReply = (body: string, type: string) => (url: string) => url.includes("predictLongRunning") ? Response.json({ name: task.id }) : url.includes("/operations/") ? Response.json({ done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: `${baseUrl}/media.mp4` } }] } } }) : new Response(body, { headers: { "Content-Type": type } });

test("F1 native and shipped-template video reject HTTP-200 JSON/HTML/text media before caching a task", async () => {
    for (const [body, type] of [[JSON.stringify({ error: { message: `echo ${key}` } }), "application/json"], [`<html>authentication unsupported ${key}</html>`, "text/html"], [`authentication unsupported ${key}`, "text/plain"], [JSON.stringify({ error: { message: `echo ${key}` } }), "video/mp4"]]) {
        respond = mediaReply(body, type);
        for (const run of [() => pollVideoGenerationTask(configFor("gemini"), task), () => createVideoGenerationTask(configFor("gemini", getPluginTemplates().video[1].script), "synthetic")]) {
            calls.length = 0; let error = "";
            try { await run(); } catch (e) { error = String(e); }
            expect(error).not.toBe(""); expect(error).not.toContain(key);
            expect(calls.length).toBeLessThanOrEqual(3);
            expect(calls.every((call) => !call.url.includes(key))).toBe(true);
        }
    }
});

test("F1 direct Blob, record.blob, inline and URL script audio/video reject error payloads", async () => {
    const errorBody = JSON.stringify({ error: { message: `echo ${key}` } });
    for (const kind of ["audio", "video"] as const) {
        for (const source of [
            `new Blob([${JSON.stringify(errorBody)}], {type:'application/json'})`,
            `{blob:new Blob([${JSON.stringify(errorBody)}], {type:'${kind}/mpeg'})}`,
            JSON.stringify(`data:${kind}/mpeg;base64,${btoa(errorBody)}`),
            `{url:baseUrl+'/media.mp4'}`,
        ]) {
            respond = () => new Response(errorBody, { headers: { "Content-Type": "text/html" } });
            const config = configFor("openai", `return ${source};`);
            const run = kind === "audio" ? requestAudioGeneration(config, "synthetic") : createVideoGenerationTask(config, "synthetic");
            await expect(run).rejects.toThrow();
        }
    }
});

test("F1 image downloads reject known error envelopes even with image MIME", async () => {
    for (const type of ["application/json", "text/html", "image/png"]) {
        respond = (url) => url.includes("/images/") ? Response.json({ data: [{ url: `${baseUrl}/error.png` }] }) : new Response(JSON.stringify({ error: { message: `echo ${key}` } }), { headers: { "Content-Type": type } });
        await expect(requestGeneration(configFor(), "synthetic")).rejects.toThrow();
    }
});

test("F2 native OpenAI, Gemini inline/fileData and script image MIME metadata normalize before returning valid PNG", async () => {
    const source = `data:image/png;name=${key};base64,${png}`;
    for (const format of ["openai", "gemini"] as const) {
        for (const route of ["inline", "remote", "fileData", "script", "blob"] as const) {
            const script = route === "script" ? `return ${JSON.stringify(source)};` : route === "blob" ? `return {blob:await (await fetch(${JSON.stringify(source)})).blob()};` : undefined;
            respond = (url) => url.endsWith("/image.png") ? new Response(Buffer.from(png, "base64"), { headers: { "Content-Type": `image/png;name=${key}` } }) : Response.json(format === "openai" ? { data: [{ url: route === "remote" ? `${baseUrl}/image.png` : source }] } : { candidates: [{ content: { parts: [route === "remote" || route === "fileData" ? { fileData: { fileUri: route === "remote" ? `${baseUrl}/image.png` : source, mimeType: `image/png;name=${key}` } } : { inlineData: { data: png, mimeType: `image/png;name=${key}` } }] } }] });
            const images = await requestGeneration(configFor(format, script), "synthetic");
            expect(images).toHaveLength(1);
            expect(images[0].dataUrl).toBe(`data:image/png;base64,${png}`);
            expect(JSON.stringify(images)).not.toContain(key);
        }
    }
});

test("F1 valid native/template/Blob audio and video controls preserve media and canonical MIME", async () => {
    respond = mediaReply("synthetic video control", `video/mp4;name=${key}`);
    const state = await pollVideoGenerationTask(configFor("gemini"), task);
    expect(state.status).toBe("completed");
    if (state.status === "completed") expect(state.result.blob?.type).toBe("video/mp4");
    const created = await createVideoGenerationTask(configFor("gemini", getPluginTemplates().video[1].script), "synthetic");
    expect((await pollVideoGenerationTask(configFor("gemini"), created)).status).toBe("completed");
    for (const script of [undefined, `return new Blob(['synthetic audio control'], {type:'audio/mpeg;name='+apiKey});`, `return {blob:new Blob(['synthetic audio control'],{type:'audio/mpeg;name='+apiKey})};`]) {
        respond = () => new Response("synthetic audio control", { headers: { "Content-Type": `audio/mpeg;name=${key}` } });
        const blob = await requestAudioGeneration(configFor("openai", script), "synthetic");
        expect(blob.type).toBe("audio/mpeg"); expect(await blob.text()).toBe("synthetic audio control");
    }
});

test("valid local inline and octet-stream media keep format without URL authentication or network", async () => {
    for (const kind of ["audio", "video"] as const) {
        for (const source of [`new Blob(['local media control'],{type:'application/octet-stream'})`, JSON.stringify(`data:${kind}/${kind === "audio" ? "mpeg" : "mp4"};name=${key};base64,${btoa("local media control")}`)]) {
            calls.length = 0;
            const config = configFor("openai", `return ${source};`);
            const result = kind === "audio" ? await requestAudioGeneration(config, "synthetic") : await pollVideoGenerationTask(config, await createVideoGenerationTask(config, "synthetic"));
            expect(result instanceof Blob ? result.type : result.status).toBe(kind === "audio" ? "audio/mpeg" : "completed");
            expect(calls).toHaveLength(0);
        }
    }
});
