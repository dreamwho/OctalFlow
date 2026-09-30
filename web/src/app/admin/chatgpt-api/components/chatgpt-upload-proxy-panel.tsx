"use client";

import { Alert, App, Button, Select, Spin } from "antd";
import { useEffect, useState } from "react";
import { Panel, PanelHeader } from "@/components/admin/admin-panel";
import { getChatGptUploadProxySelection, updateChatGptUploadProxySelection, type ChatGptUploadProxySelection } from "@/services/api/chatgpt-api";
import { getMagicProxy, type MagicProxyNode } from "@/services/api/magic-proxy";

const options: Array<{ value: ChatGptUploadProxySelection["mode"]; label: string }> = [
    { value: "auto", label: "自动：魔法代理可用时使用魔法代理" },
    { value: "magic", label: "始终使用魔法代理" },
    { value: "submit", label: "跟随生成提交出口" },
    { value: "direct", label: "直连上传" },
];

export function ChatGptUploadProxyPanel() {
    const { message } = App.useApp();
    const [selection, setSelection] = useState<ChatGptUploadProxySelection | null>(null);
    const [mode, setMode] = useState<ChatGptUploadProxySelection["mode"]>("auto");
    const [magicNode, setMagicNode] = useState("");
    const [nodes, setNodes] = useState<MagicProxyNode[]>([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");

    useEffect(() => {
        let active = true;
        Promise.all([getChatGptUploadProxySelection(), getMagicProxy().catch(() => null)]).then(([value, magic]) => {
            if (active) { setSelection(value); setMode(value.mode); setMagicNode(value.magicNode || ""); setNodes(magic?.nodes || []); }
        }).catch((reason: unknown) => {
            if (active) setError(reason instanceof Error ? reason.message : "读取上传代理设置失败");
        }).finally(() => { if (active) setLoading(false); });
        return () => { active = false; };
    }, []);

    async function save() {
        setSaving(true);
        setError("");
        try {
            const value = await updateChatGptUploadProxySelection(mode, magicNode);
            setSelection(value);
            message.success("图片上传出口已保存");
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : "保存失败");
        } finally {
            setSaving(false);
        }
    }

    return <Panel>
        <PanelHeader title="图片数据上传出口" description="仅控制签名上传地址的图片二进制 PUT；文件登记、上传确认和生成提交继续使用上方的提交代理。" />
        <div className="space-y-3 p-4 sm:p-6">
            {loading ? <Spin size="small" /> : <div className="flex flex-wrap items-center gap-3">
                <Select aria-label="图片数据上传代理模式" className="min-w-[260px] max-w-full" value={mode} options={options} onChange={setMode} />
                {(mode === "auto" || mode === "magic") ? <Select
                    aria-label="图片上传魔法节点"
                    className="min-w-[220px] max-w-full"
                    value={magicNode}
                    options={[{ value: "", label: "跟随当前魔法节点" }, ...nodes.map((node) => ({ value: node.name, label: node.name }))]}
                    onChange={setMagicNode}
                /> : null}
                <Button type="primary" loading={saving} disabled={!selection || (mode === selection.mode && magicNode === (selection.magicNode || ""))} onClick={() => void save()}>保存上传出口</Button>
            </div>}
            {selection ? <p className="text-xs text-zinc-500 dark:text-zinc-400">{selection.magicConfigured ? "当前魔法节点已就绪；自动模式下图片数据走魔法代理。" : "尚无可用魔法节点；自动模式下图片数据跟随提交出口。"}</p> : null}
            {error ? <Alert type="error" showIcon title={error} /> : null}
        </div>
    </Panel>;
}
