import axios, { type AxiosRequestConfig } from "axios";

type ChannelRecipient = { baseUrl: string; apiKey: string };
const invalidRecipient = () => new Error("请求地址无效或不属于所选渠道；已在发送前拒绝。仅支持渠道配置的 HTTP(S) 精确来源及请求头认证。");
const sensitiveParameter = /^(?:key|api[-_]?key|x-goog-api-key|access[-_]?token|token|authorization|password|secret|credential)$/i;

/** URL parsing, not string/suffix matching, defines the configured credential recipient. */
function parseHttpUrl(value: string) {
    if (!/^https?:\/\/[^/?#]+/i.test(value) || /[\\\u0000-\u0020\u007f]/.test(value) || /%(?![\da-f]{2})/i.test(value)) throw invalidRecipient();
    let url: URL;
    try { url = new URL(value); } catch { throw invalidRecipient(); }
    if (!url.hostname || url.username || url.password || value.split("/")[2]?.includes("@")) throw invalidRecipient();
    return url;
}

export function assertCredentialFreeUrl(value: string, secrets: string[] = []) {
    const url = parseHttpUrl(value);
    if (url.hash || [...url.searchParams.keys()].some((key) => sensitiveParameter.test(key))) throw invalidRecipient();
    let decoded: string;
    try { decoded = decodeURIComponent(value); } catch { throw invalidRecipient(); }
    if (secrets.some((secret) => secret && (decoded.includes(secret) || value.includes(secret) || value.includes(encodeURIComponent(secret))))) throw invalidRecipient();
    return url;
}

export function channelRequestUrl(config: ChannelRecipient, path: string) {
    const base = assertCredentialFreeUrl(config.baseUrl.trim(), [config.apiKey]);
    if (base.search) throw invalidRecipient();
    const value = path.trim();
    if (!value || /[\\\u0000-\u0020\u007f]/.test(value) || value.startsWith("//")) throw invalidRecipient();
    const absolute = /^[a-z][a-z\d+.-]*:/i.test(value);
    const prefix = base.href.replace(/\/+$/, "");
    const apiBase = /\/v1$/i.test(prefix) ? prefix : `${prefix}/v1`;
    const url = assertCredentialFreeUrl(absolute ? value : new URL(value.replace(/^\//, ""), `${apiBase}/`).href, [config.apiKey]);
    if (url.origin !== base.origin) throw invalidRecipient();
    return url.href;
}

/** Pin Axios to browser fetch (never XHR), retaining its FormData, timeout and response handling. */
export function channelAxios<T>(config: ChannelRecipient, path: string, options: AxiosRequestConfig = {}) {
    const url = channelRequestUrl(config, path);
    return axios.request<T>({
        ...options,
        url,
        adapter: "fetch",
        withCredentials: false,
        fetchOptions: { redirect: "error", credentials: "omit", referrerPolicy: "no-referrer" },
        env: { fetch: (input, init) => fetch(input, { ...init, redirect: "error", credentials: "omit", referrerPolicy: "no-referrer" }) },
    });
}

/** Browser fetch enforces redirect refusal before a second request. */
export async function channelFetch(config: ChannelRecipient, path: string, init: RequestInit = {}) {
    const url = channelRequestUrl(config, path);
    if (init.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    let response: Response;
    try {
        response = await fetch(url, { ...init, redirect: "error", credentials: "omit", referrerPolicy: "no-referrer" });
    } catch {
        if (init.signal?.aborted) throw new DOMException("Aborted", "AbortError");
        throw new Error("渠道请求失败：不允许重定向，请检查浏览器直连与请求头认证支持；不会使用代理或 URL 密钥回退。");
    }
    if (!response.ok || response.type === "opaqueredirect" || response.redirected) {
        throw new Error(`渠道请求失败（${response.status}）：仅支持请求头认证，不允许重定向或 URL 密钥回退。`);
    }
    return response;
}
