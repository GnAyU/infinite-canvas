import { create } from "zustand";
import { BACKGROUND_DISABLED } from "@/constant/runtime-config";

export type BackgroundKind = "analytics" | "version" | "promptFeed";

// Deliberately session-only: neither legacy settings nor configuration imports convey consent.
export const useBackgroundStore = create<{
    consent: Record<BackgroundKind, boolean>;
    setConsent: (kind: BackgroundKind, enabled: boolean) => void;
}>((set) => ({
    consent: { analytics: false, version: false, promptFeed: false },
    setConsent: (kind, enabled) => set((state) => ({ consent: { ...state.consent, [kind]: enabled && !BACKGROUND_DISABLED[kind] } })),
}));

export function isBackgroundAllowed(kind: BackgroundKind) {
    return useBackgroundStore.getState().consent[kind] && !BACKGROUND_DISABLED[kind];
}

export function useBackgroundPermission(kind: BackgroundKind) {
    return useBackgroundStore((state) => state.consent[kind] && !BACKGROUND_DISABLED[kind]);
}
