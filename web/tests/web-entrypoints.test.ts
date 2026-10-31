import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("web servers default to loopback and install entrypoints freeze the approved graph", () => {
    const manifest = JSON.parse(read("../package.json"));
    for (const name of ["dev", "start"]) {
        expect(manifest.scripts[name]).toContain("--host 127.0.0.1");
    }
    expect(read("../../scripts/setup.sh")).toContain("bun install --frozen-lockfile --registry=https://registry.npmjs.org");
    expect(read("../../scripts/check-web-toolchain.sh")).toContain('"1.4.4"');
    expect(read("../../scripts/check-web-toolchain.sh")).toContain('"v22.23.4"');
    expect(read("../bunfig.toml")).toContain("frozenLockfile = true");
});

test("Docker and Pages use the approved tools and frozen web install", () => {
    const docker = read("../../Dockerfile");
    expect(docker).toContain("oven/bun:1.4.4");
    expect(docker).toContain("node:22.23.4-bookworm-slim");
    expect(docker.indexOf("web/bunfig.toml")).toBeLessThan(docker.indexOf("bun install"));
    expect(docker).toContain("bun install --frozen-lockfile --registry=https://registry.npmjs.org");
    const pages = read("../../.github/workflows/github-pages.yml");
    expect(pages).toContain('bun-version: "1.4.4"');
    expect(pages).toContain('node-version: "22.23.4"');
    expect(pages).toContain("./scripts/setup.sh");
    const vercel = JSON.parse(read("../../vercel.json"));
    expect(vercel.installCommand).toBe("./scripts/setup.sh");
    expect(vercel.buildCommand).toContain("./scripts/check-web-toolchain.sh");
});
