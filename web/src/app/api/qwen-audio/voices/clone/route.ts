import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import { classifyMiniMaxVoice } from "@/lib/minimax-audio";
import { QWEN_AUDIO_MODELS } from "@/lib/qwen-audio";
import { appendMiniMaxRequestLog, isVoiceSubmissionUncertain, markVoiceSubmissionNeedsReview, saveMiniMaxVoice, updateMiniMaxRequestLog } from "@/lib/server/minimax-audio-store";
import { createExternalMediaReadUrl, createTemporaryPublicObject } from "@/lib/server/object-storage-service";
import { writeReferenceMediaDataUrl } from "@/lib/server/reference-asset-store";
import { getLocalMediaRegistration } from "@/lib/server/local-media-registry";
import { deleteLocalMediaAssetsByStorageKeys } from "@/lib/server/local-media-storage";
import { createSignedReferenceAssetUrl } from "@/lib/server/reference-asset-access";
import { qwenVoiceCloneError, qwenVoiceCreatedAt, qwenVoiceId, qwenVoiceOperation, requestQwenAudio } from "@/lib/server/qwen-audio-service";
import { readRequestBodyBytes, RequestBodyTooLargeError } from "@/lib/server/request-body-limit";
import { resolvePublicRequestOrigin } from "@/lib/server/public-request-origin";
import { fetchSafeOutbound } from "@/lib/server/safe-outbound-fetch";

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
        const model = String(form.get("model") || "").trim();
        const promptText = String(form.get("promptText") || "").trim();
        const name = String(form.get("name") || "我的百炼复刻音色").trim().slice(0, 80) || "我的百炼复刻音色";
        const description = String(form.get("description") || "").trim().slice(0, 500);
        if (!(file instanceof File) || !file.size || !model || !promptText) return NextResponse.json({ error: "音色复刻需要模型、音频文件和提示词文本" }, { status: 400 });
        if (file.size > 20 * 1024 * 1024) return NextResponse.json({ error: "复刻音频不能超过 20MB" }, { status: 400 });
        if (!QWEN_AUDIO_MODELS.includes(model as (typeof QWEN_AUDIO_MODELS)[number])) return NextResponse.json({ error: "请选择已启用的阿里云百炼模型" }, { status: 400 });
        const log = await appendMiniMaxRequestLog({ provider: "aliyun-bailian", userId: user.id, capability: "voice", method: "POST", path: "/services/audio/tts/customization", model, statusCode: 0, durationMs: 0, phase: "queued", requestPreview: JSON.stringify({ mode: "voice-cloning", model }), lifecycle: [{ at: new Date().toISOString(), phase: "queued", message: "阿里云百炼音色复刻请求已提交" }] }).catch(() => undefined);
        const startedAt = Date.now();
        let statusCode = 0;
        let providerAttempted = false;
        let temporaryAudioCleanup: (() => Promise<void>) | undefined;
        let temporaryAudioCleanupLabel = "临时参考音频";
        let logPhase: "queued" | "running" | "success" | "failed" = "queued";
        let logError = "";
        let logResponsePreview = "";
        const recordLifecycle = async (phase: typeof logPhase, message: string, options: { statusCode?: number; error?: string; responsePreview?: string } = {}) => {
            logPhase = phase;
            if (options.statusCode !== undefined) statusCode = options.statusCode;
            if (options.error !== undefined) logError = options.error;
            if (options.responsePreview !== undefined) logResponsePreview = options.responsePreview;
            if (!log) return;
            await updateMiniMaxRequestLog(log.id, {
                statusCode,
                durationMs: Date.now() - startedAt,
                phase,
                error: logError || undefined,
                responsePreview: logResponsePreview || undefined,
                lifecycle: [{ at: new Date().toISOString(), phase, message }],
            }).catch(() => undefined);
        };
        try {
            const operation = qwenVoiceOperation(model, "clone");
            const audioBytes = Buffer.from(await file.arrayBuffer());
            const contentType = file.type || "audio/mpeg";
            const audio = `data:${contentType};base64,${audioBytes.toString("base64")}`;
            const publicAudio = operation === "qwen" ? undefined : await (async () => {
                await recordLifecycle("running", "正在将临时参考音频上传至配置的阿里云 OSS（不受外部存储开关影响）");
                const resource = await persistPublicAudioUrl(audioBytes, contentType, user.id, file.name, request);
                temporaryAudioCleanup = resource.cleanup;
                temporaryAudioCleanupLabel = resource.storage === "oss" ? `临时 OSS 对象 ${resource.storageKey}` : "站内临时参考音频";
                await recordLifecycle("running", `${temporaryAudioCleanupLabel}已生成短时签名公网地址`);
                await assertProviderReadableAudioUrl(resource.url);
                await recordLifecycle("running", "已验证百炼可读取临时公网音频地址");
                return resource;
            })();
            const payload = operation === "qwen"
                ? { model: "qwen-voice-enrollment", input: { action: "create", target_model: model, preferred_name: safeName(name), audio: { data: audio } } }
                : { model: "voice-enrollment", input: { action: "create_voice", target_model: model, prefix: safePrefix(name), url: publicAudio!.url, language_hints: ["zh"], enable_volume_normalization: "false" } };
            await recordLifecycle("running", "正在调用阿里云百炼音色复刻接口");
            providerAttempted = true;
            const response = await requestQwenAudio(model, "/services/audio/tts/customization", { method: "POST", body: JSON.stringify(payload) });
            statusCode = response.status;
            const result = await response.json().catch(() => ({}));
            const voiceId = qwenVoiceId(result);
            if (!response.ok || !voiceId) {
                const error = qwenVoiceCloneError(result, response.status);
                if (isVoiceSubmissionUncertain(statusCode, response.ok && !voiceId)) {
                    const review = "阿里云百炼音色复刻提交结果待确认，请先查看请求日志，确认前不要重复提交";
                    logPhase = "running";
                    logResponsePreview = review;
                    await markVoiceSubmissionNeedsReview(log?.id, startedAt, review, statusCode);
                    return NextResponse.json({ error: review, needsReview: true, logId: log?.id }, { status: 409 });
                }
                throw new Error(error);
            }
            const voice = await saveMiniMaxVoice({ provider: "aliyun-bailian", userId: user.id, remoteVoiceId: voiceId, model, name, voiceName: name, description, providerCreatedTime: qwenVoiceCreatedAt(result), scene: "个人创建", feature: classifyMiniMaxVoice(name, description), voiceType: "voice_cloning", visible: true, category: classifyMiniMaxVoice(name, description) });
            await recordLifecycle("success", "音色复刻完成", { statusCode: response.status, responsePreview: "阿里云百炼复刻音色已创建并保存" });
            return NextResponse.json({ voice });
        } catch (error) {
            const message = error instanceof Error ? error.message : "阿里云百炼音色复刻失败";
            if (providerAttempted && isVoiceSubmissionUncertain(statusCode)) {
                const review = "阿里云百炼音色复刻提交结果待确认，请先查看请求日志，确认前不要重复提交";
                logPhase = "running";
                logResponsePreview = review;
                await markVoiceSubmissionNeedsReview(log?.id, startedAt, review, statusCode);
                return NextResponse.json({ error: review, needsReview: true, logId: log?.id }, { status: 409 });
            }
            await recordLifecycle("failed", message.slice(0, 200), { statusCode: statusCode || 502, error: message.slice(0, 500) });
            return NextResponse.json({ error: message }, { status: 502 });
        } finally {
            if (temporaryAudioCleanup) {
                await recordLifecycle(logPhase, `正在删除${temporaryAudioCleanupLabel}`);
                try {
                    await temporaryAudioCleanup();
                    await recordLifecycle(logPhase, `${temporaryAudioCleanupLabel}已删除，未保留临时文件`);
                } catch (error) {
                    const cleanupMessage = `${temporaryAudioCleanupLabel}删除失败：${error instanceof Error ? error.message : "未知错误"}`.slice(0, 500);
                    await recordLifecycle(logPhase, cleanupMessage, { error: logError ? `${logError}；${cleanupMessage}` : cleanupMessage });
                    console.error("Qwen voice clone temporary audio cleanup failed", error);
                }
            }
        }
    } catch (error) {
        if (error instanceof RequestBodyTooLargeError) return NextResponse.json({ error: "复刻音频不能超过 20MB" }, { status: error.status });
        throw error;
    }
}

