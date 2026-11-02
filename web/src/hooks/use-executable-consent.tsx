import { App } from "antd";
import { approveExecutable, FULL_TRUST_WARNING } from "@/lib/executable-trust";

export function useExecutableConsent() {
    const { modal, message } = App.useApp();
    return async (scope: string, source: string) => {
        try { return await approveExecutable(scope, source, async digest => Boolean(await modal.confirm({
        title: "完全信任并授权这份代码（仅本次页面会话）？",
        content: <div className="space-y-2"><p>{FULL_TRUST_WARNING}</p><div className="break-all font-mono">SHA-256: {digest}</div><pre className="max-h-64 overflow-auto whitespace-pre-wrap text-xs">{source}</pre></div>,
        okText: "我信任此代码，授权运行",
        cancelText: "不授权",
        }))); }
        catch (error) { message.error(error instanceof Error ? error.message : "无法授权此代码"); return false; }
    };
}
