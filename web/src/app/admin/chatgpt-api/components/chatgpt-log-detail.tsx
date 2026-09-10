"use client";

import { Alert, Button, Drawer, Spin, Tag } from "antd";
import { useEffect, useState, type PointerEvent as ReactPointerEvent } from "react";

import { useResizableDrawerWidth } from "@/hooks/use-resizable-drawer";

import { chatGptApiRequest, type ChatGptLogDetail, type ChatGptLogField, type ChatGptLogTimeline } from "@/services/api/chatgpt-api";
import { ACCOUNT_OPERATION_PROGRESS_POLL_INTERVAL_MS } from "./use-account-operation-progress";

function LogDetailResizeHandle({ resizing, onPointerDown }: { resizing: boolean; onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void }) {
    return (
        <div
            role="separator"
            aria-orientation="vertical"
            aria-label="拖动调整侧边栏宽度"
            title="左右拖动调整宽度"
            onPointerDown={onPointerDown}
            className={"absolute left-0 top-0 z-10 h-full w-1.5 cursor-ew-resize transition-colors hover:bg-cyan-400/30" + (resizing ? " bg-cyan-400/40" : "")}
        />
    );
}

export function ChatGptLogDetail({ id, onClose }: { id: string | null; onClose: () => void }) {
    const { width: drawerWidth, resizing: drawerResizing, onHandlePointerDown } = useResizableDrawerWidth({ defaultWidth: 640, minWidth: 420 });
    const [detail, setDetail] = useState<ChatGptLogDetail | null>(null);
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
                const next = await chatGptApiRequest<ChatGptLogDetail>(`logs/${encodeURIComponent(id)}`, { signal: controller.signal });
                if (controller.signal.aborted) return;
                setDetail(next);
                if (["queued", "running"].includes(next.display_status || "")) timer = setTimeout(() => void read(), ACCOUNT_OPERATION_PROGRESS_POLL_INTERVAL_MS);
            } catch (reason) {
                if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "读取日志详情失败");
            }
        };
        void read();
        return () => {
            controller.abort();
            if (timer) clearTimeout(timer);
        };
    }, [id, revision]);

    const current = detail?.id === id ? detail : null;
    const status = current ? detailStatus(current) : null;
    const primaryFields = current ? uniqueFields([...baseFields(current), ...(current.detail_presentation?.primary_fields || [])]) : [];
    const diagnosticFields = current?.detail_presentation?.diagnostic_fields || [];
    const timeline = current?.detail_presentation?.timeline;

    return (
        <Drawer title="请求日志详情" open={Boolean(id)} onClose={onClose} width={drawerWidth} styles={{ body: { padding: 20, position: "relative" } }}>
            <LogDetailResizeHandle resizing={drawerResizing} onPointerDown={onHandlePointerDown} />
            <div className="space-y-5 break-words">
                {error ? <Alert type="error" showIcon title={error} action={<Button onClick={() => setRevision((value) => value + 1)}>重新连接</Button>} /> : null}
                {!current && !error ? <Spin description="读取日志详情" /> : null}
                {current && status ? (
                    <>
                        <div className="flex flex-wrap items-center gap-2">
                            <Tag color={status.color}>
                                {status.label}
                                {current.status_code ? ` · ${current.status_code}` : ""}
                            </Tag>
                            <span className="text-xs text-zinc-500">{formatTime(current.started_at || current.time)}</span>
                            <span className="text-xs text-zinc-500">{current.presentation?.duration?.text || formatDuration(current.duration_ms)}</span>
                        </div>
                        {current.presentation?.summary_text || current.summary ? <p className="text-sm leading-6 text-zinc-700 dark:text-zinc-300">{current.presentation?.summary_text || current.summary}</p> : null}
                        <DetailFields title="请求信息" fields={primaryFields} />
                        <DetailFields title="诊断信息" fields={diagnosticFields} />
                        <RequestTimeline timeline={timeline} lifecycle={current.request_meta?.lifecycle} />
                        <AttemptGroups groups={current.detail_presentation?.attempt_groups} />
                        <AttemptList attempts={current.attempts} />
                        <DetailPreview title="请求内容" value={current.request_text_full || current.request_text} note={current.request_text_truncated ? "内容已按服务端安全上限截断" : undefined} />
                        <DetailPreview title="错误详情" value={current.public_error || current.upstream_error} tone="error" />
                        <DetailPreview title="上游响应" value={current.upstream_text} />
                        <DetailPreview title="请求结构" value={current.request_shape} />
                        <DetailPreview title="响应数据" value={current.response} />
                        <DetailPreview title="请求元数据" value={current.request_meta} />
                        <DetailPreview title="性能数据" value={current.timings_ms || current.perf || current.metrics || current.monitor} />
                    </>
                ) : null}
            </div>
        </Drawer>
    );
}

