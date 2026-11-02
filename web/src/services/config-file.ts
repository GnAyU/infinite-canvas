import { saveAs } from "file-saver";

import i18n from "@/i18n";
import { classifyUrlCredentials, redactText } from "@/lib/secret-redaction";
import { channelPlaintextWarning, defaultConfig, useConfigStore, type AiConfig, type WebdavSyncConfig } from "@/stores/use-config-store";
import { usePromptSourceStore, type PromptSourceSchedule } from "@/stores/use-prompt-source-store";
import type { PromptSource } from "@/services/api/prompt-source-presets";
import { applyConfigImport, CONFIG_IMPORT_WARNING, validateConfigImport } from "@/services/config-import";

type AppConfigFile = {
    app: "infinite-canvas";
    version: 1;
    exportedAt: string;
    config: AiConfig;
    webdav: WebdavSyncConfig;
    promptSources: {
        sources: PromptSource[];
        schedule: PromptSourceSchedule;
    };
};

/** Whitelist v1 fields. Free text/identities are not a reliable secret detector. */
function projectExport(config: AiConfig, webdav: WebdavSyncConfig, sources: PromptSource[], schedule: PromptSourceSchedule) {
    const safeUrl = (value: string) => classifyUrlCredentials(value) !== "safe" || redactText(value).includes("[REDACTED]") ? undefined : value;
    return {
        config: {
            ...Object.fromEntries(Object.keys(defaultConfig).filter(key => !["apiKey", "channels"].includes(key)).map(key => [key, config[key as keyof AiConfig]])),
            baseUrl: safeUrl(config.baseUrl),
            proxyUrl: safeUrl(config.proxyUrl),
            channels: config.channels.map(({ id, name, baseUrl, apiFormat, models }) => ({ id, name, baseUrl: safeUrl(baseUrl), apiFormat, models: models.map(({ name, capability }) => ({ name, capability })) })),
        },
        webdav: { url: safeUrl(webdav.url), directory: webdav.directory, lastSyncedAt: webdav.lastSyncedAt },
        promptSources: { sources: sources.map(({ id, name, url, homepage, enabled, builtIn }) => ({ id, name, url: safeUrl(url), homepage: safeUrl(homepage), enabled, builtIn })), schedule: { intervalMinutes: schedule.intervalMinutes, lastFetchedAt: schedule.lastFetchedAt } },
    };
}

export const SAFE_EXPORT_WARNING = "默认导出省略凭据、带凭据的地址和可执行脚本；其他用户文本仍可能含秘密，分享前必须人工检查。摘要或脱敏不等于加密。";
export const SENSITIVE_EXPORT_WARNING = "完整敏感导出包含明文 API/WebDAV 凭据及脚本，可能含其他秘密。拿到文件的人可读取并使用；请勿分享。此确认仅限本次导出，不代表记住密钥或信任导入代码。";

export function createAppConfigExport() {
    const { config, webdav } = useConfigStore.getState();
    const { sources, schedule } = usePromptSourceStore.getState();
    return { app: "infinite-canvas", version: 1, exportedAt: new Date().toISOString(), ...projectExport(config, webdav, sources, schedule) } as AppConfigFile;
}

export async function createSensitiveAppConfigExport(confirm: (warning: string) => Promise<boolean>) {
    if (!await confirm(SENSITIVE_EXPORT_WARNING)) return null;
    const { config, webdav } = useConfigStore.getState();
    const { sources, schedule } = usePromptSourceStore.getState();
    // Same v1 fields only; unknown/imported flags never become export authority.
    return structuredClone({ app: "infinite-canvas" as const, version: 1 as const, exportedAt: new Date().toISOString(), config: {
        ...Object.fromEntries(Object.keys(defaultConfig).map(key => [key, config[key as keyof AiConfig]])),
        channels: config.channels.map(({ id, name, baseUrl, apiKey, apiFormat, models }) => ({ id, name, baseUrl, apiKey, apiFormat, models: models.map(({ name, capability, script }) => ({ name, capability, script })) })),
    }, webdav: { url: webdav.url, directory: webdav.directory, lastSyncedAt: webdav.lastSyncedAt, username: webdav.username, password: webdav.password }, promptSources: { sources: sources.map(({ id, name, url, homepage, enabled, builtIn }) => ({ id, name, url, homepage, enabled, builtIn })), schedule: { intervalMinutes: schedule.intervalMinutes, lastFetchedAt: schedule.lastFetchedAt } } });
}

export async function exportSensitiveAppConfig(confirm: (warning: string) => Promise<boolean>) {
    const data = await createSensitiveAppConfigExport(confirm);
    if (!data) return false;
    saveAs(new Blob([JSON.stringify(data, null, 2)], { type: "application/json;charset=utf-8" }), "infinite-canvas-config.json");
    return true;
}

export function exportAppConfig() {
    const data = createAppConfigExport();
    saveAs(new Blob([JSON.stringify(data, null, 2)], { type: "application/json;charset=utf-8" }), "infinite-canvas-config.json");
}

export async function importAppConfig(file: File, confirm: (warning: string) => Promise<boolean> = async warning => window.confirm(warning)) {
    let data: AppConfigFile;
    try {
        data = JSON.parse(await file.text()) as AppConfigFile;
    } catch {
        throw new Error(i18n.t("config.invalidFile"));
    }
    const admitted = validateConfigImport(data);
    if (!await confirm(CONFIG_IMPORT_WARNING)) return { cancelled: true, warnings: [] };
    applyConfigImport(admitted);
    return { cancelled: false, warnings: [...new Set(admitted.config.channels.map((channel) => channelPlaintextWarning(channel.baseUrl)).filter(Boolean))] };
}
