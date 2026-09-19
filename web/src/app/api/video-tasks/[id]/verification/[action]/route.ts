import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import { readJsonBodyResult } from "@/lib/auth/request";
import { getVideoTask } from "@/lib/server/video-task-store";
import { getStoredGenerationTaskRecord } from "@/lib/server/generation-task-store";
import { dolaRuntimeRequest } from "@/lib/server/dola/provider";
import { releaseDolaAccountAttempt } from "@/lib/server/dola/account-service";
import { markDolaRequestLogRunning, openDolaRequestLog, settleDolaRequestLog, type DolaRequestLifecycleEntry } from "@/lib/server/dola/log-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string; action: string }> };

export async function POST(request: Request, context: Context) {
    const user = await getCurrentUser(request);
    if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });
    const { id, action } = await context.params;
    if (!/^(open|input|resume|close)$/.test(action)) return NextResponse.json({ error: "验证操作不存在" }, { status: 404 });
    const task = await getVideoTask(id);
    if (!task || (task.userId !== user.id && user.role !== "admin")) return NextResponse.json({ error: "视频任务不存在" }, { status: 404 });
    const schedule = await getStoredGenerationTaskRecord("video", task.id);
    const payload = schedule?.resultPayload && typeof schedule.resultPayload === "object" ? schedule.resultPayload : {};
    const verificationId = typeof payload.verificationId === "string" ? payload.verificationId : "";
    if (!verificationId) return NextResponse.json({ error: "当前任务没有待处理的 Dola 验证" }, { status: 409 });
    let body: Record<string, unknown> = {};
    if (action !== "open") {
        const parsed = await readJsonBodyResult<Record<string, unknown>>(request);
        if (!parsed.ok) return NextResponse.json({ error: parsed.message }, { status: parsed.status });
        body = parsed.data;
        if (typeof body.leaseToken !== "string" || body.leaseToken.length < 16) return NextResponse.json({ error: "验证租约无效" }, { status: 400 });
        if (action === "input" && (body.action !== "down" && body.action !== "move" && body.action !== "up" || typeof body.x !== "number" || typeof body.y !== "number")) return NextResponse.json({ error: "滑块坐标或动作无效" }, { status: 400 });
    }
    const started = Date.now();
    const verificationPath = `/v1/verifications/${encodeURIComponent(verificationId)}/${action}`;
    const lifecycle: DolaRequestLifecycleEntry[] = [{
        time: new Date(started).toISOString(),
        phase: "queued",
        message: `提交用户验证操作：${action}`,
        durationMs: 0,
        detail: `任务: ${task.upstream.id || task.id}`,
    }];
    let logId = "";
    try {
        logId = await openDolaRequestLog({
            source: "runtime",
            capability: "video",
            method: "POST",
            path: verificationPath,
            model: task.upstream.model || "",
            ...(task.upstream.accountId ? { accountId: task.upstream.accountId } : {}),
            taskId: task.upstream.id || undefined,
            verificationId: verificationId.slice(0, 300),
            requestPreview: JSON.stringify(verificationRequestSummary(action, body)),
            requestBytes: new TextEncoder().encode(JSON.stringify(body)).byteLength,
            clientIp: request.headers.get("x-forwarded-for")?.split(",", 1)[0]?.trim() || request.headers.get("x-real-ip") || undefined,
            userAgent: request.headers.get("user-agent") || undefined,
            headers: { "content-type": "application/json", accept: request.headers.get("accept") || "" },
            ...(task.upstream.proxyMode ? { proxyEgress: task.upstream.proxyMode === "managed" ? { mode: "generic" as const, ...(task.upstream.proxyTarget ? { nodeName: task.upstream.proxyTarget } : {}) } : { mode: "direct" as const } } : {}),
            lifecycle,
        });
        await markDolaRequestLogRunning(logId, { phase: "upstream", message: "向 Dola Provider 发起验证操作", detail: "租约令牌仅用于服务端转发" });
    } catch (error) {
        console.error("Failed to open Dola user verification request log", error);
    }
    lifecycle.push({ time: new Date().toISOString(), phase: "upstream", message: "向 Dola Provider 发起验证操作", durationMs: Date.now() - started, detail: "租约令牌仅用于服务端转发" });
    try {
        const upstream = await dolaRuntimeRequest(verificationPath, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        const bytes = new Uint8Array(await upstream.arrayBuffer());
        const response = parseRecord(bytes);
        const phase = upstream.ok ? "success" : "failed";
        const errorMessage = upstream.ok ? "" : stringValue(response?.error || response?.detail) || "Dola 验证操作失败";
        lifecycle.push({ time: new Date().toISOString(), phase, message: upstream.ok ? "验证操作已返回" : "验证操作失败", durationMs: Date.now() - started, detail: `HTTP ${upstream.status}` });
        if (logId) await settleDolaRequestLog(logId, { statusCode: upstream.status, durationMs: Date.now() - started, phase, ...(errorMessage ? { error: errorMessage } : {}), responsePreview: summarizeResponse(response, bytes), responseBytes: bytes.byteLength, contentType: upstream.headers.get("content-type") || undefined, taskId: task.upstream.id || undefined, verificationId: verificationId.slice(0, 300), lifecycle });
        if (action === "close" && task.config.advancedConfig?.protocol === "dola" && task.upstream.accountId) await releaseDolaAccountAttempt(task.upstream.accountId).catch(() => undefined);
        return NextResponse.json(response, { status: upstream.status });
    } catch (error) {
        const message = error instanceof Error ? error.message : "Dola 验证服务不可用";
        lifecycle.push({ time: new Date().toISOString(), phase: "failed", message, durationMs: Date.now() - started });
        if (logId) await settleDolaRequestLog(logId, { statusCode: 502, durationMs: Date.now() - started, phase: "failed", error: message, taskId: task.upstream.id || undefined, verificationId: verificationId.slice(0, 300), lifecycle });
        return NextResponse.json({ error: message }, { status: 502 });
    }
}

function verificationRequestSummary(action: string, body: Record<string, unknown>) {
    return {
        action,
        ...(action === "input" ? { inputAction: body.action, x: body.x, y: body.y } : {}),
    };
}

function parseRecord(bytes: Uint8Array) {
    try {
        const value = JSON.parse(new TextDecoder().decode(bytes));
        return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
    } catch {
        return null;
    }
}

function stringValue(value: unknown) {
    return typeof value === "string" ? value.slice(0, 800) : "";
}

function summarizeResponse(value: Record<string, unknown> | null, bytes: Uint8Array) {
    if (!value) return bytes.byteLength ? "Dola 验证响应无法解析" : "";
    const summary = Object.fromEntries(Object.entries(value).filter(([key]) => !/cookie|token|secret|password|base64|dataurl|video_?url/i.test(key)));
    const rendered = JSON.stringify(summary, null, 2);
    return rendered.length > 4_000 ? `${rendered.slice(0, 4_000)}…` : rendered;
}
