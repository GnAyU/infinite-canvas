import { assertBootstrapRecipient, assertLegacySecretEdits, defaultConfig, hydrateConfigData, prepareImportedSecretPolicy, useConfigStore, type AiConfig, type WebdavSyncConfig } from "@/stores/use-config-store";
import { DEFAULT_PROMPT_SOURCES, createPromptSource, type PromptSource } from "@/services/api/prompt-source-presets";
import { PROMPT_SOURCE_INTERVALS, usePromptSourceStore, type PromptSourceSchedule } from "@/stores/use-prompt-source-store";
import { create } from "zustand";
import { revokeExecutable } from "@/lib/executable-trust";

type RecordValue = Record<string, unknown>;
type ImportedConfig = Omit<AiConfig, "apiKey" | "channels"> & { apiKey?: string; channels: Array<Omit<AiConfig["channels"][number], "apiKey"> & { apiKey?: string }> };
export type ConfigImport = { config: ImportedConfig; webdav: Omit<WebdavSyncConfig, "username" | "password"> & { username?: string; password?: string }; promptSources: { sources: PromptSource[]; schedule: PromptSourceSchedule } };
const invalid = () => { throw new Error("配置文件无效，或身份/设置无法在重载后原样保留；未应用配置。"); };
function record(value: unknown): RecordValue {
    if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
    return value as RecordValue;
}
function text(value: unknown) { if (typeof value !== "string") return invalid(); return value; }
function boolean(value: unknown) { if (typeof value !== "boolean") return invalid(); return value; }
function array(value: unknown) { if (!Array.isArray(value)) return invalid(); return value as unknown[]; }
function oneOf<T extends string>(value: unknown, values: readonly T[]): T { if (!values.includes(value as T)) return invalid(); return value as T; }
function identity(value: unknown) { const id = text(value); if (!id || id !== id.trim()) return invalid(); return id; }
function secret(source: RecordValue, key: string) { return Object.hasOwn(source, key) ? { [key]: text(source[key]) } : {}; }
function unique(values: string[]) { if (new Set(values).size !== values.length) invalid(); }
/** Compare JSON data without relying on property insertion order. No payload enters error/log text. */
export function sameConfigData(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, index) => sameConfigData(item, b[index]));
    if (!a || !b || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) || Array.isArray(b)) return false;
    const x = a as RecordValue, y = b as RecordValue;
    const keys = Object.keys(x).filter(key => x[key] !== undefined);
    return keys.length === Object.keys(y).filter(key => y[key] !== undefined).length && keys.every(key => Object.hasOwn(y, key) && sameConfigData(x[key], y[key]));
}
function withoutSecrets(config: ImportedConfig | AiConfig) {
    const { apiKey: _key, ...rest } = config;
    return { ...rest, channels: config.channels.map(({ apiKey: _secret, ...channel }) => channel) };
}

