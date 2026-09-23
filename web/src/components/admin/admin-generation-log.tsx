"use client";

import { Button, Checkbox, Popconfirm, Tag } from "antd";
import { Eye, Film, Image as ImageIcon, Trash2 } from "lucide-react";

import { DreamyoIcon } from "@/components/ui/dreamyo-icon";
import { browserReadableMediaUrl } from "@/lib/browser-media-url";
import { AdminAccountId } from "@/components/admin/admin-user-identity";
import { imagePreviewUrl } from "@/lib/media-image-url";
import type { StoredGenerationLog } from "@/lib/server/generation-log-store";

export function GenerationLogAssetPreview({ log }: { log: StoredGenerationLog }) {
    const asset = log.assets[0];
    const assetUrl = asset ? generationLogAssetAccessUrl(asset) : "";
    if (!assetUrl) {
        return (
            <div className="flex size-12 items-center justify-center rounded-lg border border-stone-200 bg-stone-100 text-stone-400 dark:border-stone-800 dark:bg-stone-900">
                {log.kind === "video" ? <DreamyoIcon name="video" size={20} /> : <DreamyoIcon name="image" size={20} />}
            </div>
        );
    }
    if (asset.type === "video") {
        return <video className="size-12 rounded-lg border border-stone-200 bg-stone-100 object-cover dark:border-stone-800 dark:bg-stone-900" src={assetUrl} muted playsInline preload="metadata" />;
    }
    return <img className="size-12 rounded-lg border border-stone-200 bg-stone-100 object-cover dark:border-stone-800 dark:bg-stone-900" src={imagePreviewUrl(assetUrl, 256)} alt="" loading="lazy" referrerPolicy="no-referrer" />;
}

export function GenerationLogMobileCard({ log, selected, onSelectedChange, onView, onDelete }: { log: StoredGenerationLog; selected: boolean; onSelectedChange: (checked: boolean) => void; onView: () => void; onDelete: () => void }) {
    return (
        <div className="rounded-lg border border-stone-200 bg-white p-3 dark:border-stone-800 dark:bg-stone-950">
            <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] gap-3">
                <Checkbox checked={selected} onChange={(event) => onSelectedChange(event.target.checked)} />
                <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                        <Tag className="m-0" color={log.kind === "video" ? "purple" : "blue"}>
                            {generationKindLabel(log.kind)}
                        </Tag>
                        <span className={generationStatusClass(log.status)}>{generationStatusLabel(log.status)}</span>
                        <span className="text-xs text-stone-500">{generationSourceLabel(log.source)}</span>
                    </div>
                    <div className="mt-2 truncate text-sm font-semibold text-stone-950 dark:text-stone-100">{log.title}</div>
                    <div className="mt-1 line-clamp-2 text-xs leading-5 text-stone-500 dark:text-stone-400">{log.prompt || log.summary}</div>
                    <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-stone-500 dark:text-stone-400">
                        <span>{formatAdminLogTime(log.createdAt)}</span>
                        <span>{log.displayName || log.username}</span>
                        <AdminAccountId accountId={log.accountId} />
                        <span>{formatAdminLogDuration(log.durationMs)}</span>
                    </div>
                </div>
                <GenerationLogAssetPreview log={log} />
            </div>
            <div className="mt-3 flex justify-end gap-2">
                <Button size="small" icon={<Eye className="size-3.5" />} onClick={onView}>
                    详情
                </Button>
                <Popconfirm title="删除这条生成日志？" okText="删除" cancelText="取消" onConfirm={onDelete}>
                    <Button size="small" danger icon={<Trash2 className="size-3.5" />}>
                        删除
                    </Button>
                </Popconfirm>
            </div>
        </div>
    );
}

export function GenerationLogDetail({ log }: { log: StoredGenerationLog }) {
    return (
        <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
                <InfoBox label="用户" value={`${log.displayName || log.username} / ${log.username || "-"}${log.accountId ? ` / ID：${log.accountId}` : ""}`} />
                <InfoBox label="入口" value={generationSourceLabel(log.source)} />
                <InfoBox label="类型" value={generationKindLabel(log.kind)} />
                <InfoBox label="状态" value={generationStatusLabel(log.status)} />
                <InfoBox label="时间" value={formatAdminLogTime(log.createdAt)} />
                <InfoBox label="耗时" value={formatAdminLogDuration(log.durationMs)} />
                <InfoBox label="模型" value={formatGenerationLogModel(log.model)} />
                <InfoBox label="数量" value={`成功 ${log.successCount} / 失败 ${log.failCount} / 共 ${log.count}`} />
            </div>
            <GenerationLogResultSection log={log} />
            <GenerationLogRequestDetails log={log} />
            <div>
                <div className="mb-1 text-sm font-semibold text-stone-950 dark:text-stone-100">提示词</div>
                <div className="max-h-48 overflow-y-auto whitespace-pre-wrap rounded-lg border border-stone-200 bg-stone-50 p-3 text-sm leading-6 text-stone-700 dark:border-stone-800 dark:bg-stone-900 dark:text-stone-200">{log.prompt || "-"}</div>
            </div>
            {log.error ? (
                <div>
                    <div className="mb-1 text-sm font-semibold text-red-600 dark:text-red-300">错误信息</div>
                    <div className="whitespace-pre-wrap rounded-lg border border-red-200 bg-red-50 p-3 text-sm leading-6 text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-200">{log.error}</div>
                </div>
            ) : null}
        </div>
    );
}

