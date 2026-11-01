import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
import { App } from "antd";
import { useTranslation } from "react-i18next";

import { useConfigStore } from "@/stores/use-config-store";
import { usePromptSourceScheduler } from "@/hooks/use-prompt-source-scheduler";

declare global {
    interface Window {
        __IC_BOOTSTRAP__?: { baseUrl: string; apiKey: string };
    }
}

export function ClientRootInit({ children }: { children: ReactNode }) {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const handledConfigParams = useRef(false);
    const importBootstrapCredentials = useConfigStore((state) => state.importBootstrapCredentials);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);

    usePromptSourceScheduler();

    useEffect(() => {
        if (handledConfigParams.current) return;
        const bootstrap = window.__IC_BOOTSTRAP__;
        delete window.__IC_BOOTSTRAP__;
        if (!bootstrap) return;
        handledConfigParams.current = true;
        const result = importBootstrapCredentials(bootstrap.baseUrl, bootstrap.apiKey);
        openConfigDialog(false, "channels");
        if (result.status === "created") message.success(t("config.importedChannelCreated", { name: result.channelName }));
        else if (result.status === "updated") message.success(t("config.importedChannelUpdated", { name: result.channelName }));
        else if (result.status === "missing-base-url") message.error(t("config.importedChannelBaseUrlRequired"));
        else message.error(t("config.importedChannelBaseUrlInvalid"));
    }, [importBootstrapCredentials, message, openConfigDialog, t]);

    return <>{children}</>;
}
