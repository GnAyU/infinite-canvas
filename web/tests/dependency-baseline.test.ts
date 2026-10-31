import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("Bun is the only web lock and obsolete pnpm policy is absent", () => {
    expect(existsSync(new URL("../bun.lock", import.meta.url))).toBe(true);
    for (const file of ["package-lock.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"]) {
        expect(existsSync(new URL(`../${file}`, import.meta.url))).toBe(false);
    }
});

test("web uses the approved exact toolchain and explicit lifecycle allowlist", () => {
    const manifest = JSON.parse(read("../package.json"));
    expect(manifest.packageManager).toBe("bun@1.4.4");
    expect(manifest.engines).toEqual({ bun: "1.4.4", node: "22.23.4" });
    expect(manifest.trustedDependencies).toEqual(["esbuild"]);
    for (const group of [manifest.dependencies, manifest.devDependencies]) {
        for (const version of Object.values(group)) expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    }
    expect(manifest.dependencies.localforage).toBe("1.10.0");
    expect(manifest.dependencies.react).toMatch(/^19\./);
    expect(manifest.dependencies.antd).toMatch(/^6\./);
    expect(manifest.dependencies).not.toHaveProperty("@ant-design/pro-components");
    expect(manifest.dependencies).not.toHaveProperty("shadcn");
});

test("the app provider uses only the existing AntD facilities", () => {
    const provider = read("../src/components/layout/app-providers.tsx");
    expect(provider).not.toContain("ProConfigProvider");
    expect(provider).not.toContain("@ant-design/pro-components");
    expect(provider).toContain('locale={locale === "zh-CN" ? zhCN : enUS}');
    expect(provider).toContain("theme={getAntThemeConfig(dark)}");
    expect(provider).toContain("<App>");
    expect(provider).toContain("<QueryClientProvider");
    expect(provider).toContain("<ClientRootInit>");
});

test("removing the shadcn CLI retains the Radix select state styles", () => {
    const css = read("../src/styles/globals.css");
    expect(css).not.toContain('"shadcn/tailwind.css"');
    for (const state of ["open", "closed", "disabled"]) {
        expect(css).toContain(`@custom-variant data-${state}`);
    }
});
