import { App, Button } from "antd";
import { COMPANION_UNSUPPORTED } from "@/services/api/canvas-agent";
import { useAgentStore } from "@/stores/use-agent-store";

/** No bootstrap, discovery, SSE, reconnect, or attachment transport in this configuration. */
export function LocalAgentPanel({ headless }: { embedded?: boolean; headless?: boolean; autoConnect?: boolean }) {
    const { modal } = App.useApp();
    if (headless) return null;
    return (
        <section className="p-4 text-sm">
            <p>{COMPANION_UNSUPPORTED}</p>
            <Button type="text" danger onClick={() => modal.confirm({
                title: "忘记旧 Agent 连接信息？",
                content: "仅删除此浏览器保存的 Agent 地址和连接令牌，无法撤销；不会删除画布、素材、对话或远端数据。",
                okText: "确认忘记",
                cancelText: "取消",
                okType: "danger",
                onOk: () => {
                    localStorage.removeItem("canvas-agent-url");
                    localStorage.removeItem("canvas-agent-token");
                    useAgentStore.getState().disconnectAgent({ url: "", token: "" });
                },
            })}>忘记旧 Agent 连接信息</Button>
        </section>
    );
}