function baseFields(detail: ChatGptLogDetail): ChatGptLogField[] {
    const fields = [
        field("请求 ID", detail.id),
        field("协议", "OPENAI"),
        field("请求类型", detail.type),
        field("业务类型", detail.business),
        field("接口", detail.endpoint),
        field("模型", detail.model),
        field("实际账号", detail.account_email || "未分配账号"),
        field("API 密钥", detail.key_name || "站内调用"),
        field("角色", detail.role),
        detail.proxy_egress
            ? field(
                  "代理出口",
                  `${detail.proxy_egress.mode === "magic" ? "魔法代理" : "通用代理"}${detail.proxy_egress.node_name ? ` · ${detail.proxy_egress.node_name}` : ""}${detail.proxy_egress.address ? ` · ${detail.proxy_egress.address}` : ""}`,
              )
            : null,
        field("请求状态", detail.display_status || detail.outcome),
        field("状态码", detail.status_code && detail.status_code > 0 ? detail.status_code : undefined),
        field("提交时间", formatTime(detail.started_at || detail.time)),
        field("结束时间", detail.ended_at ? formatTime(detail.ended_at) : "尚未结束"),
        field("耗时", detail.presentation?.duration?.text || formatDuration(detail.duration_ms)),
        field("尝试次数", detail.attempt_count),
        field("账号切换", detail.switch_count ? `${detail.switch_count} 次${detail.recovered_after_switch ? "，已恢复" : ""}` : "0 次"),
        field("会话 ID", detail.conversation_id),
        field("图像结果", imageResultText(detail)),
        field("入口摘要", detail.presentation?.request?.secondary || detail.presentation?.request?.primary),
        field("执行摘要", detail.presentation?.execution?.secondary || detail.presentation?.execution?.primary),
        field("结果摘要", detail.presentation?.result?.text),
    ];
    return fields.filter((item): item is ChatGptLogField => Boolean(item));
}

function field(label: string, value: unknown): ChatGptLogField | null {
    if (value === undefined || value === null || value === "") return null;
    return { label, value: String(value), copyable: label.includes("ID") || label === "模型" || label === "接口" };
}

function uniqueFields(fields: ChatGptLogField[]) {
    const seen = new Set<string>();
    return fields.filter((item) => {
        if (seen.has(item.label)) return false;
        seen.add(item.label);
        return Boolean(item.value);
    });
}

function DetailFields({ title, fields }: { title: string; fields: ChatGptLogField[] }) {
    if (!fields.length) return null;
    return (
        <section>
            <h3 className="mb-2 text-sm font-medium text-zinc-900 dark:text-zinc-100">{title}</h3>
            <dl className="grid grid-cols-[96px_minmax(0,1fr)] gap-x-3 gap-y-3 text-sm">
                {fields.map((item) => (
                    <div key={`${title}-${item.label}`} className={item.wide ? "col-span-2" : "contents"}>
                        <dt className="text-zinc-500">{item.label}</dt>
                        <dd className="whitespace-pre-wrap break-all text-zinc-800 dark:text-zinc-200">{item.value || "—"}</dd>
                    </div>
                ))}
            </dl>
        </section>
    );
}

