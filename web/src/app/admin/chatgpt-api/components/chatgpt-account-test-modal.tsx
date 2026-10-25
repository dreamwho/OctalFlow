"use client";

import { Alert, Button, Input, Modal, Radio, Select, Spin, Tag } from "antd";
import { useEffect, useRef, useState } from "react";

import type { ChatGptAccount, ChatGptAccountTestResult, ChatGptModelCatalog } from "@/services/api/chatgpt-api";
import { imagePreviewUrl } from "@/lib/media-image-url";
import { submitChatGptAccountTest } from "../account-test";

type Mode = "chat" | "image";
const defaultPrompt: Record<Mode, string> = { chat: "请回复：测试成功", image: "画一个纯白背景上的红色苹果，无文字" };

export function ChatGptAccountTestModal({ account, catalog, initialMode, onClose }: { account: ChatGptAccount | null; catalog: ChatGptModelCatalog | null; initialMode: Mode; onClose: () => void }) {
    const [mode, setMode] = useState<Mode>(initialMode);
    const [model, setModel] = useState("");
    const [prompt, setPrompt] = useState(defaultPrompt.chat);
    const [busy, setBusy] = useState(false);
    const [result, setResult] = useState<ChatGptAccountTestResult | null>(null);
    const [error, setError] = useState("");
    const inFlight = useRef(false);
    const models = mode === "chat" ? catalog?.chat_models || [] : catalog?.image_models || [];

    useEffect(() => {
        if (!account) return;
        setMode(initialMode);
        setModel("");
        setPrompt(defaultPrompt[initialMode]);
        setResult(null);
        setError("");
    }, [account?.id, initialMode]);

    const changeMode = (next: Mode) => {
        setMode(next);
        setModel("");
        setPrompt(defaultPrompt[next]);
        setResult(null);
        setError("");
    };
    const close = () => {
        if (busy) return;
        onClose();
        setMode(initialMode);
        setModel("");
        setPrompt(defaultPrompt[initialMode]);
        setResult(null);
        setError("");
    };
    const submit = async () => {
        if (!account || !model || !prompt.trim() || inFlight.current) return;
        setBusy(true);
        setError("");
        setResult(null);
        try {
            setResult(await submitChatGptAccountTest({ accountId: account.id, mode, model, prompt, inFlight: inFlight }));
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : "账号测试请求失败");
        } finally {
            inFlight.current = false;
            setBusy(false);
        }
    };

    return (
        <Modal
            title="GPTAPI 账号测试"
            open={Boolean(account)}
            onCancel={close}
            footer={null}
            width={680}
            style={{ maxWidth: "calc(100vw - 24px)" }}
            closable={!busy}
            maskClosable={!busy}
            keyboard={!busy}
            destroyOnHidden
        >
            {account ? (
                <div className="space-y-4" data-account-test-modal>
                    <Alert type="warning" showIcon message="真实上游测试会消耗账号额度，请确认后手动开始。" />
                    <div className="grid gap-3 sm:grid-cols-2">
                        <div>
                            <div className="mb-1 text-sm text-zinc-500">测试账号</div>
                            <Input aria-label="测试账号" value={`${account.display_name}${account.email ? ` · ${account.email}` : ""}`} readOnly />
                        </div>
                        <div>
                            <div className="mb-1 text-sm text-zinc-500">测试方式</div>
                            <Radio.Group value={mode} onChange={(event) => changeMode(event.target.value as Mode)} disabled={busy} optionType="button" buttonStyle="solid" className="w-full">
                                <Radio.Button value="chat">文本测试</Radio.Button>
                                <Radio.Button value="image">图片测试</Radio.Button>
                            </Radio.Group>
                        </div>
                    </div>
                    {mode === "image" && catalog?.warnings?.length ? <Alert type="info" showIcon message="模型目录提示" description={catalog.warnings.join("；")} /> : null}
                    <div>
                        <div className="mb-1 text-sm text-zinc-500">当前目录中的{mode === "chat" ? "文本" : "图片"}模型</div>
                        <Select
                            aria-label="测试模型"
                            value={model || undefined}
                            options={models.map((value) => ({ value, label: value }))}
                            placeholder="选择模型"
                            showSearch
                            optionFilterProp="label"
                            onChange={(value) => { setModel(value); setResult(null); }}
                            disabled={busy}
                            className="w-full"
                        />
                    </div>
                    <div>
                        <div className="mb-1 text-sm text-zinc-500">测试提示词</div>
                        <Input.TextArea aria-label="测试提示词" value={prompt} onChange={(event) => { setPrompt(event.target.value); setResult(null); }} rows={3} disabled={busy} />
                    </div>
                    {busy ? <div className="flex items-center gap-2 text-sm text-zinc-500"><Spin size="small" />正在等待该账号的真实上游响应</div> : null}
                    {error ? <Alert type="error" showIcon message="测试请求失败" description={error} /> : null}
                    {result ? (
                        <section aria-live="polite" className="space-y-2 rounded-lg border border-zinc-200 p-3 dark:border-zinc-700" data-account-test-result>
                            <div className="flex flex-wrap items-center gap-2">
                                <Tag color={result.status === "success" ? "success" : "error"}>{result.status === "success" ? "测试成功" : "测试失败"}</Tag>
                                {result.account_label ? <span>{result.account_label}</span> : null}
                                {result.model ? <span>{result.model}</span> : null}
                                {typeof result.duration_ms === "number" ? <span className="text-zinc-500">{result.duration_ms} ms</span> : null}
                                {result.call_id ? <span className="break-all text-xs text-zinc-500">调用 ID：{result.call_id}</span> : null}
                            </div>
                            {result.status === "failed" ? <Alert type="error" showIcon message={result.error_code || "上游测试失败"} description={result.error_message || result.content || "接口返回失败状态。"} /> : null}
                            {result.status === "success" && result.mode === "chat" && result.content ? <pre className="whitespace-pre-wrap break-words text-sm">{result.content}</pre> : null}
                            {result.status === "success" && result.mode === "image" ? (result.image_urls || []).map((url, index) => <img key={`${index}:${url.slice(0, 40)}`} src={imagePreviewUrl(url, 640)} alt={`测试生成图片 ${index + 1}`} className="max-h-96 max-w-full rounded-md object-contain" />) : null}
                        </section>
                    ) : null}
                    <div className="flex justify-end gap-2">
                        <Button onClick={close} disabled={busy}>关闭</Button>
                        <Button type="primary" onClick={() => void submit()} disabled={busy || !models.length || !model || !prompt.trim()} loading={busy}>开始真实测试</Button>
                    </div>
                </div>
            ) : null}
        </Modal>
    );
}
