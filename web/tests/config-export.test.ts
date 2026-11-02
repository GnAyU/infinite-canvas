import { afterAll, expect, test } from "bun:test";

const originals = ["window", "localStorage"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
const storage = { getItem: () => null, setItem() {}, removeItem() {} };
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: storage } });
const configFile = await import("../src/services/config-file");
const { defaultConfig, defaultWebdavSyncConfig, useConfigStore } = await import("../src/stores/use-config-store");
afterAll(() => { for (const [key, descriptor] of originals) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); });

test("default v1 config export omits credentials and executable bodies without changing identity", () => {
    useConfigStore.setState({
        config: { ...structuredClone(defaultConfig), apiKey: "synthetic-export-flat", channels: [{ ...defaultConfig.channels[0], apiKey: "synthetic-export-channel", models: [{ name: "gpt-5.5", capability: "text", script: "return 'synthetic-export-executable';" }] }], proxyUrl: "https://proxy.invalid/?token=synthetic-export-proxy" },
        webdav: { ...defaultWebdavSyncConfig, url: "https://synthetic-export-user:synthetic-export-url@dav.invalid/", username: "synthetic-export-username", password: "synthetic-export-password" },
    });
    expect(typeof configFile.createAppConfigExport).toBe("function");
    const exported = configFile.createAppConfigExport();
    expect(exported.app).toBe("infinite-canvas");
    expect(exported.version).toBe(1);
    expect(exported.config.channels[0].id).toBe("default");
    expect(exported.config.channels[0].models[0]).toEqual({ name: "gpt-5.5", capability: "text" });
    expect(JSON.stringify(exported)).not.toContain("synthetic-export-");
    expect(exported.config).not.toHaveProperty("apiKey");
    expect(exported.config.channels[0]).not.toHaveProperty("apiKey");
    expect(exported.webdav).not.toHaveProperty("password");
    expect(JSON.stringify(exported)).not.toContain("[REDACTED]");
    expect(useConfigStore.getState().config.channels[0].apiKey).toBe("synthetic-export-channel");
});

test("safe export preserves identity and user text even when they resemble a credential", () => {
    const channel = { ...structuredClone(defaultConfig.channels[0]), id: "token", name: "Authorization: synthetic-export-channel", apiKey: "synthetic-export-channel", models: [{ name: "synthetic-export-channel", capability: "text" as const }] };
    useConfigStore.setState({ config: { ...structuredClone(defaultConfig), channels: [channel], systemPrompt: "Review synthetic-export-channel before sharing" } });
    const exported = configFile.createAppConfigExport();
    expect(exported.config.channels).toHaveLength(1);
    expect(exported.config.channels[0].id).toBe(channel.id);
    expect(exported.config.channels[0].name).toBe(channel.name);
    expect(exported.config.channels[0].models).toEqual(channel.models);
    expect(exported.config.systemPrompt).toBe(useConfigStore.getState().config.systemPrompt);
});

test("export whitelist omits Agent/proxy tokens and headers while credential-bearing source URLs are omitted", async () => {
    const { usePromptSourceStore } = await import("../src/stores/use-prompt-source-store");
    const { DEFAULT_PROMPT_SOURCES } = await import("../src/services/api/prompt-source-presets");
    const original = usePromptSourceStore.getState();
    useConfigStore.setState({ config: { ...structuredClone(defaultConfig), agentToken: "synthetic-foreign-agent-token", proxyToken: "synthetic-foreign-proxy-token", headers: { Authorization: "Bearer synthetic-export-header" }, channels: [{ ...structuredClone(defaultConfig.channels[0]), headers: { "X-API-Key": "synthetic-channel-header" }, baseUrl: "https://provider.invalid/?%61pi_key=synthetic-unknown-url-key" }] } as never, webdav: { ...defaultWebdavSyncConfig } });
    usePromptSourceStore.setState({ sources: [...structuredClone(DEFAULT_PROMPT_SOURCES), { id: "synthetic-source", name: "Synthetic", url: "https://feed.invalid/?access_token=synthetic-source-url", homepage: "https://user:synthetic-source-password@feed.invalid/", enabled: false, builtIn: false }] });
    try {
        const safe = JSON.stringify(configFile.createAppConfigExport());
        for (const value of ["synthetic-foreign", "synthetic-export-header", "synthetic-channel-header", "synthetic-unknown-url-key", "synthetic-source-url", "synthetic-source-password"]) expect(safe).not.toContain(value);
        expect(safe).not.toContain("[REDACTED]");
        expect(JSON.parse(safe).promptSources.sources.at(-1).id).toBe("synthetic-source");
        expect(JSON.parse(safe).config.channels).toHaveLength(1);
    } finally { usePromptSourceStore.setState({ sources: original.sources, schedule: original.schedule }); }
});

