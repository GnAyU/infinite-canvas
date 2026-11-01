import { App, Button } from "antd";
import { LocalAgentPanel } from "@/components/agent/local-agent-panel";
import { COMPANION_UNSUPPORTED } from "@/services/api/canvas-agent";
import { useConfigStore } from "@/stores/use-config-store";

export function ConfigLocalProxy() {
    const { modal } = App.useApp();
    return (
        <section className="text-sm">
            <p>{COMPANION_UNSUPPORTED}</p>
            <p>服务商请求由浏览器直接发送；依赖本地代理解决跨域的渠道将报错，请配置支持浏览器直连的渠道。</p>
            <Button type="text" danger onClick={() => modal.confirm({
                title: "忘记旧代理设置？",
                content: "仅清除此浏览器保存的代理开关与地址，无法撤销；不会删除渠道、API Key、WebDAV 或其他数据。",
                okText: "确认忘记",
                cancelText: "取消",
                okType: "danger",
                onOk: () => {
                    const { config } = useConfigStore.getState();
                    useConfigStore.setState({ config: { ...config, proxyEnabled: false, proxyUrl: "" } });
                },
            })}>忘记旧代理设置</Button>
            <LocalAgentPanel embedded />
        </section>
    );
}
