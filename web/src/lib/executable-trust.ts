import { javascriptLanguage } from "@codemirror/lang-javascript";

export const FULL_TRUST_WARNING = "此代码将在与应用相同的页面环境中完全受信任地运行，不是沙箱。它能读取已持久化的 API/WebDAV 密钥、残留 Agent Token、页面数据及本次会话的纯内存密钥，发起请求并修改应用。摘要只标识这份代码，不证明发布者可信。撤销只能阻止后续运行，不能撤回已经运行的代码或副作用；如需清除已运行代码，请重新加载页面。每次重新加载均需重新授权。";

// Session-local only: imported flags, old caches and reloads can never create consent.
const approvals = new Map<string, Map<string, string>>();
const consentEpochs = new Map<string, object>();

/** Inspect syntax only. Neither parsing nor metadata preview evaluates the source. */
export function assertExecutableDependencies(source: string) {
    let unbound = false;
    javascriptLanguage.parser.parse(source).iterate({ enter(node) {
        if (node.type.isError || node.name === "DynamicImport" || node.name === "ImportDeclaration" || (node.name === "ExportDeclaration" && node.node.getChild("from"))) unbound = true;
    } });
    if (unbound) throw new Error("此版本已禁用：模块依赖未绑定到已批准的完整可执行内容（包括 marked@14、three@0.180.0 等 CDN 依赖），或源码无法静态解析。请提供可检查的独立完整包；顶层摘要不等于依赖完整性。这不是对完全受信任代码的沙箱。");
}

export async function executableDigest(source: string) {
    const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
    return Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2, "0")).join("");
}

export async function approveExecutable(scope: string, source: string, confirm: (digest: string) => Promise<boolean>) {
    const epoch = consentEpochs.get(scope) || {};
    consentEpochs.set(scope, epoch);
    assertExecutableDependencies(source);
    const digest = await executableDigest(source);
    if (!await confirm(digest) || consentEpochs.get(scope) !== epoch) return false;
    const digests = approvals.get(scope) || new Map<string, string>();
    digests.set(digest, source);
    approvals.set(scope, digests);
    return true;
}

export function revokeExecutable(scope: string) {
    consentEpochs.set(scope, {}); // Invalidate already-open consent dialogs as well as completed approvals.
    approvals.delete(scope);
}

/** Invalidate replaced source, retaining separate consent for a newly approved editor draft. */
export function revokeExecutableSource(scope: string, source: string) {
    consentEpochs.set(scope, {});
    for (const [digest, approved] of approvals.get(scope) || []) if (approved === source) approvals.get(scope)!.delete(digest);
}

export async function assertExecutableTrusted(scope: string, source: string) {
    assertExecutableDependencies(source);
    const digest = await executableDigest(source);
    // Recheck after hashing: revocation while awaiting the digest must win.
    const check = () => { if (!approvals.get(scope)?.has(digest)) throw new Error("此代码尚未获得本次会话的精确内容信任授权；请在编辑器或插件管理器中检查并授权。"); };
    check();
    return check; // Call synchronously at evaluation/activation after the caller's await too.
}
