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