test("safe export structurally omits browser-recognized userinfo from every URL slot", async () => {
    const { usePromptSourceStore } = await import("../src/stores/use-prompt-source-store");
    const original = usePromptSourceStore.getState();
    const userinfo = "synthetic-url-user:synthetic-url-password@feed.invalid/list.json";
    const addresses = [
        `https://${userinfo}`, String.raw`https:\\${userinfo}`, `//${userinfo}`,
        `https:/${userinfo}`, `https:${userinfo}`, String.raw`\\${userinfo}`,
        ` \thttps://synthetic-url-user:synthetic-url-pass\nword@feed.invalid/list.json\r `,
        "https://synthetic-url-user@feed.invalid/list.json",
        "https://%73ynthetic-url-user:%73ynthetic-url-password@feed.invalid/list.json",
    ];
    try {
        for (const address of addresses) {
            let parsed: URL;
            try { parsed = new URL(address); }
            catch { parsed = new URL(address, "https://export.invalid/"); }
            expect(parsed.username).not.toBe("");
            useConfigStore.setState({ config: { ...structuredClone(defaultConfig), baseUrl: address, proxyUrl: address, channels: [{ ...structuredClone(defaultConfig.channels[0]), baseUrl: address }] }, webdav: { ...defaultWebdavSyncConfig, url: address } });
            usePromptSourceStore.setState({ sources: [{ id: "url-source", name: "URL source", url: address, homepage: address, enabled: false, builtIn: false }] });
            const before = JSON.stringify({ config: useConfigStore.getState().config, webdav: useConfigStore.getState().webdav, sources: usePromptSourceStore.getState().sources });
            const serialized = JSON.stringify(configFile.createAppConfigExport());
            const safe = JSON.parse(serialized);
            for (const [owner, field] of [[safe.config, "baseUrl"], [safe.config, "proxyUrl"], [safe.config.channels[0], "baseUrl"], [safe.webdav, "url"], [safe.promptSources.sources[0], "url"], [safe.promptSources.sources[0], "homepage"]] as const) expect(owner).not.toHaveProperty(field);
            expect(serialized).not.toContain("synthetic-url-");
            expect(serialized).not.toContain("[REDACTED]");
            expect(safe.config.channels[0].id).toBe("default");
            expect(safe.promptSources.sources[0].id).toBe("url-source");
            expect(JSON.stringify({ config: useConfigStore.getState().config, webdav: useConfigStore.getState().webdav, sources: usePromptSourceStore.getState().sources })).toBe(before);
            const sensitive = JSON.parse(JSON.stringify(await configFile.createSensitiveAppConfigExport(async () => true)));
            expect(sensitive.config.baseUrl).toBe(address);
            expect(sensitive.config.proxyUrl).toBe(address);
            expect(sensitive.config.channels[0].baseUrl).toBe(address);
            expect(sensitive.webdav.url).toBe(address);
            expect(sensitive.promptSources.sources[0].url).toBe(address);
            expect(sensitive.promptSources.sources[0].homepage).toBe(address);
        }
    } finally { usePromptSourceStore.setState({ sources: original.sources, schedule: original.schedule }); }
});

