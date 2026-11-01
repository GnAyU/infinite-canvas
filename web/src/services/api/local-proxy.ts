import { COMPANION_UNSUPPORTED } from "./canvas-agent";

/** Compatibility entrypoint: companion health checks are disabled without transport. */
export async function testLocalProxy(_proxyUrl: string): Promise<string> {
    throw new Error(COMPANION_UNSUPPORTED);
}