/** v1 whitelist only. Unknown trust/enable/remember flags are deliberately not admitted. */
export function validateConfigImport(value: unknown): ConfigImport {
    const root = record(value);
    if (root.app !== "infinite-canvas" || root.version !== 1) invalid();
    text(root.exportedAt);
    const raw = record(root.config);
    const dav = record(root.webdav);
    const prompts = record(root.promptSources);
    // Report every omitted address without echoing untrusted names, IDs or credential-bearing URLs.
    const addresses: Array<[RecordValue, string, string]> = [
        [raw, "baseUrl", "config.baseUrl"], [raw, "proxyUrl", "config.proxyUrl"],
        ...array(raw.channels).map((value, index): [RecordValue, string, string] => [record(value), "baseUrl", `config.channels[${index}].baseUrl`]),
        [dav, "url", "webdav.url"], [dav, "directory", "webdav.directory"],
        ...array(prompts.sources).flatMap((value, index): Array<[RecordValue, string, string]> => [[record(value), "url", `promptSources.sources[${index}].url`], [record(value), "homepage", `promptSources.sources[${index}].homepage`]]),
    ];
    const missing = addresses.filter(([source, key]) => !Object.hasOwn(source, key)).map(([, , path]) => path);
    if (missing.length) throw new Error(`缺少必填地址字段：${missing.join("、")}。已拒绝整个文件，未应用任何配置；请重新导出包含地址字段的版本，或手动重新配置对应渠道/来源。`);
    const config = Object.fromEntries(Object.entries(defaultConfig).filter(([key]) => !["apiKey", "channels"].includes(key)).map(([key, fallback]) => [key, typeof fallback === "string" ? text(raw[key]) : typeof fallback === "boolean" ? boolean(raw[key]) : array(raw[key]).map(text)])) as Omit<AiConfig, "apiKey" | "channels">;
    config.channelMode = oneOf(raw.channelMode, ["local"]);
    config.apiFormat = oneOf(raw.apiFormat, ["openai", "gemini"]);
    config.reasoningEffort = oneOf(raw.reasoningEffort, ["auto", "low", "medium", "high", "xhigh"]);
    config.nodeRegenerateBehavior = oneOf(raw.nodeRegenerateBehavior, ["new-node", "overwrite"]);
    const channels = array(raw.channels).map(value => {
        const channel = record(value);
        const models = array(channel.models).map(value => {
            const model = record(value);
            return { name: identity(model.name), capability: oneOf(model.capability, ["image", "video", "text", "audio"] as const), ...(Object.hasOwn(model, "script") ? { script: text(model.script) } : {}) };
        });
        unique(models.map(model => model.name));
        const id = identity(channel.id);
        if (id.includes("::")) invalid();
        return { id, name: text(channel.name), baseUrl: text(channel.baseUrl), apiFormat: oneOf(channel.apiFormat, ["openai", "gemini"] as const), models, ...secret(channel, "apiKey") };
    });
    unique(channels.map(channel => channel.id));
    const importedConfig = { ...config, ...secret(raw, "apiKey"), channels };
    // Use the actual pure hydration rules, not production persist.rehydrate(). Intentional secret omission is excluded.
    const hydrated = hydrateConfigData({ config: importedConfig as AiConfig });
    if (!sameConfigData(withoutSecrets(importedConfig), withoutSecrets(hydrated.config))) invalid();
    const webdav = { url: text(dav.url), directory: text(dav.directory), lastSyncedAt: text(dav.lastSyncedAt), ...secret(dav, "username"), ...secret(dav, "password") };
    const sources = array(prompts.sources).map(value => {
        const source = record(value);
        return { id: identity(source.id), name: text(source.name), url: text(source.url), homepage: text(source.homepage), enabled: boolean(source.enabled), builtIn: boolean(source.builtIn) };
    });
    unique(sources.map(source => source.id));
    const rebuilt = [...DEFAULT_PROMPT_SOURCES.map(source => ({ ...source, enabled: sources.find(item => item.id === source.id)?.enabled ?? source.enabled })), ...sources.filter(source => !source.builtIn).map(createPromptSource)];
    if (!sameConfigData(sources, rebuilt)) invalid();
    const rawSchedule = record(prompts.schedule);
    if (typeof rawSchedule.intervalMinutes !== "number" || !PROMPT_SOURCE_INTERVALS.includes(rawSchedule.intervalMinutes)) invalid();
    const schedule = { intervalMinutes: rawSchedule.intervalMinutes as number, lastFetchedAt: text(rawSchedule.lastFetchedAt) };
    return { config: importedConfig, webdav, promptSources: { sources, schedule } };
}

