import { expect, test } from "bun:test";

const read = (path: string) => Bun.file(new URL(path, import.meta.url)).text();

test("local Codex documents label upstream behavior historical and disclose the current full-trust boundary", async () => {
    const en = await read("../../docs/content/docs/development/local-codex-canvas.mdx");
    const zh = await read("../../docs/content/docs/development/local-codex-canvas.zh-CN.mdx");
    expect(en).toContain("unsupported in this configuration");
    expect(en).toContain("Historical upstream behavior");
    expect(en).toContain("session-memory keys");
    expect(en).not.toContain("bound to the first accepted origin");
    expect(en).not.toContain("The hosted website does not store");
    expect(zh).toContain("当前配置不支持");
    expect(zh).toContain("上游历史行为");
    expect(zh).toContain("纯内存密钥");
    expect(zh).not.toContain("避免其他来源复用当前本机 Agent");
    expect(zh).not.toContain("线上网页不保存");
    const uiEn = await read("../src/i18n/locales/en-US.ts");
    const uiZh = await read("../src/i18n/locales/zh-CN.ts");
    expect(uiEn).toContain("Companions are unsupported in this configuration");
    expect(uiEn).not.toContain("Requests go through the local proxy when it is on");
    expect(uiZh).toContain("当前配置不支持伴生服务");
    expect(uiZh).not.toContain("开启本地代理时经本机代理转发");
    const overview = await read("../../docs/content/docs/overview/codex-app-plugin.zh-CN.mdx");
    expect(overview).toContain("上游历史行为");
    expect(overview).not.toContain("#agentUrl=");
});
