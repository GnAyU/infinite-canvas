// Provider code runs only after session consent, in a disposable opaque-origin frame.
// It cannot read application URLs/titles/storage; removing it cancels future provider scheduling.
import { ANALYTICS_BAIDU_ID, ANALYTICS_GA4_ID } from "@/constant/runtime-config";
import { isBackgroundAllowed, useBackgroundStore } from "@/stores/use-background-store";

const routes = new Set(["/", "/image", "/video", "/assets", "/prompts", "/canvas", "/canvas/:id", "/config", "/not-found"]);
export function analyticsRoute(path: string) {
    const pathname = path.split(/[?#]/, 1)[0];
    return routes.has(pathname) ? pathname : /^\/canvas\/[^/]+$/.test(pathname) ? "/canvas/:id" : "/not-found";
}

let initialized = false;
let frame: HTMLIFrameElement | undefined;
let currentRoute = "/";
const ga4 = /^G-[A-Z0-9]+$/.test(ANALYTICS_GA4_ID) ? ANALYTICS_GA4_ID : "";
const baidu = /^[a-f0-9]{32}$/i.test(ANALYTICS_BAIDU_ID) ? ANALYTICS_BAIDU_ID : "";

function syncConsent() {
    if (!isBackgroundAllowed("analytics")) {
        frame?.remove();
        frame = undefined;
        return;
    }
    if (frame || (!ga4 && !baidu)) return;
    const next = document.createElement("iframe");
    next.hidden = true;
    next.title = "匿名页面统计";
    next.setAttribute("sandbox", "allow-scripts");
    next.referrerPolicy = "no-referrer";
    next.src = `${import.meta.env.BASE_URL || "/"}analytics-frame.html`;
    next.onload = () => {
        if (frame === next && isBackgroundAllowed("analytics")) next.contentWindow?.postMessage({ type: "ic-analytics-init", ga4, baidu, route: currentRoute }, "*");
    };
    frame = next;
    document.body.appendChild(next);
}

export function initAnalytics() {
    if (initialized || typeof window === "undefined") return;
    initialized = true;
    const unsubscribe = useBackgroundStore.subscribe(syncConsent);
    syncConsent();
    return () => {
        unsubscribe();
        frame?.remove();
        frame = undefined;
        initialized = false;
    };
}

// No raw location, title, channel name or generated text crosses the frame boundary.
export function trackPageview(path: string) {
    currentRoute = analyticsRoute(path);
    if (isBackgroundAllowed("analytics")) frame?.contentWindow?.postMessage({ type: "ic-analytics-pageview", route: currentRoute }, "*");
}