/** Call only from the final current snapshot after all reads/confirmation awaits. No side maps are mutated. */
export function prepareConfigImport(data: ConfigImport, current: { config: AiConfig; webdav: WebdavSyncConfig }) {
    const config: AiConfig = {
        ...data.config,
        apiKey: data.config.apiKey ?? (data.config.baseUrl === current.config.baseUrl && data.config.apiFormat === current.config.apiFormat ? current.config.apiKey : ""),
        channels: data.config.channels.map(channel => {
            const existing = current.config.channels.find(item => item.id === channel.id && item.baseUrl === channel.baseUrl && item.apiFormat === channel.apiFormat);
            return { ...channel, apiKey: channel.apiKey ?? existing?.apiKey ?? "" };
        }),
    };
    const sameDav = data.webdav.url === current.webdav.url && data.webdav.directory === current.webdav.directory;
    const webdav = { ...data.webdav, username: data.webdav.username ?? (sameDav ? current.webdav.username : ""), password: data.webdav.password ?? (sameDav ? current.webdav.password : "") };
    assertLegacySecretEdits(config, webdav, true);
    config.channels.forEach(assertBootstrapRecipient);
    return { config, webdav };
}

export const CONFIG_IMPORT_WARNING = "替换渠道、偏好、WebDAV 与提示词来源设置？导入凭据默认仅供本页使用，不授予脚本信任或后台联网同意。此操作尽力而为，不是跨存储事务：其他标签页可能覆盖更新，两次读取不是联合快照；应用或补偿期间关闭页面可能留下混合状态。建议先关闭其他标签页。重新导入只是重试，不能保证恢复已清除或仅会话的凭据，也不能撤销订阅方已触发的请求或代码副作用。";

export class ConfigImportFailure extends Error {
    constructor(readonly restoration: "verified" | "incomplete", readonly reason: "apply" | "unverified" | "divergence", readonly compensationAttempts: number, readonly recovery: unknown) {
        super(`${restoration === "verified" ? "导入失败，恢复已核验。" : "导入失败，恢复不完整/无法核验。"}${reason === "divergence" ? "存储在预期导入序列之外发生变化，可能有其他标签页活动；已停止覆盖式恢复。" : reason === "unverified" ? "存储读取无法核验；已停止覆盖式恢复。" : ""}${compensationAttempts ? "此前已尝试部分补偿。" : "未尝试覆盖式恢复。"}恢复输入仅保留在本页内存，请勿关闭页面；请检查设置，建议关闭其他标签页后重新选择配置重试。重试不是旧字节恢复保证。`);
    }
}
// Not persisted: reporting/closing recovery UI must never write the affected stores.
export const useConfigImportRecovery = create<{ failure: ConfigImportFailure | null }>(() => ({ failure: null }));

