import { NextResponse } from "next/server";

import { readJsonBodyResult } from "@/lib/auth/request";
import { getCurrentUser } from "@/lib/auth/session";
import { classifyMiniMaxVoice } from "@/lib/minimax-audio";
import { qwenAudioSystemVoices, QWEN_AUDIO_MODELS } from "@/lib/qwen-audio";
import { appendMiniMaxRequestLog, isVoiceSubmissionUncertain, listStoredVoices, markVoiceSubmissionNeedsReview, saveMiniMaxVoice, updateMiniMaxRequestLog } from "@/lib/server/minimax-audio-store";
import { qwenResponseError, qwenVoiceCreatedAt, qwenVoiceId, qwenVoiceOperation, requestQwenAudio } from "@/lib/server/qwen-audio-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });
    const model = new URL(request.url).searchParams.get("model") || "";
    const system = qwenAudioSystemVoices(model).map((voice) => ({
        id: `qwen-system:${voice.model}:${voice.voiceParam}`,
        provider: "aliyun-bailian" as const,
        remoteVoiceId: voice.voiceParam,
        model: voice.model,
        name: voice.voiceName,
        voiceName: voice.voiceName,
        description: voice.feature,
        providerCreatedTime: "",
        scene: voice.scene,
        voiceParam: voice.voiceParam,
        feature: voice.feature,
        age: voice.age,
        gender: voice.gender,
        language: voice.language,
        ...(voice.previewUrl ? { previewUrl: voice.previewUrl } : {}),
        category: voice.feature,
        voiceType: "system" as const,
        visible: true,
        createdAt: "",
        updatedAt: "",
    }));
    const personal = (await listStoredVoices(user.id, "aliyun-bailian")).filter((voice) => !voice.model || !model || voice.model === model);
    return NextResponse.json({ system, personal });
}

export async function POST(request: Request) {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });
    const parsed = await readJsonBodyResult<{ kind?: string; model?: string; name?: string; prompt?: string; previewText?: string }>(request, 64 * 1024);
    if (!parsed.ok) return NextResponse.json({ error: parsed.message }, { status: parsed.status });
    const body = parsed.data;
    const model = String(body.model || "").trim();
    const prompt = String(body.prompt || "").trim();
    const previewText = String(body.previewText || "").trim();
    if (!model || !QWEN_AUDIO_MODELS.includes(model as (typeof QWEN_AUDIO_MODELS)[number])) return NextResponse.json({ error: "请选择已启用的阿里云百炼模型" }, { status: 400 });
    if (body.kind !== "design" || !prompt || !previewText) return NextResponse.json({ error: "阿里云百炼音色设计需要填写描述和试听文本" }, { status: 400 });
    const log = await appendMiniMaxRequestLog({ provider: "aliyun-bailian", userId: user.id, capability: "voice", method: "POST", path: "/services/audio/tts/customization", model, statusCode: 0, durationMs: 0, phase: "queued", requestPreview: JSON.stringify({ mode: "voice-design", model }), lifecycle: [{ at: new Date().toISOString(), phase: "queued", message: "阿里云百炼音色设计请求已提交" }] }).catch(() => undefined);
    const startedAt = Date.now();
    let statusCode = 0;
    try {
        const operation = qwenVoiceOperation(model, "design");
        const payload = operation === "qwen"
            ? { model: "qwen-voice-design", input: { action: "create", target_model: model, preferred_name: safeName(body.name), voice_prompt: prompt.slice(0, 2048), preview_text: previewText.slice(0, 1024) }, parameters: { sample_rate: 24000, response_format: "wav" } }
            : { model: "voice-enrollment", input: { action: "create_voice", target_model: model, prefix: safePrefix(body.name), voice_prompt: prompt.slice(0, 500), preview_text: previewText.slice(0, 200), language_hints: ["zh"] }, parameters: { sample_rate: 24000, response_format: "wav" } };
        if (log) await updateMiniMaxRequestLog(log.id, { statusCode: 0, durationMs: Date.now() - startedAt, phase: "running", lifecycle: [{ at: new Date().toISOString(), phase: "running", message: "正在调用阿里云百炼音色设计接口" }] });
        const response = await requestQwenAudio(model, "/services/audio/tts/customization", { method: "POST", body: JSON.stringify(payload) });
        statusCode = response.status;
        const result = await response.json().catch(() => ({}));
        const voiceId = qwenVoiceId(result);
        if (!response.ok || !voiceId) {
            const error = qwenResponseError(result, response.status, "阿里云百炼音色设计失败");
            if (isVoiceSubmissionUncertain(statusCode, response.ok && !voiceId)) {
                const review = "阿里云百炼音色设计提交结果待确认，请先查看请求日志，确认前不要重复提交";
                await markVoiceSubmissionNeedsReview(log?.id, startedAt, review, statusCode);
                return NextResponse.json({ error: review, needsReview: true, logId: log?.id }, { status: 409 });
            }
            throw new Error(error);
        }
        const name = safeName(body.name) || "我的百炼设计音色";
        const voice = await saveMiniMaxVoice({ provider: "aliyun-bailian", userId: user.id, remoteVoiceId: voiceId, model, name, voiceName: name, description: prompt.slice(0, 500), providerCreatedTime: qwenVoiceCreatedAt(result), scene: "个人创建", feature: classifyMiniMaxVoice(name, prompt), voiceType: "voice_generation", visible: true, category: classifyMiniMaxVoice(name, prompt) });
        if (log) await updateMiniMaxRequestLog(log.id, { statusCode: response.status, durationMs: Date.now() - startedAt, phase: "success", responsePreview: "阿里云百炼设计音色已创建并保存", lifecycle: [{ at: new Date().toISOString(), phase: "success", message: "音色设计完成" }] });
        return NextResponse.json({ voice });
    } catch (error) {
        const message = error instanceof Error ? error.message : "阿里云百炼音色设计失败";
        if (isVoiceSubmissionUncertain(statusCode)) {
            const review = "阿里云百炼音色设计提交结果待确认，请先查看请求日志，确认前不要重复提交";
            await markVoiceSubmissionNeedsReview(log?.id, startedAt, review, statusCode);
            return NextResponse.json({ error: review, needsReview: true, logId: log?.id }, { status: 409 });
        }
        if (log) await updateMiniMaxRequestLog(log.id, { statusCode: 502, durationMs: Date.now() - startedAt, phase: "failed", error: message.slice(0, 500), lifecycle: [{ at: new Date().toISOString(), phase: "failed", message: message.slice(0, 200) }] }).catch(() => undefined);
        return NextResponse.json({ error: message }, { status: 502 });
    }
}

function safeName(value?: string) {
    return String(value || "").trim().replace(/[^\p{L}\p{N}_-]/gu, "_").slice(0, 16) || "octal_voice";
}

function safePrefix(value?: string) {
    return safeName(value).replace(/[^A-Za-z0-9]/g, "").slice(0, 10) || "octalvoice";
}