function GenerationLogRequestDetails({ log }: { log: StoredGenerationLog }) {
    const snapshot = log.requestSnapshot;
    if (!snapshot) return null;
    const parameters = Object.entries(snapshot.parameters).filter(([, value]) => value !== undefined && value !== "");
    const traces = snapshot.slots.flatMap((slot) => (slot.requestTraces || []).map((trace) => ({ slot, trace })));
    return (
        <section className="space-y-3 rounded-xl border border-stone-200 p-3 dark:border-stone-800">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                    <div className="text-sm font-semibold text-stone-950 dark:text-stone-100">请求详情</div>
                    <div className="mt-1 text-xs text-stone-500 dark:text-stone-400">渠道、协议、HTTP 状态、耗时以及脱敏后的请求和响应摘要。</div>
                </div>
                <Tag className="m-0">{traces.length} 条协议请求</Tag>
            </div>
            {parameters.length ? (
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                    {parameters.map(([key, value]) => <InfoBox key={key} label={generationParameterLabel(key)} value={String(value)} />)}
                </div>
            ) : null}
            {snapshot.references.length ? (
                <div className="rounded-lg border border-stone-200 bg-stone-50 p-3 dark:border-stone-800 dark:bg-stone-900/70">
                    <div className="mb-2 text-xs font-semibold text-stone-700 dark:text-stone-200">参考素材（{snapshot.references.length}）</div>
                    <div className="space-y-1.5">
                        {snapshot.references.map((reference) => (
                            <div key={reference.id} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-stone-600 dark:text-stone-300">
                                <span className="rounded bg-white px-1.5 py-0.5 dark:bg-stone-950">{reference.kind}</span>
                                <span className="min-w-0 truncate" title={reference.name}>{reference.name}</span>
                                <span className="text-stone-400">{reference.mimeType}</span>
                                {reference.bytes !== undefined ? <span className="text-stone-400">{formatAssetBytes(reference.bytes)}</span> : null}
                                {reference.width || reference.height ? <span className="text-stone-400">{[reference.width, reference.height].filter(Boolean).join("×")}</span> : null}
                            </div>
                        ))}
                    </div>
                </div>
            ) : null}
            {snapshot.slots.map((slot) => (
                <div key={slot.id} className="space-y-2 rounded-lg border border-stone-200 bg-white p-3 dark:border-stone-800 dark:bg-stone-950/60">
                    <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium text-stone-800 dark:text-stone-100">结果槽 {slot.index + 1}</span>
                        <Tag className="m-0" color={slot.status === "success" ? "green" : slot.status === "failed" ? "red" : "blue"}>{slot.status === "success" ? "成功" : slot.status === "failed" ? "失败" : "生成中"}</Tag>
                        {slot.taskKind ? <span className="text-xs text-stone-500">{slot.taskKind}</span> : null}
                        {slot.taskProvider ? <span className="text-xs text-stone-500">{slot.taskProvider}</span> : null}
                        {slot.taskModel ? <span className="text-xs text-stone-500">模型：{slot.taskModel}</span> : null}
                    </div>
                    <div className="grid gap-1 text-xs text-stone-500 dark:text-stone-400 sm:grid-cols-2">
                        {slot.clientRequestId ? <div>客户端请求：<code className="break-all">{slot.clientRequestId}</code></div> : null}
                        {slot.taskId ? <div>本地任务：<code className="break-all">{slot.taskId}</code></div> : null}
                        {slot.serverTaskId ? <div>上游任务：<code className="break-all">{slot.serverTaskId}</code></div> : null}
                        {slot.taskPollPath ? <div>查询路径：<code className="break-all">{slot.taskPollPath}</code></div> : null}
                        {slot.error ? <div className="text-red-600 dark:text-red-300">任务错误：{slot.error}</div> : null}
                    </div>
                </div>
            ))}
            {traces.length ? traces.map(({ slot, trace }, index) => (
                <div key={`${slot.id}:${index}`} className="overflow-hidden rounded-lg border border-stone-200 dark:border-stone-800">
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-stone-200 bg-stone-50 px-3 py-2 dark:border-stone-800 dark:bg-stone-900/70">
                        <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2 text-xs text-stone-500 dark:text-stone-400">
                                <span>{trace.channel}</span><span>·</span><span>{trace.protocol}</span><span>·</span><span>{formatAdminLogTime(trace.createdAt)}</span>
                            </div>
                            <div className="mt-1 break-all font-mono text-xs text-stone-800 dark:text-stone-200">{trace.method} {trace.path}</div>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                            <Tag className="m-0" color={trace.statusCode && trace.statusCode < 400 ? "green" : "red"}>{trace.statusCode ? `HTTP ${trace.statusCode}` : "请求失败"}</Tag>
                            <span className="text-xs tabular-nums text-stone-500">{formatAdminLogDuration(trace.durationMs)}</span>
                        </div>
                    </div>
                    <div className="space-y-3 p-3">
                        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-stone-500 dark:text-stone-400">
                            {trace.model ? <span>上游模型：{trace.model}</span> : null}
                            {trace.requestBytes !== undefined ? <span>请求：{formatAssetBytes(trace.requestBytes)}</span> : null}
                            {trace.responseBytes !== undefined ? <span>响应：{formatAssetBytes(trace.responseBytes)}</span> : null}
                            {trace.requestContentType ? <span>请求类型：{trace.requestContentType}</span> : null}
                            {trace.responseContentType ? <span>响应类型：{trace.responseContentType}</span> : null}
                        </div>
                        {trace.error ? <div className="whitespace-pre-wrap rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-200">{trace.error}</div> : null}
                        <div className="grid gap-3 lg:grid-cols-2">
                            <ProtocolTracePane title="请求头（已筛选）" value={trace.requestHeaders} />
                            <ProtocolTracePane title="响应头（安全字段）" value={trace.responseHeaders} />
                            <ProtocolTracePane title="请求内容（已脱敏）" value={trace.requestPreview} />
                            <ProtocolTracePane title="响应内容（已脱敏）" value={trace.responsePreview} />
                        </div>
                    </div>
                </div>
            )) : <div className="rounded-lg border border-dashed border-stone-300 px-3 py-4 text-sm text-stone-500 dark:border-stone-700 dark:text-stone-400">该记录尚未采集到内置协议 HTTP 明细；历史调用记录仍保留上面的参数、素材和任务信息。</div>}
        </section>
    );
}