function RequestTimeline({ timeline, lifecycle }: { timeline?: ChatGptLogTimeline; lifecycle?: NonNullable<ChatGptLogDetail["request_meta"]>["lifecycle"] }) {
    if (!timeline?.groups?.length && !lifecycle?.length) return null;
    return (
        <section>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">过程日志</h3>
                {timeline?.segments?.length ? (
                    <div className="flex flex-wrap gap-1">
                        {timeline.segments.map((segment) => (
                            <Tag key={segment.key}>
                                {segment.label} {segment.value_text}
                            </Tag>
                        ))}
                    </div>
                ) : null}
            </div>
            {timeline?.groups?.length ? (
                <div className="space-y-3">
                    {timeline.groups.map((group) => (
                        <div key={group.key} className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
                            <div className="mb-2 text-xs font-medium text-zinc-700 dark:text-zinc-200">{group.label}</div>
                            <ol className="space-y-2">
                                {group.steps.map((step) => (
                                    <li key={step.key} className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 text-xs">
                                        <div>
                                            <div className="font-medium text-zinc-800 dark:text-zinc-200">
                                                {step.label} <span className="font-normal text-zinc-500">· {step.status_label}</span>
                                            </div>
                                            <div className="mt-0.5 text-zinc-500">
                                                {step.time ? `${step.time} · ` : ""}
                                                {step.description}
                                            </div>
                                        </div>
                                        <span className="text-zinc-500">{step.value_text}</span>
                                    </li>
                                ))}
                            </ol>
                        </div>
                    ))}
                </div>
            ) : (
                <ol className="space-y-2 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
                    {lifecycle?.map((event, index) => (
                        <li key={`${event.time}-${event.status}-${index}`} className="grid grid-cols-[auto_minmax(0,1fr)] gap-3 text-xs">
                            <span className="whitespace-nowrap text-zinc-500">{formatTime(event.time)}</span>
                            <span className="text-zinc-800 dark:text-zinc-200">
                                <strong className="font-medium">{event.message || event.status}</strong>
                                <span className="ml-2 text-zinc-500">{event.status}</span>
                            </span>
                        </li>
                    ))}
                </ol>
            )}
        </section>
    );
}

function AttemptGroups({ groups }: { groups?: NonNullable<ChatGptLogDetail["detail_presentation"]>["attempt_groups"] }) {
    if (!groups?.length) return null;
    return (
        <section>
            <h3 className="mb-2 text-sm font-medium text-zinc-900 dark:text-zinc-100">账号尝试与切换</h3>
            <div className="space-y-2">
                {groups.map((group) => (
                    <div key={`${group.slot}-${group.slot_label}`} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-zinc-200 p-3 text-sm dark:border-zinc-800">
                        <span>{group.slot_label || `第 ${group.slot || "—"} 组`}</span>
                        <span className="text-xs text-zinc-500">
                            {group.attempt_text || `${group.attempt_count || 0} 次尝试`} · {group.switch_text || `${group.switch_count || 0} 次切换`}
                        </span>
                        {group.status?.label ? <Tag color={statusColor(group.status.tone)}>{group.status.label}</Tag> : null}
                    </div>
                ))}
            </div>
        </section>
    );
}

