import { afterAll, expect, test } from "bun:test";

const descriptors = ["window", "localStorage"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
const storage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: storage } });
const { runModelPlugin } = await import("../src/services/api/model-plugin");
const { defaultConfig } = await import("../src/stores/use-config-store");
const trust = await import("../src/lib/executable-trust");
afterAll(() => {
    Reflect.deleteProperty(globalThis, "__executionCanary");
    for (const [key, descriptor] of descriptors) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
});
const source = "globalThis.__executionCanary = (globalThis.__executionCanary || 0) + 1; return 'synthetic-positive';";
const run = (script = source) => runModelPlugin({ config: defaultConfig, capability: "text", script });

test("model source is inert without exact-content local consent", async () => {
    Reflect.set(globalThis, "__executionCanary", 0);
    await expect(run()).rejects.toThrow(/授权|信任/);
    expect(Reflect.get(globalThis, "__executionCanary")).toBe(0);
});

test("revocation while a consent dialog awaits cannot be undone by its late confirmation", async () => {
    const scope = "synthetic-pending-consent";
    let finish!: (value: boolean) => void;
    const entered = Promise.withResolvers<void>();
    const approving = trust.approveExecutable(scope, source, async () => { entered.resolve(); return new Promise<boolean>(resolve => { finish = resolve; }); });
    await entered.promise;
    trust.revokeExecutable(scope);
    finish(true);
    expect(await approving).toBe(false);
    await expect(trust.assertExecutableTrusted(scope, source)).rejects.toThrow(/授权|信任/);
});

test("retained script changes during digest verification cannot run after synchronous revocation", async () => {
    const scope = "model";
    await trust.approveExecutable(scope, source, async () => true);
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    // Queue revocation immediately after the trust assertion's continuation, before its caller resumes.
    crypto.subtle.digest = (async (...args: Parameters<typeof digest>) => {
        const result = await digest(...args);
        queueMicrotask(() => queueMicrotask(() => queueMicrotask(() => trust.revokeExecutable(scope))));
        return result;
    }) as typeof digest;
    const before = Reflect.get(globalThis, "__executionCanary") || 0;
    try { await expect(run()).rejects.toThrow(/信任|授权/); expect(Reflect.get(globalThis, "__executionCanary") || 0).toBe(before); }
    finally { crypto.subtle.digest = digest; }
});

test("all syntactic external executable dependencies are disabled, not just ordinary import calls", () => {
    for (const source of [
        "import value from 'https://dependency.invalid/code.js'; export default value;",
        "import 'https://dependency.invalid/side-effects.js'; export default {};",
        "export * from 'https://dependency.invalid/code.js';",
        "export { value } from 'https://dependency.invalid/code.js';",
        "const load=()=>import /* comment */ ('https://dependency.invalid/code.js'); export default {};",
        "const load=()=>import(`https://dependency.invalid/${Date.now()}.js`); export default {};",
    ]) expect(() => trust.assertExecutableDependencies(source)).toThrow(/依赖|禁用/);
    expect(() => trust.assertExecutableDependencies("const text='import(never executed)'; /* import('comment') */ export default {};")).not.toThrow();
});

test("unchanged approval runs; changed source and revoked source do not", async () => {
    expect(await trust.approveExecutable("model", source, async () => false)).toBe(false);
    await expect(run()).rejects.toThrow(/授权|信任/);
    expect(await trust.approveExecutable("model", source, async digest => /^[a-f0-9]{64}$/.test(digest))).toBe(true);
    expect(await run()).toBe("synthetic-positive");
    expect(Reflect.get(globalThis, "__executionCanary")).toBe(1);
    await expect(run(source + "\n// replaced content")).rejects.toThrow(/授权|信任/);
    expect(Reflect.get(globalThis, "__executionCanary")).toBe(1);
    trust.revokeExecutable("model");
    await expect(run()).rejects.toThrow(/授权|信任/);
});