function ProtocolTracePane({ title, value }: { title: string; value?: string | Record<string, string> }) {
    if (!value) return null;
    const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    return (
        <div className="min-w-0">
            <div className="mb-1 text-xs font-medium text-stone-600 dark:text-stone-300">{title}</div>
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md bg-stone-950 p-2.5 text-[11px] leading-5 text-stone-100">{text}</pre>
        </div>
    );
}

function generationParameterLabel(key: string) {
    const labels: Record<string, string> = { model: "模型", size: "尺寸 / 比例", quality: "画质", count: "数量", resolution: "清晰度", seconds: "时长", generateAudio: "生成音频", watermark: "水印" };
    return labels[key] || key;
}

function GenerationLogResultSection({ log }: { log: StoredGenerationLog }) {
    const assets = (log.assets || []).filter((asset) => Boolean(generationLogAssetAccessUrl(asset)));
    if (!assets.length) {
        return (
            <div className="rounded-lg border border-dashed border-stone-300 bg-stone-50 p-4 dark:border-stone-700 dark:bg-stone-900/70">
                <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-stone-950 dark:text-stone-100">
                    {log.kind === "video" ? <Film className="size-4" /> : <ImageIcon className="size-4" />}
                    生成结果
                </div>
                <div className="text-sm leading-6 text-stone-500 dark:text-stone-400">{log.status === "success" ? "这条日志没有可访问的媒体文件。" : "这条日志没有成功结果，暂无可预览的图片或视频。"}</div>
            </div>
        );
    }

    return (
        <div className="rounded-lg border border-stone-200 p-3 dark:border-stone-800">
            <div className="mb-3 flex items-center justify-between gap-3">
                <div className="text-sm font-semibold text-stone-950 dark:text-stone-100">生成结果</div>
                <Tag className="m-0" color={log.kind === "video" ? "purple" : "blue"}>
                    {assets.length} 个结果
                </Tag>
            </div>
            <div className="space-y-3">
                {assets.map((asset, index) => {
                    const assetUrl = generationLogAssetAccessUrl(asset);
                    return (
                        <div key={`${asset.url}-${index}`} className="grid min-w-0 items-start gap-3 rounded-lg border border-stone-200 bg-white p-3 dark:border-stone-800 dark:bg-stone-950/60 sm:grid-cols-[156px_minmax(0,1fr)]">
                            <div className="min-w-0">
                                <div className="mb-2 flex items-center justify-between gap-2 text-xs font-medium text-stone-500 dark:text-stone-400">
                                    <span>{asset.type === "video" ? `视频 ${index + 1}` : `图片 ${index + 1}`}</span>
                                    {asset.width || asset.height ? <span className="shrink-0 tabular-nums">{[asset.width, asset.height].filter(Boolean).join("x")}</span> : null}
                                </div>
                                <div className="flex h-32 items-center justify-center overflow-hidden rounded-md bg-stone-100 p-2 dark:bg-stone-900 sm:h-36">
                                    {asset.type === "video" ? (
                                        <video className="h-full w-full rounded bg-black object-contain" src={assetUrl} controls playsInline preload="metadata" />
                                    ) : (
                                        <img className="h-full w-full object-contain" src={imagePreviewUrl(assetUrl, 960)} alt="" referrerPolicy="no-referrer" loading="lazy" />
                                    )}
                                </div>
                            </div>
                            <div className="min-w-0 self-center text-sm text-stone-500 dark:text-stone-400">
                                <div>{asset.type === "video" ? "视频" : "图片"}</div>
                                <div className="mt-1 text-xs">{asset.bytes ? formatAssetBytes(asset.bytes) : "大小未记录"}</div>
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

function generationLogAssetAccessUrl(asset: StoredGenerationLog["assets"][number]) {
    const directUrl = asset.url && !asset.url.startsWith("/api/generation-log-assets/") && asset.url !== asset.serverUrl ? asset.url : "";
    const serverUrl = asset.serverUrl || (asset.url?.startsWith("/api/generation-log-assets/") ? asset.url : "");
    return browserReadableMediaUrl(asset.remoteUrl || directUrl || serverUrl || asset.serverUrl || (asset.url?.startsWith("/api/generation-log-assets/") ? asset.url : ""));
}

function formatAssetBytes(bytes: number) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatGenerationLogModel(model: string) {
    const value = (model || "").trim();
    if (!value) return "-";
    const separatorIndex = value.indexOf("::");
    return separatorIndex >= 0 ? value.slice(separatorIndex + 2).trim() || value : value;
}

export function formatAdminLogTime(value: string) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return "-";
    return date.toLocaleString("zh-CN", { hour12: false });
}

export function formatAdminLogDuration(value: number) {
    if (!value) return "-";
    if (value < 1000) return `${Math.round(value)}ms`;
    return `${(value / 1000).toFixed(2)}s`;
}

export function generationKindLabel(value: string) {
    return value === "video" ? "视频" : "图片";
}

export function generationSourceLabel(value: string) {
    if (value === "agent") return "Agent 工作台";
    if (value === "canvas") return "画布";
    if (value === "drama") return "短剧";
    if (value === "video-workbench") return "视频生成";
    if (value === "image-workbench") return "图片生成";
    return "未知入口";
}

export function generationStatusLabel(value: string) {
    if (value === "success") return "成功";
    if (value === "failed") return "失败";
    if (value === "pending") return "生成中";
    return value || "-";
}

export function generationStatusClass(value: string) {
    if (value === "success") return "inline-flex h-6 items-center rounded-md bg-emerald-50 px-2 text-xs font-medium text-emerald-700 ring-1 ring-emerald-200 dark:bg-emerald-500/15 dark:text-emerald-200 dark:ring-emerald-500/25";
    if (value === "failed") return "inline-flex h-6 items-center rounded-md bg-rose-50 px-2 text-xs font-medium text-rose-700 ring-1 ring-rose-200 dark:bg-rose-500/15 dark:text-rose-200 dark:ring-rose-500/25";
    return "inline-flex h-6 items-center rounded-md bg-sky-50 px-2 text-xs font-medium text-sky-700 ring-1 ring-sky-200 dark:bg-sky-500/15 dark:text-sky-200 dark:ring-sky-500/25";
}

function InfoBox({ label, value }: { label: string; value: string }) {
    return (
        <div className="min-w-0 rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 dark:border-stone-800 dark:bg-stone-900">
            <div className="text-xs text-stone-500 dark:text-stone-400">{label}</div>
            <div className="mt-1 truncate text-sm font-medium text-stone-900 dark:text-stone-100" title={value}>
                {value}
            </div>
        </div>
    );
}