/** All awaits precede this function. Sequential observations are deliberately not a joint snapshot/CAS. */
export function applyConfigImport(data: ConfigImport) {
    const configOptions = useConfigStore.persist?.getOptions();
    const promptOptions = usePromptSourceStore.persist?.getOptions();
    if (!configOptions?.storage || !promptOptions?.storage || !configOptions.name || !promptOptions.name || !useConfigStore.persist.hasHydrated() || !usePromptSourceStore.persist.hasHydrated() || configOptions.version !== 0 || promptOptions.version !== 0) throw new Error("存储不可用或未成功完成水合；未应用配置。");
    const storage = window.localStorage;
    const read = (key: string) => { const raw = storage.getItem(key); if (raw !== null && typeof raw !== "string") throw new Error("存储不可读"); return raw; };
    // Read both exact before-images, including absence, before any mutation.
    const rawConfig = read(configOptions.name);
    const rawPrompt = read(promptOptions.name);
    if (!sameConfigData(configOptions.storage.getItem(configOptions.name), rawConfig === null ? null : JSON.parse(rawConfig)) || !sameConfigData(promptOptions.storage.getItem(promptOptions.name), rawPrompt === null ? null : JSON.parse(rawPrompt))) throw new Error("同步持久存储无法核验；未应用配置。");
    const state = useConfigStore.getState();
    const prompts = usePromptSourceStore.getState();
    const before = structuredClone({ config: state.config, webdav: state.webdav });
    const beforePrompts = structuredClone({ sources: prompts.sources, schedule: prompts.schedule });
    const candidate = prepareConfigImport(data, before);
    const nextPrompts = structuredClone(data.promptSources);
    const supplied = new Map<string, string[]>([
        ["flat", Object.hasOwn(data.config, "apiKey") ? ["apiKey"] : []],
        ...data.config.channels.map(channel => [`channel:${channel.id}`, Object.hasOwn(channel, "apiKey") ? ["apiKey"] : []] as [string, string[]]),
        ["webdav", ["username", "password"].filter(key => Object.hasOwn(data.webdav, key))],
    ]);
    const secretPolicy = prepareImportedSecretPolicy(candidate.config, candidate.webdav, supplied);
    type Lane = { key: string; raw: string | null; nextRaw: string; before: unknown; next: unknown; live: () => unknown; set: (value: unknown) => void; project: (value: unknown) => unknown; allowed: Set<string | null> };
    const lanes: Lane[] = [
        { key: configOptions.name, raw: rawConfig, nextRaw: JSON.stringify({ state: secretPolicy.project(), version: 0 }), before, next: candidate, live: () => { const { config, webdav } = useConfigStore.getState(); return { config, webdav }; }, set: value => { if (value === candidate) { revokeExecutable("model"); secretPolicy.apply(); } else secretPolicy.restore(); useConfigStore.setState(value as typeof before); }, project: value => secretPolicy.projectBefore(value as typeof before), allowed: new Set([rawConfig]) },
        { key: promptOptions.name, raw: rawPrompt, nextRaw: JSON.stringify({ state: promptOptions.partialize!({ ...prompts, ...nextPrompts }), version: 0 }), before: beforePrompts, next: nextPrompts, live: () => { const { sources, schedule } = usePromptSourceStore.getState(); return { sources, schedule }; }, set: value => usePromptSourceStore.setState(value as typeof beforePrompts), project: value => promptOptions.partialize!({ ...usePromptSourceStore.getState(), ...value as typeof beforePrompts }), allowed: new Set([rawPrompt]) },
    ];
    let reason: "apply" | "unverified" | "divergence" = "apply";
    const known = () => {
        for (const lane of lanes) {
            let raw: string | null;
            try { raw = read(lane.key); } catch { reason = "unverified"; return false; }
            if (!lane.allowed.has(raw)) { reason = "divergence"; return false; }
        }
        return true;
    };
    let compensationAttempts = 0;
    try {
        for (const lane of lanes) {
            if (!known()) throw new Error();
            lane.allowed.add(lane.nextRaw); // A throwing write may leave either prior or attempted bytes.
            lane.set(lane.next);
            lane.allowed = new Set([lane.nextRaw]);
            if (!known() || !sameConfigData(lane.live(), lane.next)) throw new Error();
        }
        if (!known() || lanes.some(lane => !sameConfigData(lane.live(), lane.next))) throw new Error();
        useConfigImportRecovery.setState({ failure: null });
        return;
    } catch {
        // C1: no persist-wrapped setter, even a "memory restore", after observed divergence/read uncertainty.
        if (reason === "apply" && known()) {
            for (const lane of lanes) {
                if (!known()) break;
                compensationAttempts++;
                const restoreProjection = JSON.stringify({ state: lane.project(lane.before), version: 0 });
                lane.allowed.add(restoreProjection);
                try { lane.set(lane.before); lane.allowed = new Set([restoreProjection]); } catch { /* Verify memory/raw independently below; still attempt the other store. */ }
                if (!known()) break;
                lane.allowed.add(lane.raw);
                try {
                    if (lane.raw === null) storage.removeItem(lane.key); else storage.setItem(lane.key, lane.raw);
                    lane.allowed = new Set([lane.raw]);
                } catch { /* A failed compensation must not prevent the other independent attempt. */ }
            }
        }
        let restored = true;
        for (const lane of lanes) {
            if (!sameConfigData(lane.live(), lane.before)) restored = false;
            try { if (read(lane.key) !== lane.raw) restored = false; } catch { restored = false; reason = "unverified"; }
        }
        if (reason !== "apply") restored = false;
        const failure = new ConfigImportFailure(restored ? "verified" : "incomplete", reason, compensationAttempts, { before, beforePrompts, rawConfig, rawPrompt, candidate, nextPrompts, secretPolicy });
        useConfigImportRecovery.setState({ failure });
        throw failure;
    }
}