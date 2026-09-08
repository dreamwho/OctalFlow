"use client";

import { Alert, Button, Drawer, Spin, Tag } from "antd";
import { useEffect, useState } from "react";
import { chatGptApiRequest } from "@/services/api/chatgpt-api";
import { ACCOUNT_OPERATION_PROGRESS_POLL_INTERVAL_MS } from "./use-account-operation-progress";

type Detail = {
    id: string; model?: string; endpoint?: string; started_at?: string; ended_at?: string;
    display_status?: string; summary?: string; public_error?: string;
    request_text?: string; request_text_full?: string; upstream_text?: string;
    presentation?: { status?: { label?: string }; duration?: { text?: string } };
    request_meta?: { lifecycle?: Array<{ time: string; status: string; message: string }> };
    detail_presentation?: { primary_fields?: Array<{ label: string; value: string }>; diagnostic_fields?: Array<{ label: string; value: string }> };
};

export function ChatGptLogDetail({ id, onClose }: { id: string | null; onClose: () => void }) {
    const [detail, setDetail] = useState<Detail | null>(null);
    const [error, setError] = useState("");
    const [revision, setRevision] = useState(0);
    useEffect(() => {
        if (!id) return;
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        setDetail(null);
        setError("");
        const read = async () => {
            try {
                const next = await chatGptApiRequest<Detail>(`logs/${encodeURIComponent(id)}`, { signal: controller.signal });
                if (controller.signal.aborted) return;
                setDetail(next);
                if (["queued", "running"].includes(next.display_status || "")) timer = setTimeout(() => void read(), ACCOUNT_OPERATION_PROGRESS_POLL_INTERVAL_MS);
            } catch (reason) {
                if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "读取日志详情失败");
            }
        };
        void read();
        return () => { controller.abort(); if (timer) clearTimeout(timer); };
    }, [id, revision]);
    const current = detail?.id === id ? detail : null;
    return <Drawer title="请求日志详情" open={Boolean(id)} onClose={onClose} size={640} styles={{ wrapper: { maxWidth: "100vw" } }}>
        <div className="space-y-4 break-words">
            {error ? <Alert type="error" showIcon title={error} action={<Button onClick={() => setRevision((value) => value + 1)}>重新连接</Button>} /> : null}
            {!current && !error ? <Spin description="读取日志详情" /> : null}
            {current ? <>
                <div><Tag color={["queued", "running"].includes(current.display_status || "") ? "processing" : "default"}>{current.presentation?.status?.label || current.display_status}</Tag>{current.presentation?.duration?.text}</div>
                <div className="text-sm">{current.summary}</div>
                <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
                    {[["请求 ID", current.id], ["模型", current.model], ["接口", current.endpoint], ["提交时间", current.started_at], ["结束时间", current.ended_at || "尚未结束"], ...(current.detail_presentation?.primary_fields || []).map((field) => [field.label, field.value])].map(([label, value], index) => <div key={index}><dt className="text-zinc-500">{label}</dt><dd className="mt-1 whitespace-pre-wrap break-all">{value || "—"}</dd></div>)}
                </dl>
                <section><h3 className="mb-2 font-medium">过程日志</h3><ol className="space-y-2 text-sm">{current.request_meta?.lifecycle?.map((event, index) => <li key={index}><span className="text-zinc-500">{event.time}</span> · {event.message}</li>) || <li>此记录未包含阶段日志</li>}</ol></section>
                {[["请求内容", current.request_text_full || current.request_text], ["错误详情", current.public_error], ["上游响应", current.upstream_text], ...(current.detail_presentation?.diagnostic_fields || []).map((field) => [field.label, field.value])].filter(([, value]) => value).map(([label, value], index) => <section key={index}><h3 className="mb-2 font-medium">{label}</h3><pre className="whitespace-pre-wrap break-all rounded-lg border border-zinc-200 p-3 text-xs dark:border-zinc-800">{value}</pre></section>)}
            </> : null}
        </div>
    </Drawer>;
}