test("safe export omits browser-normalized query credentials from every URL slot", async () => {
    const { usePromptSourceStore } = await import("../src/stores/use-prompt-source-store");
    const { redactText } = await import("../src/lib/secret-redaction");
    const original = usePromptSourceStore.getState();
    const canary = "synthetic-f2-query-canary";
    const names = ["api\t_key", "%61pi\t_key", "access\ttoken", "x-goog-api-\tkey", "authori\tzation", "pass\tword", "user\tname", "creden\ttial", "api\r_key", "api\n_key"];
    try {
        for (const name of names) {
            const address = `https://feed.invalid/list.json?category=public&${name}=${canary}`;
            expect([...new URL(address).searchParams.keys()]).not.toContain(name);
            useConfigStore.setState({ config: { ...structuredClone(defaultConfig), baseUrl: address, proxyUrl: address, channels: [{ ...structuredClone(defaultConfig.channels[0]), baseUrl: address }] }, webdav: { ...defaultWebdavSyncConfig, url: address } });
            usePromptSourceStore.setState({ sources: [{ id: "f2-query-source", name: "Query source", url: address, homepage: address, enabled: false, builtIn: false }] });
            const before = JSON.stringify({ config: useConfigStore.getState().config, webdav: useConfigStore.getState().webdav, sources: usePromptSourceStore.getState().sources });
            const safe = JSON.parse(JSON.stringify(configFile.createAppConfigExport()));
            for (const [owner, field] of [[safe.config, "baseUrl"], [safe.config, "proxyUrl"], [safe.config.channels[0], "baseUrl"], [safe.webdav, "url"], [safe.promptSources.sources[0], "url"], [safe.promptSources.sources[0], "homepage"]] as const) expect(owner).not.toHaveProperty(field);
            expect(JSON.stringify(safe)).not.toContain(canary);
            expect(JSON.stringify(safe)).not.toContain("[REDACTED]");
            expect(safe.config.channels[0].id).toBe("default");
            expect(safe.promptSources.sources[0].id).toBe("f2-query-source");
            expect(redactText(address)).not.toContain(canary);
            expect(JSON.stringify({ config: useConfigStore.getState().config, webdav: useConfigStore.getState().webdav, sources: usePromptSourceStore.getState().sources })).toBe(before);
            const sensitive = JSON.parse(JSON.stringify(await configFile.createSensitiveAppConfigExport(async () => true)));
            expect([sensitive.config.baseUrl, sensitive.config.proxyUrl, sensitive.config.channels[0].baseUrl, sensitive.webdav.url, sensitive.promptSources.sources[0].url, sensitive.promptSources.sources[0].homepage]).toEqual(Array(6).fill(address));
        }
    } finally { usePromptSourceStore.setState({ sources: original.sources, schedule: original.schedule }); }
});

test("safe export omits browser-normalized fragment credentials from every URL slot", async () => {
    const { usePromptSourceStore } = await import("../src/stores/use-prompt-source-store");
    const original = usePromptSourceStore.getState();
    const canary = "synthetic-f3-fragment-canary";
    const names = ["api\t_key", "%61pi\t_key", "access\ttoken", "x-goog-api-\tkey", "authori\tzation", "pass\tword", "user\tname", "creden\ttial", "api\r_key", "api\n_key", "api_key", "%2561pi_key"];
    try {
        for (const name of names) {
            const address = `https://feed.invalid/list.json#section=public&${name}=${canary}`;
            expect([...new URLSearchParams(new URL(address).hash.slice(1)).keys()].some(key => /[\t\r\n]/.test(key))).toBe(false);
            useConfigStore.setState({ config: { ...structuredClone(defaultConfig), baseUrl: address, proxyUrl: address, channels: [{ ...structuredClone(defaultConfig.channels[0]), baseUrl: address }] }, webdav: { ...defaultWebdavSyncConfig, url: address } });
            usePromptSourceStore.setState({ sources: [{ id: "f3-fragment-source", name: "Fragment source", url: address, homepage: address, enabled: false, builtIn: false }] });
            const before = JSON.stringify({ config: useConfigStore.getState().config, webdav: useConfigStore.getState().webdav, sources: usePromptSourceStore.getState().sources });
            const safe = JSON.parse(JSON.stringify(configFile.createAppConfigExport()));
            for (const [owner, field] of [[safe.config, "baseUrl"], [safe.config, "proxyUrl"], [safe.config.channels[0], "baseUrl"], [safe.webdav, "url"], [safe.promptSources.sources[0], "url"], [safe.promptSources.sources[0], "homepage"]] as const) expect(owner).not.toHaveProperty(field);
            expect(JSON.stringify(safe)).not.toContain(canary);
            expect(JSON.stringify(safe)).not.toContain("[REDACTED]");
            expect(safe.config.channels[0].id).toBe("default");
            expect(safe.promptSources.sources[0].id).toBe("f3-fragment-source");
            expect(JSON.stringify({ config: useConfigStore.getState().config, webdav: useConfigStore.getState().webdav, sources: usePromptSourceStore.getState().sources })).toBe(before);
            const sensitive = JSON.parse(JSON.stringify(await configFile.createSensitiveAppConfigExport(async () => true)));
            expect([sensitive.config.baseUrl, sensitive.config.proxyUrl, sensitive.config.channels[0].baseUrl, sensitive.webdav.url, sensitive.promptSources.sources[0].url, sensitive.promptSources.sources[0].homepage]).toEqual(Array(6).fill(address));
        }
    } finally { usePromptSourceStore.setState({ sources: original.sources, schedule: original.schedule }); }
});

