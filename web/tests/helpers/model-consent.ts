import { approveExecutable } from "../../src/lib/executable-trust";
import { runModelPlugin, type RunPluginArgs } from "../../src/services/api/model-plugin";
import type { AiConfig } from "../../src/stores/use-config-store";

// Earlier transport/media regressions deliberately run synthetic trusted code.
// Use the real consent/gate, never mock it, so negative tests cannot pass at the wrong boundary.
export async function runTrustedModelPlugin<T = unknown>(args: RunPluginArgs): Promise<T> {
    await approveExecutable("model", args.script, async () => true);
    return runModelPlugin<T>(args);
}

export function withModelConsent<A extends [AiConfig, ...unknown[]], R>(action: (...args: A) => R) {
    return async (...args: A): Promise<Awaited<R>> => {
        for (const channel of args[0].channels) {
            for (const model of channel.models) if (model.script) await approveExecutable("model", model.script.trim(), async () => true);
        }
        return await action(...args);
    };
}
