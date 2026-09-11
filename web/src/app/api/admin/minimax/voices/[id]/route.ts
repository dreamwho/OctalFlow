import { NextResponse } from "next/server";

import { readJsonBodyResult } from "@/lib/auth/request";
import { getCurrentUser } from "@/lib/auth/session";
import { hasAnyAdminPermission } from "@/lib/admin-permissions";
import { MINIMAX_VOICE_CATEGORIES, type MiniMaxVoiceCategory } from "@/lib/minimax-audio";
import { appendMiniMaxRequestLog, deleteMiniMaxVoiceRecord, getMiniMaxVoiceRecord, requestMiniMax, updateMiniMaxRequestLog, updateMiniMaxVoice } from "@/lib/server/minimax-audio-store";

export const runtime = "nodejs";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
    const user = await getCurrentUser();
    if (!user || !hasAnyAdminPermission(user)) return NextResponse.json({ error: "需要管理员权限" }, { status: user ? 403 : 401 });
    const parsed = await readJsonBodyResult<{ name?: string; category?: string; visible?: boolean }>(request, 16 * 1024);
    if (!parsed.ok) return NextResponse.json({ error: parsed.message }, { status: parsed.status });
    const body = parsed.data;
    const category = MINIMAX_VOICE_CATEGORIES.includes(body.category as MiniMaxVoiceCategory) ? (body.category as MiniMaxVoiceCategory) : undefined;
    const voice = await updateMiniMaxVoice((await context.params).id, undefined, { name: body.name?.trim().slice(0, 80), category, visible: typeof body.visible === "boolean" ? body.visible : undefined });
    return voice ? NextResponse.json({ voice }) : NextResponse.json({ error: "音色不存在" }, { status: 404 });
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
    const user = await getCurrentUser();
    if (!user || !hasAnyAdminPermission(user)) return NextResponse.json({ error: "需要管理员权限" }, { status: user ? 403 : 401 });
    const id = (await context.params).id;
    const voice = await getMiniMaxVoiceRecord(id);
    if (!voice) return NextResponse.json({ error: "音色不存在" }, { status: 404 });
    if (voice.voiceType !== "system") {
        const log = await appendMiniMaxRequestLog({ userId: user.id, capability: "voice", method: "POST", path: "/v1/delete_voice", model: "voice-delete", statusCode: 0, durationMs: 0, phase: "queued", requestPreview: JSON.stringify({ mode: "voice-delete", voiceType: voice.voiceType }), lifecycle: [{ at: new Date().toISOString(), phase: "queued", message: "管理员删除音色请求已提交" }] }).catch(() => undefined);
        const startedAt = Date.now();
        if (log) await updateMiniMaxRequestLog(log.id, { statusCode: 0, durationMs: 0, phase: "running", lifecycle: [{ at: new Date().toISOString(), phase: "running", message: "正在删除 MiniMax 云端音色" }] }).catch(() => undefined);
        let statusCode = 0;
        try {
            const response = await requestMiniMax("/v1/delete_voice", { method: "POST", body: JSON.stringify({ voice_type: voice.voiceType, voice_id: voice.remoteVoiceId }) });
            statusCode = response.status;
            const payload = (await response.json().catch(() => ({}))) as { base_resp?: { status_code?: number; status_msg?: string } };
            const error = payload.base_resp?.status_msg || "删除 MiniMax 云端音色失败";
            if (!response.ok || Number(payload.base_resp?.status_code || 0) !== 0) {
                if (log) await updateMiniMaxRequestLog(log.id, { statusCode, durationMs: Date.now() - startedAt, phase: "failed", error, lifecycle: [{ at: new Date().toISOString(), phase: "failed", message: error }] }).catch(() => undefined);
                return NextResponse.json({ error }, { status: response.status || 502 });
            }
            if (log) await updateMiniMaxRequestLog(log.id, { statusCode, durationMs: Date.now() - startedAt, phase: "success", responsePreview: "MiniMax 云端音色已删除", lifecycle: [{ at: new Date().toISOString(), phase: "success", message: "音色删除完成" }] }).catch(() => undefined);
        } catch (error) {
            const message = error instanceof Error ? error.message : "删除 MiniMax 音色失败";
            if (log) await updateMiniMaxRequestLog(log.id, { statusCode, durationMs: Date.now() - startedAt, phase: "failed", error: message.slice(0, 500), lifecycle: [{ at: new Date().toISOString(), phase: "failed", message: message.slice(0, 200) }] }).catch(() => undefined);
            return NextResponse.json({ error: message }, { status: statusCode || 502 });
        }
    }
    return NextResponse.json({ ok: await deleteMiniMaxVoiceRecord(id) });
}
