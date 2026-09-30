import { isDolaQuotaExhaustedError } from "@/lib/dola-errors";

/** Read semantic quota information even when the transport reports accepted/200. */
export function readDolaQuotaReply(value: Record<string, unknown>) {
    const diagnostics = value.diagnostics as Record<string, unknown> | undefined;
    const text = [value.error, value.rawError, value.raw_error, value.conversationReply, diagnostics?.upstreamResponseText].filter((item): item is string => typeof item === "string").join("\n");
    // A real media result takes precedence over incidental wording in a reply.
    if (value.videoUrl || value.video_url || (Array.isArray(value.imageUrls) && value.imageUrls.length)) return null;
    const exhausted = isDolaQuotaExhaustedError(text);
    const cost = text.match(/(?:将|本次)?(?:消耗|使用)\s*(\d+(?:\.\d+)?)\s*个?\s*(视频|图片|图像)?生成额度/);
    const remaining = text.match(/(?:今日|今天)?剩余\s*(\d+(?:\.\d+)?)\s*个?\s*(视频|图片|图像)?生成额度/);
    if (!exhausted && !cost && !remaining) return null;
    return {
        exhausted,
        reason: text,
        consumed: cost ? Number(cost[1]) : undefined,
        remaining: exhausted ? 0 : remaining ? Number(remaining[1]) : undefined,
        capability: /图片|图像/.test(cost?.[2] || remaining?.[2] || "") ? "image" as const : "video" as const,
    };
}

export function dolaQuotaLogFields(value: Record<string, unknown> | null) {
    const quota = Array.isArray(value?.quota) ? value.quota[0] as Record<string, unknown> | undefined : undefined;
    return quota ? { quotaRemaining: typeof quota.remaining === "number" ? quota.remaining : null, quotaLimit: typeof quota.limit === "number" ? quota.limit : null } : {};
}