function safeName(value: string) {
    return value.replace(/[^\p{L}\p{N}_-]/gu, "_").slice(0, 16) || "octal_voice";
}

function safePrefix(value: string) {
    return safeName(value).replace(/[^A-Za-z0-9]/g, "").slice(0, 10) || "octalvoice";
}

async function persistPublicAudioUrl(bytes: Buffer, contentType: string, userId: string, originalName: string, request: Request) {
    const temporaryObject = await createTemporaryPublicObject({ bytes, contentType, originalName, purpose: "qwen-voice-clone" });
    if (temporaryObject) return { url: temporaryObject.url, storageKey: temporaryObject.objectKey, storage: "oss" as const, cleanup: temporaryObject.cleanup };

    const dataUrl = `data:${contentType};base64,${bytes.toString("base64")}`;
    const asset = await writeReferenceMediaDataUrl(dataUrl, "audio", { ownerUserId: userId, source: "qwen-voice-clone", originalName, maxBytes: 20 * 1024 * 1024 });
    try {
        const registration = await getLocalMediaRegistration(asset.token);
        let url = "";
        if (registration?.storageProvider === "object" && registration.externalObjectKey) {
            url = (await createExternalMediaReadUrl(request, registration)) || "";
        } else {
            const origin = resolvePublicRequestOrigin(request);
            let hostname = "";
            try {
                hostname = new URL(origin).hostname.toLowerCase().replace(/^\[|\]$/g, "");
            } catch {
                throw new Error("请为服务器配置可被阿里云访问的站点地址后再使用该音色复刻模型");
            }
            if (isPrivateHost(hostname)) throw new Error("当前站点地址不是公网地址；请配置公网站点地址，或在后台“外部存储”中配置并检测阿里云 OSS");
            url = createSignedReferenceAssetUrl(asset.token, origin);
        }
        if (!url) throw new Error("无法生成音色复刻所需的公网音频地址；可配置公网站点地址，或在后台“外部存储”中配置并检测阿里云 OSS");
        return { url, storageKey: asset.token, storage: "site" as const, cleanup: async () => { await deleteLocalMediaAssetsByStorageKeys([asset.token], "reference"); } };
    } catch (error) {
        await deleteLocalMediaAssetsByStorageKeys([asset.token], "reference").catch((cleanupError) => console.error("Qwen voice clone public audio cleanup failed", cleanupError));
        throw error;
    }
}

function isPrivateHost(hostname: string) {
    return hostname === "localhost" || hostname === "::1" || hostname === "0.0.0.0" || /^127\./.test(hostname) || /^10\./.test(hostname) || /^192\.168\./.test(hostname) || /^172\.(?:1[6-9]|2\d|3[0-1])\./.test(hostname) || hostname.endsWith(".local");
}

async function assertProviderReadableAudioUrl(url: string) {
    try {
        const response = await fetchSafeOutbound(url, { method: "GET", headers: { Range: "bytes=0-0" } }, { allowProxyFakeIpSpace: true });
        try {
            if (!response.ok) throw new Error(`status ${response.status}`);
            const contentType = response.headers.get("content-type")?.toLowerCase() || "";
            if (contentType && !contentType.startsWith("audio/")) throw new Error("content type");
        } finally {
            await response.body?.cancel().catch(() => undefined);
        }
    } catch {
        throw new Error("阿里云百炼无法从公网读取临时参考音频：请检查 NEXT_PUBLIC_SITE_URL 是否指向当前可访问的 HTTPS 域名，或在后台外部存储中配置并检测阿里云 OSS 后重试。临时音频不会保留。");
    }
}