function AttemptList({ attempts }: { attempts?: ChatGptLogDetail["attempts"] }) {
    if (!attempts?.length) return null;
    return (
        <section>
            <h3 className="mb-2 text-sm font-medium text-zinc-900 dark:text-zinc-100">每次上游尝试</h3>
            <div className="space-y-2">
                {attempts.map((attempt, index) => (
                    <div key={`${attempt.slot}-${attempt.attempt}-${index}`} className="rounded-lg border border-zinc-200 p-3 text-xs dark:border-zinc-800">
                        <div className="flex flex-wrap items-center gap-2">
                            <Tag color={statusColor(attempt.presentation?.status?.tone)}>{attempt.presentation?.status?.label || attempt.outcome || attempt.status || "记录"}</Tag>
                            <span className="text-zinc-500">
                                第 {attempt.attempt || index + 1} 次 · {attempt.account_email || "未分配账号"}
                            </span>
                        </div>
                        <div className="mt-2 text-zinc-500">
                            耗时 {formatDuration(attempt.duration_ms)} · 状态码 {attempt.status_code || "—"}
                            {attempt.switched_account ? " · 已切换账号" : ""}
                        </div>
                        {attempt.public_error || attempt.upstream_error || attempt.upstream_text ? (
                            <pre className="mt-2 whitespace-pre-wrap break-all rounded-lg bg-zinc-50 p-2 text-zinc-600 dark:bg-zinc-900 dark:text-zinc-300">{attempt.public_error || attempt.upstream_error || attempt.upstream_text}</pre>
                        ) : null}
                    </div>
                ))}
            </div>
        </section>
    );
}

function DetailPreview({ title, value, tone, note }: { title: string; value?: unknown; tone?: "error"; note?: string }) {
    if (value === undefined || value === null || value === "") return null;
    const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    return (
        <section>
            <div className="mb-2 flex flex-wrap items-center gap-2">
                <h3 className={`text-sm font-medium ${tone === "error" ? "text-red-600 dark:text-red-400" : "text-zinc-900 dark:text-zinc-100"}`}>{title}</h3>
                {note ? <span className="text-xs text-zinc-500">{note}</span> : null}
            </div>
            <pre
                className={`max-h-72 overflow-y-auto whitespace-pre-wrap break-all rounded-lg border p-3 text-xs leading-5 ${tone === "error" ? "border-red-200 bg-red-50 text-red-800 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200" : "border-zinc-200 bg-zinc-50 text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300"}`}
            >
                {text}
            </pre>
        </section>
    );
}

function imageResultText(detail: ChatGptLogDetail) {
    const requested = detail.image_requested_count || 0;
    const succeeded = detail.image_succeeded_count || 0;
    const failed = detail.image_failed_count || 0;
    if (!requested && !succeeded && !failed && !detail.image_result_status) return "";
    return `${detail.image_result_status || "处理中"} · 请求 ${requested} · 成功 ${succeeded} · 失败 ${failed}`;
}

function detailStatus(detail: ChatGptLogDetail) {
    const outcome = detail.outcome || detail.display_status || "";
    if (detail.presentation?.status?.label) return { label: detail.presentation.status.label, color: statusColor(detail.presentation.status.tone || outcome) };
    if (["queued", "running"].includes(outcome)) return { label: outcome === "queued" ? "排队中" : "运行中", color: "processing" as const };
    if (outcome === "success" || ((detail.status_code || 0) < 400 && !detail.public_error)) return { label: "成功", color: "green" as const };
    if (["rate_limited", "limited"].includes(outcome)) return { label: "限流", color: "gold" as const };
    return { label: "失败", color: "red" as const };
}

function statusColor(value?: string) {
    if (["success", "green"].includes(value || "")) return "green" as const;
    if (["warning", "gold", "rate_limited", "limited"].includes(value || "")) return "gold" as const;
    if (["danger", "red", "failed", "error"].includes(value || "")) return "red" as const;
    if (["info", "processing", "running", "queued"].includes(value || "")) return "processing" as const;
    return "default" as const;
}

function formatDuration(value?: number) {
    const milliseconds = Math.max(0, Number(value || 0));
    if (milliseconds < 1000) return `${milliseconds}ms`;
    if (milliseconds < 10000) return `${(milliseconds / 1000).toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}s`;
    if (milliseconds < 60000) return `${(milliseconds / 1000).toFixed(1).replace(/\.0$/, "")}s`;
    return `${(milliseconds / 60000).toFixed(1).replace(/\.0$/, "")}m`;
}

function formatTime(value?: string) {
    if (!value) return "—";
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toLocaleString("zh-CN", { hour12: false }) : value;
}
