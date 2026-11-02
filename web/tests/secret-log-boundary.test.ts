import { afterAll, expect, test } from "bun:test";
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null, setItem: () => {}, removeItem: () => {} } });
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: globalThis.localStorage } });
afterAll(() => { if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow); else Reflect.deleteProperty(globalThis, "window"); });
const { defaultConfig, defaultWebdavSyncConfig, useConfigStore } = await import("../src/stores/use-config-store");
const { emitCanvasEvent, onCanvasEvent } = await import("../src/lib/canvas/canvas-event-bus");
const { runTrustedModelPlugin: runModelPlugin } = await import("./helpers/model-consent");
const key = "SYNTHETIC_LOG_KEY";
const password = "SYNTHETIC_DAV_PASSWORD";
const username = "SYNTHETIC_DAV_USER";
const token = "SYNTHETIC_QUERY_TOKEN";
const config = { ...defaultConfig, apiKey: key, channels: [{ ...defaultConfig.channels[0], apiKey: key }] };
useConfigStore.setState({ config, webdav: { ...defaultWebdavSyncConfig, username, password } });
afterAll(() => { if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage); else Reflect.deleteProperty(globalThis, "localStorage"); });

test("generic event logging redacts headers, URL queries/fragments, WebDAV credentials and error payloads", () => {
    const output: unknown[] = [];
    const originalError = console.error;
    console.error = (...args) => { output.push(args); };
    const stop = onCanvasEvent("secret-test", () => { throw new Error(JSON.stringify({ headers: { Authorization: `Bearer ${key}`, "x-goog-api-key": key }, webdav: { username, password }, url: `https://u:p@synthetic.invalid/x?token=${token}#apiKey=${token}` })); });
    try { emitCanvasEvent("secret-test"); } finally { console.error = originalError; stop(); }
    const text = JSON.stringify(output);
    for (const secret of [key, username, password, token, "u:p@synthetic"]) expect(text).not.toContain(secret);
    expect(text).toContain("REDACTED");
});

test("URL redaction classifies browser-normalized credentials without configured canaries", async () => {
    const { redactText } = await import("../src/lib/secret-redaction");
    const canary = "synthetic-f2-unconfigured-query";
    const before = JSON.stringify(useConfigStore.getState());
    for (const name of ["api\t_key", "%61pi\t_key", "authori\tzation", "api\r_key", "api\n_key"]) expect(redactText(`https://feed.invalid/?${name}=${canary}`)).not.toContain(canary);
    for (const address of [String.raw`https:\\alice:synthetic-f2-unconfigured-query@feed.invalid/`, `//alice:${canary}@feed.invalid/`]) expect(redactText(address)).not.toContain(canary);
    expect(redactText("https://feed.invalid/path@label?category=public")).toBe("https://feed.invalid/path@label?category=public");
    expect(JSON.stringify(useConfigStore.getState())).toBe(before);
});

test("logError omits normalized fragment secrets from scalar, object and Error messages", async () => {
    const { logError, redactText } = await import("../src/lib/secret-redaction");
    const canary = "synthetic-f3-unconfigured-fragment";
    const before = JSON.stringify(useConfigStore.getState());
    const output: unknown[] = [];
    const originalError = console.error;
    console.error = (...args) => { output.push(args); };
    try {
        for (const name of ["api\t_key", "%61pi\t_key", "authori\tzation", "api\r_key", "api\n_key", "api_key"]) {
            const address = `https://feed.invalid/#${name}=${canary}`;
            const object = { url: address };
            const error = new Error(address);
            logError(address, object, error);
            expect(JSON.stringify(output.at(-1))).not.toContain(canary);
            expect(output.at(-1)).toEqual(["[REDACTED]", { url: "[REDACTED]" }, { name: "Error", message: "[REDACTED]" }]);
            expect(object.url).toBe(address);
            expect(error.message).toBe(address);
        }
        const safe = "https://feed.invalid/#section=public";
        logError(safe, { url: safe }, new Error(safe));
        expect(output.at(-1)).toEqual([safe, { url: safe }, { name: "Error", message: safe }]);
        expect(redactText("https://feed.invalid/#sec\ttion=public")).toBe("https://feed.invalid/#sec\ttion=public");
        expect(JSON.stringify(useConfigStore.getState())).toBe(before);
    } finally { console.error = originalError; }
});

test("plugin error echo cannot persist selected channel key or sensitive URL values", async () => {
    let error = "";
    try { await runModelPlugin({ config, capability: "text", script: `throw new Error(apiKey + ' https://synthetic.invalid/?key=${token}#token=${token}');` }); } catch (e) { error = String(e); }
    expect(error).not.toContain(key);
    expect(error).not.toContain(token);
});
