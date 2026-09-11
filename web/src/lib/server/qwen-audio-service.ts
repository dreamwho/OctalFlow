import { getAuthSettings } from "@/lib/auth/store";
import { QWEN_AUDIO_MODELS, isQwenVoiceCloneModel, isQwenVoiceDesignModel } from "@/lib/qwen-audio";
import { fetchSafeOutbound } from "@/lib/server/safe-outbound-fetch";

type QwenChannel = { id: string; baseUrl: string; apiKey: string; models: string[] };

export function isQwenAudioChannel(channel: { id?: string; advancedConfig?: { protocol?: string } }) {
    return channel.id === "aliyun-bailian-audio" || channel.advancedConfig?.protocol === "aliyun-bailian-audio";
}

export function qwenVoiceOperation(model: string, mode: "clone" | "design") {
    if (!QWEN_AUDIO_MODELS.includes(model as (typeof QWEN_AUDIO_MODELS)[number])) throw new Error("未启用的阿里云百炼音色模型");
    if (mode === "clone" && !isQwenVoiceCloneModel(model)) throw new Error("该模型不支持音色复刻");
    if (mode === "design" && !isQwenVoiceDesignModel(model)) throw new Error("该模型不支持音色设计");
    return model.startsWith("qwen3-tts-") ? "qwen" : "enrollment";
}

export async function getQwenAudioChannel(model: string) {
    const settings = await getAuthSettings();
    const channel = settings.systemChannels.find((item) => item.enabled && isQwenAudioChannel(item) && item.models.some((candidate) => candidate.trim() === model.trim()));
    if (!channel?.apiKey?.trim()) throw new Error("尚未配置启用的阿里云百炼语音渠道或 API Key");
    const result: QwenChannel = {
        id: channel.id,
        baseUrl: (channel.baseUrl || "https://dashscope.aliyuncs.com/api/v1").trim().replace(/\/+$/, ""),
        apiKey: channel.apiKey.trim(),
        models: channel.models,
    };
    return result;
}

export async function requestQwenAudio(model: string, pathname: string, init: RequestInit = {}) {
    const channel = await getQwenAudioChannel(model);
    const url = `${channel.baseUrl}${pathname.startsWith("/") ? pathname : `/${pathname}`}`;
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${channel.apiKey}`);
    headers.set("content-type", headers.get("content-type") || "application/json");
    return fetchSafeOutbound(url, { ...init, headers }, { allowProxyFakeIpSpace: true });
}

export function qwenResponseError(payload: unknown, status: number, fallback = "阿里云百炼语音请求失败") {
    if (payload && typeof payload === "object") {
        const data = payload as Record<string, unknown>;
        const code = typeof data.code === "string" ? data.code : "";
        const message = typeof data.message === "string" ? data.message : typeof data.msg === "string" ? data.msg : "";
        if (code || message) return [code, message].filter(Boolean).join(": ").slice(0, 500);
        const output = data.output as Record<string, unknown> | undefined;
        if (typeof output?.message === "string") return output.message.slice(0, 500);
    }
    return `${fallback}（${status || 502}）`;
}

export function qwenVoiceCloneError(payload: unknown, status: number) {
    const message = qwenResponseError(payload, status, "阿里云百炼音色复刻失败");
    if (/InputDownloadFailed|download audio failed/i.test(message)) {
        return "阿里云百炼无法下载参考音频：Qwen-Audio-TTS 和 CosyVoice 音色复刻要求音频地址可从公网直接访问。请在后台外部存储中配置并检测阿里云 OSS，或把 NEXT_PUBLIC_SITE_URL 更新为当前可访问的 HTTPS 域名后重试；请求完成或失败后临时音频会自动清理。";
    }
    return message;
}

export function qwenVoiceId(payload: unknown) {
    if (!payload || typeof payload !== "object") return "";
    const output = (payload as Record<string, unknown>).output;
    if (!output || typeof output !== "object") return "";
    const record = output as Record<string, unknown>;
    return String(record.voice_id || record.voice || "").trim();
}

export function qwenVoiceCreatedAt(payload: unknown) {
    if (!payload || typeof payload !== "object") return "";
    const output = (payload as Record<string, unknown>).output;
    return output && typeof output === "object" ? String((output as Record<string, unknown>).gmt_create || "") : "";
}
