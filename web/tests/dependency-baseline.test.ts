import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

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
