import { useConfigStore } from "@/stores/use-config-store";

const REDACTED = "[REDACTED]";
const secretField = /^(?:key|authorization|proxy-authorization|x-goog-api-key|api[-_]?key|password|username|token|access[-_]?token|secret|credential)$/i;
const safeErrorNames = new Set(["Error", "EvalError", "RangeError", "ReferenceError", "SyntaxError", "TypeError", "URIError", "AggregateError", "AbortError", "TimeoutError"]);

function decodeLogText(value: string) {
    let text = value;
    for (;;) {
        const decoded = text.replace(/(?:%[\da-f]{2})+/gi, (part) => {
            try { return decodeURIComponent(part); } catch { return REDACTED; }
        });
        if (decoded === text) return text;
        text = decoded;
    }
}

/** Redact copies at logging/error boundaries, never mutate or silently erase stored settings. */
export function redactText(value: string, extraSecrets: string[] = []) {
    const { config, webdav } = useConfigStore.getState();
    const secrets = [...extraSecrets, config.apiKey, ...config.channels.map((channel) => channel.apiKey), webdav.username, webdav.password];
    if (webdav.username || webdav.password) {
        const bytes = new TextEncoder().encode(`${webdav.username}:${webdav.password}`);
        secrets.push(btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join("")));
    }
    try { secrets.push(localStorage.getItem("canvas-agent-token") || ""); } catch { /* Storage may be unavailable. */ }
    // Redact whole raw parameter values before decoding delimiters inside them.
    let text = decodeLogText(value.replace(/([?&#])([^=\s&#"'<>]+)=([^\s&#"'<>]*)/g, (match, prefix: string, name: string) => secretField.test(decodeLogText(name)) ? `${prefix}${name}=${REDACTED}` : match));
    for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) {
        text = text.split(secret).join(REDACTED).split(decodeLogText(secret)).join(REDACTED);
    }
    return text
        .replace(/(https?:\/\/)[^\s/]+@/gi, `$1${REDACTED}@`)
        .replace(/([?&#](?:key|api[-_]?key|x-goog-api-key|token|access[-_]?token|authorization|proxy-authorization|username|password|secret|credential)=)[^\s&#"'<>]*/gi, `$1${REDACTED}`)
        .replace(/((?:authorization|proxy-authorization|x-goog-api-key|api[-_]?key|password|username|token)\s*["']?\s*[:=]\s*["']?)(?:(?:Bearer|Basic)\s+)?[^\s,;"'{}\]]+/gi, `$1${REDACTED}`);
}

export function redactLogValue(value: unknown, seen = new WeakSet<object>()): unknown {
    if (typeof value === "string") return redactText(value);
    if (!value || typeof value !== "object") return value;
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    if (value instanceof Error) {
        // Custom names can contain credentials absent from the configured secret context.
        const name = redactText(value.name);
        return { name: safeErrorNames.has(name) ? name : "Error", message: redactText(value.message) };
    }
    if (value instanceof Headers) return redactLogValue(Object.fromEntries(value.entries()), seen);
    if (Array.isArray(value)) return value.map((item) => redactLogValue(item, seen));
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [redactText(key), secretField.test(decodeLogText(key)) ? REDACTED : redactLogValue(item, seen)]));
}

export function logError(...args: unknown[]) {
    console.error(...args.map((value) => redactLogValue(value)));
}

export function logInfo(...args: unknown[]) {
    console.info(...args.map((value) => redactLogValue(value)));
}
