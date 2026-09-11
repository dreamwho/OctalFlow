import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import { classifyMiniMaxVoice } from "@/lib/minimax-audio";
import { appendMiniMaxRequestLog, isMiniMaxVoiceFeatureEnabled, isVoiceSubmissionUncertain, markVoiceSubmissionNeedsReview, requestMiniMax, saveMiniMaxVoice, updateMiniMaxRequestLog } from "@/lib/server/minimax-audio-store";
import { readRequestBodyBytes, RequestBodyTooLargeError } from "@/lib/server/request-body-limit";

export const runtime = "nodejs";

export async function POST(request: Request) {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });
    try {
        const contentType = request.headers.get("content-type") || "";
        if (!contentType.toLowerCase().startsWith("multipart/form-data")) return NextResponse.json({ error: "音色复刻请求格式不正确" }, { status: 400 });
        const bytes = await readRequestBodyBytes(request, 20 * 1024 * 1024 + 64 * 1024);
        const form = await new Response(bytes, { headers: { "content-type": contentType } }).formData();
        const file = form.get("file");
        const name = String(form.get("name") || "我的复刻音色").trim().slice(0, 80) || "我的复刻音色";
        const description = String(form.get("description") || "").trim().slice(0, 500);
        if (!(file instanceof File) || !file.size) return NextResponse.json({ error: "音色复刻需要音频文件" }, { status: 400 });
        if (!(await isMiniMaxVoiceFeatureEnabled("voice-clone"))) return NextResponse.json({ error: "MiniMax 音色复刻已在控制台关闭，请改用阿里云百炼模型" }, { status: 403 });
        if (file.size > 20 * 1024 * 1024) return NextResponse.json({ error: "复刻音频不能超过 20MB" }, { status: 400 });

        const log = await appendMiniMaxRequestLog({ userId: user.id, capability: "voice", method: "POST", path: "/v1/voice_clone", model: "voice-cloning", statusCode: 0, durationMs: 0, phase: "queued", requestPreview: JSON.stringify({ mode: "voice-cloning" }), lifecycle: [{ at: new Date().toISOString(), phase: "queued", message: "音色复刻请求已提交" }] }).catch(() => undefined);
        const startedAt = Date.now();
        if (log) await updateMiniMaxRequestLog(log.id, { statusCode: 0, durationMs: 0, phase: "running", lifecycle: [{ at: new Date().toISOString(), phase: "running", message: "正在上传复刻音频" }] }).catch(() => undefined);
        let statusCode = 0;
        try {
            const upload = new FormData();
            upload.set("purpose", "voice_clone");
            upload.set("file", file, file.name || "voice.wav");
            const uploadResponse = await requestMiniMax("/v1/files/upload", { method: "POST", body: upload });
            statusCode = uploadResponse.status;
            const uploadPayload = (await uploadResponse.json().catch(() => ({}))) as Record<string, unknown>;
            const fileId = readNumber(uploadPayload, "file_id") || readNumber((uploadPayload.file || {}) as Record<string, unknown>, "file_id");
            if (!uploadResponse.ok || !fileId) {
                const error = readError(uploadPayload, uploadResponse.status, "上传复刻音频失败");
                if (isVoiceSubmissionUncertain(statusCode, uploadResponse.ok && !fileId)) {
                    const review = "MiniMax 音色复刻上传结果待确认，请先查看请求日志，确认前不要重复提交";
                    await markVoiceSubmissionNeedsReview(log?.id, startedAt, review, statusCode);
                    return NextResponse.json({ error: review, needsReview: true, logId: log?.id }, { status: 409 });
                }
                if (log) await updateMiniMaxRequestLog(log.id, { statusCode, durationMs: Date.now() - startedAt, phase: "failed", error, lifecycle: [{ at: new Date().toISOString(), phase: "failed", message: error }] }).catch(() => undefined);
                return NextResponse.json({ error }, { status: uploadResponse.ok ? 502 : uploadResponse.status || 502 });
            }
            if (log) await updateMiniMaxRequestLog(log.id, { statusCode, durationMs: Date.now() - startedAt, phase: "running", lifecycle: [{ at: new Date().toISOString(), phase: "running", message: "音频上传完成，正在创建复刻音色" }] }).catch(() => undefined);

            const voiceId = `octal_${user.id.slice(0, 8)}_${Date.now().toString(36)}`;
            const cloneResponse = await requestMiniMax("/v1/voice_clone", {
                method: "POST",
                // The uploaded voice_clone file is the source audio. `clone_prompt` is
                // optional and, when present, also requires a separate prompt_audio file
                // (purpose=prompt_audio); the text entered in this UI is synthesized after
                // cloning with the new voice, so it must not be sent as clone_prompt.
                body: JSON.stringify({ file_id: fileId, voice_id: voiceId }),
            });
            statusCode = cloneResponse.status;
            const clonePayload = (await cloneResponse.json().catch(() => ({}))) as Record<string, unknown>;
            if (!cloneResponse.ok || readNumber((clonePayload.base_resp || {}) as Record<string, unknown>, "status_code") !== 0) {
                const error = readError(clonePayload, cloneResponse.status, "创建复刻音色失败");
                if (isVoiceSubmissionUncertain(statusCode)) {
                    const review = "MiniMax 音色复刻提交结果待确认，请先查看请求日志，确认前不要重复提交";
                    await markVoiceSubmissionNeedsReview(log?.id, startedAt, review, statusCode);
                    return NextResponse.json({ error: review, needsReview: true, logId: log?.id }, { status: 409 });
                }
                if (log) await updateMiniMaxRequestLog(log.id, { statusCode, durationMs: Date.now() - startedAt, phase: "failed", error, lifecycle: [{ at: new Date().toISOString(), phase: "failed", message: error }] }).catch(() => undefined);
                return NextResponse.json({ error }, { status: cloneResponse.ok ? 502 : cloneResponse.status || 502 });
            }
            const voice = await saveMiniMaxVoice({ userId: user.id, remoteVoiceId: voiceId, name, voiceName: name, description, providerCreatedTime: "", voiceType: "voice_cloning", visible: true, category: classifyMiniMaxVoice(name, description) });
            if (log) await updateMiniMaxRequestLog(log.id, { statusCode, durationMs: Date.now() - startedAt, phase: "success", responsePreview: "MiniMax 复刻音色已创建并保存", lifecycle: [{ at: new Date().toISOString(), phase: "success", message: "音色复刻完成" }] }).catch(() => undefined);
            return NextResponse.json({ voice, fileId });
    } catch (error) {
        const message = error instanceof Error ? error.message : "MiniMax 音色复刻失败";
        if (isVoiceSubmissionUncertain(statusCode)) {
            const review = "MiniMax 音色复刻提交结果待确认，请先查看请求日志，确认前不要重复提交";
            await markVoiceSubmissionNeedsReview(log?.id, startedAt, review, statusCode);
            return NextResponse.json({ error: review, needsReview: true, logId: log?.id }, { status: 409 });
        }
        if (log) await updateMiniMaxRequestLog(log.id, { statusCode, durationMs: Date.now() - startedAt, phase: "failed", error: message.slice(0, 500), lifecycle: [{ at: new Date().toISOString(), phase: "failed", message: message.slice(0, 200) }] }).catch(() => undefined);
            return NextResponse.json({ error: message }, { status: statusCode || 502 });
        }
    } catch (error) {
        if (error instanceof RequestBodyTooLargeError) return NextResponse.json({ error: "复刻音频不能超过 20MB" }, { status: error.status });
        throw error;
    }
}

function readNumber(value: Record<string, unknown>, key: string) {
    const item = value[key];
    return typeof item === "number" || (typeof item === "string" && /^\d+$/.test(item)) ? Number(item) : 0;
}

function readError(payload: Record<string, unknown>, status: number, fallback: string) {
    const base = payload.base_resp as Record<string, unknown> | undefined;
    return String(base?.status_msg || payload.message || payload.msg || `${fallback}（${status || 502}）`);
}
