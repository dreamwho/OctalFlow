import type { LogicalModelCapabilityProfile } from "@/lib/auth/store";

export type CapabilityConstraintInput = {
    capability: "image" | "video" | "audio" | "text";
    referenceCount?: number;
    durationSeconds?: number;
    batchSize?: number;
    aspectRatio?: string;
    quality?: string;
};

export function assertCapabilityConstraints(profile: LogicalModelCapabilityProfile | undefined, input: CapabilityConstraintInput) {
    if (!profile) return;
    if (input.referenceCount && profile.maxReferenceImages && input.referenceCount > profile.maxReferenceImages) throw new Error(`当前模型最多支持 ${profile.maxReferenceImages} 张参考图`);
    if (input.batchSize && profile.maxBatchSize && input.batchSize > profile.maxBatchSize) throw new Error(`当前模型最多支持批量生成 ${profile.maxBatchSize} 个结果`);
    if (input.durationSeconds && profile.minDurationSeconds && input.durationSeconds < profile.minDurationSeconds) throw new Error(`当前模型最短视频时长为 ${profile.minDurationSeconds} 秒`);
    if (input.durationSeconds && profile.maxDurationSeconds && input.durationSeconds > profile.maxDurationSeconds) throw new Error(`当前模型最长视频时长为 ${profile.maxDurationSeconds} 秒`);
    // Ratios compare by value: a requested 21:9 arrives here reduced to 7:3.
    if (input.aspectRatio && profile.aspectRatios?.length && !profile.aspectRatios.some((option) => ratioKey(option) === ratioKey(input.aspectRatio!))) throw new Error(`当前模型不支持 ${input.aspectRatio} 比例`);
    if (input.quality && profile.qualityOptions?.length && !profile.qualityOptions.some((option) => qualityKey(option) === qualityKey(input.quality))) throw new Error(`当前模型不支持 ${input.quality} 清晰度`);
}

function ratioKey(value: string) {
    const match = value.trim().match(/^(\d+)(?::|x|×)(\d+)$/i);
    if (!match) return value.trim();
    const width = Number(match[1]);
    const height = Number(match[2]);
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) return value.trim();
    const divisor = greatestCommonDivisor(width, height);
    return `${width / divisor}:${height / divisor}`;
}

function greatestCommonDivisor(left: number, right: number): number {
    while (right) {
        const next = left % right;
        left = right;
        right = next;
    }
    return left;
}

function qualityKey(value: unknown) {
    return String(value || "")
        .trim()
        .toLowerCase()
        .replace(/\s+/g, "")
        .replace(/p$/, "");
}
