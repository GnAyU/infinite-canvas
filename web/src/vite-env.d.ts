/// <reference types="vite/client" />

declare const __APP_VERSION__: string;
declare const __APP_RELEASES__: import("@/lib/release").ReleaseInfo[];

interface ImportMetaEnv {
    // Comma-separated development plugin URLs, fetched only by the explicit manager load action.
    readonly VITE_DEV_PLUGINS?: string;
    // Optional build-time analytics configuration, with one independent variable per provider.
    // GA4 measurement ID (G-XXXX)
    readonly VITE_ANALYTICS_GA4_ID?: string;
    // Baidu Analytics site ID
    readonly VITE_ANALYTICS_BAIDU_ID?: string;
    // Deny-only deployment flags. IDs and false flags never opt a user in.
    readonly VITE_DISABLE_ANALYTICS?: string;
    readonly VITE_DISABLE_VERSION_CHECK?: string;
    readonly VITE_DISABLE_PROMPT_FEED?: string;
}
