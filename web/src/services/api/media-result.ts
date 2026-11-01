import { redactText } from "@/lib/secret-redaction";

type MediaKind = "image" | "audio" | "video";
const invalidMedia = () => new Error("渠道未返回有效媒体（可能为鉴权错误）；仅支持请求头认证，不会保存错误响应或使用 URL 密钥回退。");

/** Provider MIME parameters are not application metadata. Keep only the media type. */
export async function normalizeMediaBlob(blob: Blob, kind: MediaKind, secrets: string[] = [], fallback = `${kind}/${kind === "image" ? "png" : kind === "audio" ? "mpeg" : "mp4"}`): Promise<Blob> {
    const mime = blob.type.split(";", 1)[0].trim().toLowerCase();
    const type = !mime || mime === "application/octet-stream" ? fallback : mime;
    if (!blob.size || !new RegExp(`^${kind}/[a-z\\d!#$&^_.+-]+$`).test(type) || redactText(type, secrets.flatMap((secret) => [secret, secret.toLowerCase()])) !== type) throw invalidMedia();
    // Inspect only the leading textual envelope, never search arbitrary media bytes for keys.
    const reader = blob.stream().getReader();
    const decoder = new TextDecoder();
    let head = "";
    try {
        while (!head.trim()) {
            const { value, done } = await reader.read();
            if (done) break;
            head += decoder.decode(value, { stream: true });
        }
    } finally { await reader.cancel(); }
    if (/^\s*[\[{]/.test(head)) {
        let json = false;
        try { JSON.parse(await blob.text()); json = true; } catch { /* Not a JSON envelope. */ }
        if (json) throw invalidMedia();
    }
    if (/^\s*<(?:!doctype|html|head|body|script|\?xml|error)\b/i.test(head)) throw invalidMedia();
    return blob.type === type ? blob : new Blob([blob], { type });
}

/** Decode locally, discarding provider data-URL parameters before any result or persistence. */
export async function inlineMediaBlob(source: string, kind: MediaKind, secrets: string[] = [], fallback?: string) {
    const comma = source.indexOf(",");
    if (!/^data:/i.test(source) || comma < 0) throw invalidMedia();
    const header = source.slice(5, comma);
    const mime = header.split(";", 1)[0].trim().toLowerCase();
    let blob: Blob;
    try {
        const data = source.slice(comma + 1);
        blob = /;base64$/i.test(header)
            ? new Blob([Uint8Array.from(atob(data), (char) => char.charCodeAt(0))], { type: mime })
            : new Blob([decodeURIComponent(data)], { type: mime });
    } catch { throw invalidMedia(); }
    return normalizeMediaBlob(blob, kind, secrets, fallback);
}