// Runtime configuration access layer.
// Priority: window.__RUNTIME_CONFIG__ (injected by the container entrypoint) > build-time VITE_ variables > defaults.
// This supports both configuring the same image with docker run -e and injecting values during custom builds.
//
// Provider IDs are configuration, never consent. Runtime flags can deny background traffic only.
// Only GA4 and Baidu are supported. Both accept IDs only, and script URLs are assembled in code without arbitrary scripts or inline JavaScript.

type RuntimeConfig = {
    ANALYTICS_GA4_ID?: string; // GA4 measurement ID (G-XXXX)
    ANALYTICS_BAIDU_ID?: string; // Baidu Analytics site ID
    DISABLE_ANALYTICS?: string;
    DISABLE_VERSION_CHECK?: string;
    DISABLE_PROMPT_FEED?: string;
};

declare global {
    interface Window {
        __RUNTIME_CONFIG__?: RuntimeConfig;
    }
}

const runtime: RuntimeConfig = (typeof window !== "undefined" && window.__RUNTIME_CONFIG__) || {};

function read(key: keyof RuntimeConfig, buildTime: string | undefined, fallback = ""): string {
    const value = runtime[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof buildTime === "string" && buildTime.trim()) return buildTime.trim();
    return fallback;
}

export const ANALYTICS_GA4_ID = read("ANALYTICS_GA4_ID", import.meta.env.VITE_ANALYTICS_GA4_ID);
export const ANALYTICS_BAIDU_ID = read("ANALYTICS_BAIDU_ID", import.meta.env.VITE_ANALYTICS_BAIDU_ID);

export const BACKGROUND_DISABLED = {
    analytics: runtime.DISABLE_ANALYTICS === "true" || import.meta.env.VITE_DISABLE_ANALYTICS === "true",
    version: runtime.DISABLE_VERSION_CHECK === "true" || import.meta.env.VITE_DISABLE_VERSION_CHECK === "true",
    promptFeed: runtime.DISABLE_PROMPT_FEED === "true" || import.meta.env.VITE_DISABLE_PROMPT_FEED === "true",
};
