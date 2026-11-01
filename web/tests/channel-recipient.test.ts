import { afterAll, expect, test } from "bun:test";
import axios from "axios";
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null, setItem: () => {}, removeItem: () => {} } });
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: globalThis.localStorage } });
afterAll(() => { if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow); else Reflect.deleteProperty(globalThis, "window"); });
const { runModelPlugin } = await import("../src/services/api/model-plugin");
const { defaultConfig } = await import("../src/stores/use-config-store");
const originalAdapter = axios.defaults.adapter;
axios.defaults.adapter = async (request) => {
    calls.push({ url: request.url || "", init: { headers: request.headers as HeadersInit } });
    return { data: { ok: true }, status: 200, statusText: "OK", headers: {}, config: request };
};
afterAll(() => { axios.defaults.adapter = originalAdapter; if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage); else Reflect.deleteProperty(globalThis, "localStorage"); });
const originalFetch = globalThis.fetch;
const calls: Array<{ url: string; init?: RequestInit }> = [];
const config = { ...defaultConfig, baseUrl: "https://channel.invalid/gateway", apiKey: "SYNTHETIC_RECIPIENT_CANARY" };
globalThis.fetch = (async (url, init) => { calls.push({ url: String(url), init }); return Response.json({ ok: true }); }) as typeof fetch;
afterAll(() => { globalThis.fetch = originalFetch; });
const run = (path: string, method = "get", baseUrl = config.baseUrl) => runModelPlugin({ config: { ...config, baseUrl }, capability: "text", script: `return await http.${method}(${JSON.stringify(path)});` });

test("helper rejects off-origin and ambiguous recipients before transport", async () => {
    for (const url of ["https://attacker.invalid/x", "//attacker.invalid/x", "https://channel.invalid.attacker.invalid/x", "https://channel.invalid:444/x", "http://channel.invalid/x", "https://u:p@channel.invalid/x", "https://@channel.invalid/x", "https:/channel.invalid/x", "https://[broken", "data:text/plain,no", "file:///secret", "\\\\attacker.invalid/x", "https://channel.invalid/x?key=CANARY", "https://channel.invalid/x#token=CANARY"]) {
        calls.length = 0;
        await expect(run(url)).rejects.toThrow();
        expect(calls).toHaveLength(0);
    }
});

test("helper rejects encoded secrets and malformed authority before transport for GET, POST and raw request", async () => {
    for (const method of ["get", "post", "raw"]) {
        for (const path of ["https:///channel.invalid/x", `https://channel.invalid/x?opaque=%53${config.apiKey.slice(1)}`, "https://channel.invalid/x%ZZ", "//attacker.invalid/x", "http://channel.invalid/x", "https://user@channel.invalid/x", "https://channel.invalid:444/x"]) {
            calls.length = 0;
            const script = method === "raw" ? `return request({ url: ${JSON.stringify(path)}, headers: { Authorization: 'Bearer ' + apiKey } });` : `return http.${method}(${JSON.stringify(path)});`;
            await expect(runModelPlugin({ config, capability: "text", script })).rejects.toThrow();
            expect(calls).toHaveLength(0);
        }
    }
    for (const baseUrl of ["https:///channel.invalid", "https://u:p@channel.invalid", "https://channel.invalid?foo=bar", "https://[broken", "javascript:alert(1)"]) {
        calls.length = 0;
        await expect(run("models", "post", baseUrl)).rejects.toThrow();
        expect(calls).toHaveLength(0);
    }
    for (const name of ["api_key", "x-goog-api-key", "authorization"]) {
        calls.length = 0;
        await expect(runModelPlugin({ config, capability: "text", script: `return request({ url: "models", params: { ${JSON.stringify(name)}: apiKey } });` })).rejects.toThrow();
        expect(calls).toHaveLength(0);
    }
});

test("helper preserves configured prefixes and exact default ports with header-only auth", async () => {
    calls.length = 0;
    for (const path of ["models", "/models", "https://channel.invalid:443/absolute"]) await run(path);
    expect(calls.map((c) => c.url)).toEqual(["https://channel.invalid/gateway/v1/models", "https://channel.invalid/gateway/v1/models", "https://channel.invalid/absolute"]);
    for (const call of calls) {
        expect(new Headers(call.init?.headers).get("Authorization")).toBe(`Bearer ${config.apiKey}`);
        expect(call.init?.redirect).toBe("error");
        expect(call.url).not.toContain(config.apiKey);
    }
    await run("/models", "get", "http://configured-http.invalid/prefix");
    expect(calls.at(-1)?.url).toBe("http://configured-http.invalid/prefix/v1/models");
});
