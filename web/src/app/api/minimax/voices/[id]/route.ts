import { NextResponse } from "next/server";

import { readJsonBodyResult } from "@/lib/auth/request";
import { getCurrentUser } from "@/lib/auth/session";
import { appendMiniMaxRequestLog, deleteMiniMaxVoiceRecord, listStoredVoices, requestMiniMax, updateMiniMaxRequestLog, updateMiniMaxVoice } from "@/lib/server/minimax-audio-store";

export const runtime = "nodejs";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });
    const id = (await context.params).id;
    const parsed = await readJsonBodyResult<{ name?: string; visible?: boolean }>(request, 16 * 1024);
    if (!parsed.ok) return NextResponse.json({ error: parsed.message }, { status: parsed.status });
    const body = parsed.data;
    const voice = await updateMiniMaxVoice(id, user.id, { name: body.name?.trim().slice(0, 80), visible: typeof body.visible === "boolean" ? body.visible : undefined });
    return voice ? NextResponse.json({ voice }) : NextResponse.json({ error: "音色不存在" }, { status: 404 });
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });
    const id = (await context.params).id;
    const voice = (await listStoredVoices(user.id)).find((item) => item.id === id);
    if (!voice) return NextResponse.json({ error: "音色不存在" }, { status: 404 });
    const log = await appendMiniMaxRequestLog({ userId: user.id, capability: "voice", method: "POST", path: "/v1/delete_voice", model: "voice-delete", statusCode: 0, durationMs: 0, phase: "queued", requestPreview: JSON.stringify({ mode: "voice-delete", voiceType: voice.voiceType }), lifecycle: [{ at: new Date().toISOString(), phase: "queued", message: "删除音色请求已提交" }] }).catch(() => undefined);
    const startedAt = Date.now();
    if (log) await updateMiniMaxRequestLog(log.id, { statusCode: 0, durationMs: 0, phase: "running", lifecycle: [{ at: new Date().toISOString(), phase: "running", message: "正在删除 MiniMax 云端音色" }] }).catch(() => undefined);
    let statusCode = 0;
    try {
        const response = await requestMiniMax("/v1/delete_voice", { method: "POST", body: JSON.stringify({ voice_type: voice.voiceType, voice_id: voice.remoteVoiceId }) });
        statusCode = response.status;
        const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        const code = Number((payload.base_resp as Record<string, unknown> | undefined)?.status_code || 0);
        const error = String((payload.base_resp as Record<string, unknown> | undefined)?.status_msg || "删除 MiniMax 音色失败");
        if (!response.ok || code !== 0) {
            if (log) await updateMiniMaxRequestLog(log.id, { statusCode, durationMs: Date.now() - startedAt, phase: "failed", error, lifecycle: [{ at: new Date().toISOString(), phase: "failed", message: error }] }).catch(() => undefined);
            return NextResponse.json({ error }, { status: response.status || 502 });
        }
        await deleteMiniMaxVoiceRecord(id, user.id);
        if (log) await updateMiniMaxRequestLog(log.id, { statusCode, durationMs: Date.now() - startedAt, phase: "success", responsePreview: "MiniMax 云端音色已删除", lifecycle: [{ at: new Date().toISOString(), phase: "success", message: "音色删除完成" }] }).catch(() => undefined);
        return NextResponse.json({ ok: true });
    } catch (error) {
        const message = error instanceof Error ? error.message : "删除 MiniMax 音色失败";
        if (log) await updateMiniMaxRequestLog(log.id, { statusCode, durationMs: Date.now() - startedAt, phase: "failed", error: message.slice(0, 500), lifecycle: [{ at: new Date().toISOString(), phase: "failed", message: message.slice(0, 200) }] }).catch(() => undefined);
        return NextResponse.json({ error: message }, { status: statusCode || 502 });
    }
}
