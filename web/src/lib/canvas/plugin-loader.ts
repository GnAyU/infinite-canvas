import { registerNodeDefinitions, unregisterPluginNodes } from "@/lib/canvas/node-registry";
import { getPluginRuntime } from "@/lib/canvas/plugin-runtime";
import { assertExecutableTrusted, revokeExecutable } from "@/lib/executable-trust";
import { usePluginStore, type InstalledPlugin } from "@/stores/canvas/use-plugin-store";
import type { CanvasPlugin } from "@/types/canvas-plugin";
import i18n from "@/i18n";
import { logError } from "@/lib/secret-redaction";

const cleanups = new Map<string, () => void>();
const activeIds = new Map<string, string>();
export const pluginTrustScope = (id: string) => `canvas:${id}`;

// The only evaluator. Intake/preview never reaches it, including factory metadata.
async function evaluatePluginSource(id: string, source: string): Promise<CanvasPlugin> {
    const checkTrust = await assertExecutableTrusted(pluginTrustScope(id), source);
    checkTrust();
    const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    try {
        const mod = (await import(/* @vite-ignore */ url)) as { default?: unknown; plugin?: unknown };
        checkTrust(); // Module execution already started; a revoked factory/setup must not start afterward.
        const exported = mod.default ?? mod.plugin;
        const plugin = typeof exported === "function" ? (exported as (runtime: unknown) => unknown)(getPluginRuntime()) : exported;
        assertPlugin(plugin);
        return plugin;
    } finally {
        URL.revokeObjectURL(url);
    }
}

function assertPlugin(plugin: unknown): asserts plugin is CanvasPlugin {
    const value = plugin as Partial<CanvasPlugin> | null;
    if (!value || typeof value !== "object") throw new Error(i18n.t("canvas.pluginErrors.invalidExport"));
    if (!value.id || !Array.isArray(value.nodes) || !value.nodes.length) throw new Error(i18n.t("canvas.pluginErrors.missingFields"));
}

function activatePlugin(recordId: string, plugin: CanvasPlugin) {
    activeIds.set(recordId, plugin.id);
    registerNodeDefinitions(plugin.nodes, plugin.id);
    const runtime = getPluginRuntime();
    const disposers: Array<() => void> = [];
    if (plugin.css) disposers.push(runtime.injectCSS(plugin.css, plugin.id));
    const cleanup = plugin.setup?.(runtime);
    if (typeof cleanup === "function") disposers.push(cleanup);
    if (disposers.length) cleanups.set(recordId, () => disposers.forEach(dispose => dispose()));
}

export function deactivatePlugin(recordId: string) {
    cleanups.get(recordId)?.();
    cleanups.delete(recordId);
    unregisterPluginNodes(activeIds.get(recordId) || recordId);
    activeIds.delete(recordId);
}

async function fetchPluginSource(url: string) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(i18n.t("canvas.pluginErrors.downloadFailed", { status: response.status }));
    return response.text();
}

function withCacheBust(url: string) {
    return `${url}${url.includes("?") ? "&" : "?"}t=${Date.now()}`;
}

// Metadata comes only from inert catalog fields or the URL, never from evaluating code.
function stagePlugin(url: string, source: string, opts?: { id?: string; name?: string; version?: string; description?: string; official?: boolean; local?: boolean }) {
    const store = usePluginStore.getState();
    const existing = store.plugins.find(item => item.url === url);
    const id = existing?.id || opts?.id || new URL(url, "https://local.invalid").pathname.split("/").pop()?.replace(/\.m?js$/, "") || url;
    const collision = store.plugins.find(item => item.id === id && item.url !== url);
    if (collision) throw new Error("插件标识冲突，请先卸载同名插件；未执行源码。");
    deactivatePlugin(id);
    if (existing?.source !== source) revokeExecutable(pluginTrustScope(id));
    store.upsert({ id, name: opts?.name || existing?.name || id, version: opts?.version || existing?.version || "0.0.0", description: opts?.description || existing?.description, url, source, enabled: false, official: opts?.official ?? existing?.official, local: opts?.local ?? existing?.local });
    return usePluginStore.getState().plugins.find(item => item.id === id)!;
}

// Install/update only downloads and stages disabled source. Enable is a separate consent action.
export async function installPluginFromUrl(url: string, opts?: { official?: boolean; bustCache?: boolean; id?: string; name?: string; version?: string; description?: string; local?: boolean }) {
    return stagePlugin(url, await fetchPluginSource(opts?.bustCache ? withCacheBust(url) : url), opts);
}

export async function updatePlugin(record: InstalledPlugin) {
    return installPluginFromUrl(record.url, { ...record, bustCache: true });
}

export async function preparePluginForEnable(record: InstalledPlugin) {
    const current = usePluginStore.getState().plugins.find(item => item.id === record.id);
    if (!current) throw new Error("插件已移除");
    return current.local ? installPluginFromUrl(current.url, { ...current, bustCache: true }) : current;
}

export async function setPluginEnabled(record: InstalledPlugin, enabled: boolean) {
    if (!enabled) {
        revokeExecutable(pluginTrustScope(record.id));
        usePluginStore.getState().setEnabled(record.id, false);
        deactivatePlugin(record.id);
        return;
    }
    // Re-fetch local code at the execution boundary. A changed response cannot reuse consent.
    const current = await preparePluginForEnable(record);
    const source = current.source;
    const plugin = await evaluatePluginSource(current.id, source);
    // Revocation/replacement during module loading must also prevent activation.
    const checkTrust = await assertExecutableTrusted(pluginTrustScope(current.id), source);
    checkTrust();
    if (usePluginStore.getState().plugins.find(item => item.id === current.id)?.source !== source) throw new Error("插件内容已更改，请重新检查授权");
    deactivatePlugin(current.id);
    activatePlugin(current.id, plugin);
    usePluginStore.getState().setEnabled(current.id, true);
}

export function uninstallPlugin(id: string) {
    revokeExecutable(pluginTrustScope(id));
    deactivatePlugin(id);
    usePluginStore.getState().remove(id);
}

// Intentional manager discovery only; cached enabled/imported flags never authorize evaluation.
export async function ensurePluginsLoaded() {
    if (!usePluginStore.persist.hasHydrated()) await usePluginStore.persist.rehydrate();
    await loadLocalPlugins();
    const raw = import.meta.env?.VITE_DEV_PLUGINS;
    for (const url of raw?.split(",").map(item => item.trim()).filter(Boolean) || []) {
        try { await installPluginFromUrl(url, { local: true, bustCache: true }); }
        catch (error) { logError("[plugin] Dev plugin discovery failed", error); }
    }
}

async function loadLocalPlugins() {
    let urls: unknown;
    try {
        const response = await fetch("/plugins/index.json");
        if (!response.ok) return;
        urls = await response.json();
    } catch { return; }
    if (!Array.isArray(urls)) return;
    for (const url of urls) {
        if (typeof url !== "string") continue;
        try { await installPluginFromUrl(url, { local: true, bustCache: true }); }
        catch (error) { logError("[plugin] Local plugin discovery failed", error); }
    }
}