test("safe export preserves credential-free URL bytes and arbitrary text rather than normalizing identities", async () => {
    const { usePromptSourceStore } = await import("../src/stores/use-prompt-source-store");
    const original = usePromptSourceStore.getState();
    const addresses = ["https://feed.invalid/path@label/list.json?view=public#section", String.raw`https:\\feed.invalid/list.json`, "//feed.invalid/list.json", "/relative/list.json", "", "https://feed.invalid/list.json?cate\tgory=public", "https://feed.invalid/list.json?label=api_key", "https://feed.invalid/list.json?api%09_key=public", "https://feed.invalid/list.json#section=public", "https://feed.invalid/list.json#sec\ttion=public", "https://feed.invalid/list.json#label=api_key", "https://feed.invalid/list.json#api%09_key=public"];
    const text = String.raw`Free text https:\\alice:synthetic-free-text@feed.invalid/ needs manual review`;
    try {
        for (const address of addresses) {
            useConfigStore.setState({ config: { ...structuredClone(defaultConfig), baseUrl: address, proxyUrl: address, systemPrompt: text, channels: [{ ...structuredClone(defaultConfig.channels[0]), id: "exact-channel", name: text, baseUrl: address }] }, webdav: { ...defaultWebdavSyncConfig, url: address } });
            usePromptSourceStore.setState({ sources: [{ id: "exact-source", name: text, url: address, homepage: address, enabled: false, builtIn: false }] });
            const safe = JSON.parse(JSON.stringify(configFile.createAppConfigExport()));
            expect([safe.config.baseUrl, safe.config.proxyUrl, safe.config.channels[0].baseUrl, safe.webdav.url, safe.promptSources.sources[0].url, safe.promptSources.sources[0].homepage]).toEqual(Array(6).fill(address));
            expect(safe.config.channels[0].id).toBe("exact-channel");
            expect(safe.promptSources.sources[0].id).toBe("exact-source");
            expect([safe.config.systemPrompt, safe.config.channels[0].name, safe.promptSources.sources[0].name]).toEqual([text, text, text]);
        }
    } finally { usePromptSourceStore.setState({ sources: original.sources, schedule: original.schedule }); }
});

test("sensitive export requires fresh confirmation for every plaintext snapshot", async () => {
    const secret = "synthetic-sensitive-export-canary";
    useConfigStore.setState({ config: { ...structuredClone(defaultConfig), apiKey: secret, channels: [{ ...defaultConfig.channels[0], apiKey: secret, models: [{ name: "gpt-5.5", capability: "text", script: `return '${secret}';` }] }] } });
    let calls = 0;
    const confirm = async (warning: string) => { calls++; expect(warning).toMatch(/明文/); expect(warning).toMatch(/分享/); return calls === 2; };
    expect(await configFile.createSensitiveAppConfigExport(confirm)).toBeNull();
    expect(JSON.stringify(await configFile.createSensitiveAppConfigExport(confirm))).toContain(secret);
    expect(await configFile.createSensitiveAppConfigExport(confirm)).toBeNull();
    expect(calls).toBe(3);
    expect(JSON.stringify(configFile.createAppConfigExport())).not.toContain(secret);
});
