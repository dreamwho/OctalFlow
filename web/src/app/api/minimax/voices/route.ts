import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import { readJsonBodyResult } from "@/lib/auth/request";
import { appendMiniMaxRequestLog, fetchMiniMaxVoiceCatalog, isMiniMaxVoiceFeatureEnabled, isVoiceSubmissionUncertain, listAllStoredVoices, listStoredVoices, markVoiceSubmissionNeedsReview, mergeMiniMaxVoiceCatalog, requestMiniMax, saveMiniMaxVoice, updateMiniMaxRequestLog } from "@/lib/server/minimax-audio-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });
    const [personal, stored] = await Promise.all([listStoredVoices(user.id), listAllStoredVoices()]);
    let catalog;
    try {
        catalog = await fetchMiniMaxVoiceCatalog(user.id);
    } catch (error) {
        return NextResponse.json({ error: error instanceof Error ? error.message : "MiniMax 音色查询失败" }, { status: 502 });
    }
    return NextResponse.json({
        system: mergeMiniMaxVoiceCatalog(catalog.system, stored),
        remotePersonal: [...catalog.cloning, ...catalog.generation],
        personal,
    });
}

export async function POST(request: Request) {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });
    const parsed = await readJsonBodyResult<{ kind?: string; name?: string; prompt?: string; previewText?: string; voiceId?: string }>(request, 64 * 1024);
    if (!parsed.ok) return NextResponse.json({ error: parsed.message }, { status: parsed.status });
    const body = parsed.data;
    if (body.kind !== "design") return NextResponse.json({ error: "音色复刻请使用文件上传接口" }, { status: 400 });
    if (!(await isMiniMaxVoiceFeatureEnabled("voice-design"))) return NextResponse.json({ error: "MiniMax 音色设计已在控制台关闭，请改用阿里云百炼模型" }, { status: 403 });
    const prompt = String(body.prompt || "").trim();
    const previewText = String(body.previewText || "").trim();
    if (!prompt || !previewText) return NextResponse.json({ error: "音色设计需要填写描述和试听文本" }, { status: 400 });
    const log = await appendMiniMaxRequestLog({ userId: user.id, capability: "voice", method: "POST", path: "/v1/voice_design", model: "voice-design", statusCode: 0, durationMs: 0, phase: "queued", requestPreview: JSON.stringify({ mode: "voice-design" }), lifecycle: [{ at: new Date().toISOString(), phase: "queued", message: "音色设计请求已提交" }] }).catch(() => undefined);
    const startedAt = Date.now();
    if (log) await updateMiniMaxRequestLog(log.id, { statusCode: 0, durationMs: 0, phase: "running", lifecycle: [{ at: new Date().toISOString(), phase: "running", message: "正在调用 MiniMax 音色设计接口" }] }).catch(() => undefined);
    let statusCode = 0;
    try {
        const response = await requestMiniMax("/v1/voice_design", { method: "POST", body: JSON.stringify({ prompt, preview_text: previewText }) });
        statusCode = response.status;
        const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        const voiceId = readString(payload, "voice_id") || String(body.voiceId || "").trim();
        const error = readError(payload, response.status);
        if (!response.ok || !voiceId) {
            if (isVoiceSubmissionUncertain(statusCode, response.ok && !voiceId)) {
                const review = "MiniMax 音色设计提交结果待确认，请先查看请求日志，确认前不要重复提交";
                await markVoiceSubmissionNeedsReview(log?.id, startedAt, review, statusCode);
                return NextResponse.json({ error: review, needsReview: true, logId: log?.id }, { status: 409 });
            }
            if (log) await updateMiniMaxRequestLog(log.id, { statusCode, durationMs: Date.now() - startedAt, phase: "failed", error, lifecycle: [{ at: new Date().toISOString(), phase: "failed", message: error }] }).catch(() => undefined);
            return NextResponse.json({ error }, { status: response.status || 502 });
        }
        const name = String(body.name || "我的音色").trim().slice(0, 80) || "我的音色";
        const description = String(body.prompt || "").trim().slice(0, 500);
        const voice = await saveMiniMaxVoice({ userId: user.id, remoteVoiceId: voiceId, name, voiceName: name, description, providerCreatedTime: "", voiceType: "voice_generation", visible: true, category: "其他" });
        if (log) await updateMiniMaxRequestLog(log.id, { statusCode, durationMs: Date.now() - startedAt, phase: "success", responsePreview: "MiniMax 音色设计完成并已保存", lifecycle: [{ at: new Date().toISOString(), phase: "success", message: "音色设计完成" }] }).catch(() => undefined);
        return NextResponse.json({ voice });
    } catch (error) {
        const message = error instanceof Error ? error.message : "MiniMax 音色设计失败";
        if (isVoiceSubmissionUncertain(statusCode)) {
            const review = "MiniMax 音色设计提交结果待确认，请先查看请求日志，确认前不要重复提交";
            await markVoiceSubmissionNeedsReview(log?.id, startedAt, review, statusCode);
            return NextResponse.json({ error: review, needsReview: true, logId: log?.id }, { status: 409 });
        }
        if (log) await updateMiniMaxRequestLog(log.id, { statusCode, durationMs: Date.now() - startedAt, phase: "failed", error: message.slice(0, 500), lifecycle: [{ at: new Date().toISOString(), phase: "failed", message: message.slice(0, 200) }] }).catch(() => undefined);
        return NextResponse.json({ error: message }, { status: statusCode || 502 });
    }
}

function readString(value: Record<string, unknown>, key: string) {
    const item = value[key];
    return typeof item === "string" || typeof item === "number" ? String(item).trim() : "";
}

function readError(payload: Record<string, unknown>, status: number) {
    const base = payload.base_resp as Record<string, unknown> | undefined;
    return String(base?.status_msg || payload.message || payload.msg || `MiniMax 音色接口失败（${status || 502}）`);
}
