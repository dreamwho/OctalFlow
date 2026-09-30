import { DEFAULT_GENERATION_PROMPT_RULES, generationPromptRuleContent } from "@/lib/generation-prompt-rules";
import { parseImageDimensions } from "@/lib/image-size";
import type { VideoGenerationReference } from "@/lib/video-reference-contract";

export function resolveVideoGenerationParameters(raw: Record<string, unknown>, defaults: { imageSize: string; videoQuality: string; videoSeconds: number }) {
    return {
        ...raw,
        size: normalizeVideoSize(text(raw.size), defaults.imageSize),
        vquality: text(raw.vquality) || defaults.videoQuality,
        videoSeconds: resolveVideoDuration(raw.videoSeconds, defaults.videoSeconds),
    };
}

export function normalizeVideoSize(value: unknown, fallback = "16:9") {
    const textValue = text(value);
    const dimensions = parseImageDimensions(textValue);
    if (dimensions) return `${dimensions.width}x${dimensions.height}`;
    return normalizeVideoAspectRatio(textValue, fallback);
}

export function resolveUpstreamVideoDuration(value: unknown, fallback: number, policy: { durationRange?: string; minDurationSeconds?: number; maxDurationSeconds?: number } = {}) {
    const fallbackSeconds = positiveInteger(fallback) || 5;
    const requested = resolveVideoDuration(value, fallbackSeconds);
    const durationRange = policy.durationRange?.trim() || "";
    if (requested === -1 && /(?:^|\D)-1(?:\D|$)|智能|auto|adaptive/i.test(durationRange)) return -1;

    const seconds = requested === -1 ? fallbackSeconds : requested;
    const { minSeconds: min, maxSeconds: max, options } = resolveVideoDurationCapability(policy);
    if (options.length) return options.find((item) => item >= seconds) || options.at(-1)!;
    return Math.max(min, Math.min(max, seconds));
}

export type VideoDurationCapability = {
    /** True only when the current model/profile supplied a concrete duration contract. */
    known: boolean;
    minSeconds: number;
    maxSeconds: number;
    /** Discrete provider durations when the profile declares options instead of a range. */
    options: number[];
};

/**
 * Resolve the duration contract once from the model capability profile or
 * channel protocol.  Callers that need to plan multiple tasks can use
 * `known` to avoid inventing a provider limit when configuration is absent.
 */
export function resolveVideoDurationCapability(policy: { durationRange?: string; minDurationSeconds?: number; maxDurationSeconds?: number } = {}): VideoDurationCapability {
    const durationRange = policy.durationRange?.trim() || "";
    const bounds = parseDurationBounds(durationRange);
    const configuredMin = positiveInteger(policy.minDurationSeconds);
    const configuredMax = positiveInteger(policy.maxDurationSeconds);
    const known = Boolean(bounds || configuredMin || configuredMax || parseDurationOptions(durationRange).length);
    const minSeconds = Math.max(1, configuredMin || bounds?.min || 1);
    const maxSeconds = Math.max(minSeconds, Math.min(3600, configuredMax || bounds?.max || 3600));
    return {
        known,
        minSeconds,
        maxSeconds,
        options: parseDurationOptions(durationRange).filter((item) => item >= minSeconds && item <= maxSeconds),
    };
}

/**
 * Selects a provider-supported quality without guessing when no model profile
 * was configured.  Providers keep their native spelling (for example 768P).
 */
export function normalizeVideoQualityForCapability(value: unknown, options?: readonly string[]) {
    const requested = typeof value === "string" ? value.trim() : "";
    if (!options?.length) return requested;
    const key = qualityKey(requested);
    return options.find((option) => qualityKey(option) === key) || options[0];
}

export function normalizeVideoAspectRatioForCapability(value: unknown, options?: readonly string[]) {
    if (!options?.length) return typeof value === "string" ? value.trim() : "";
    const requested = normalizeVideoAspectRatio(value);
    return options.find((option) => normalizeVideoAspectRatio(option) === requested) || options[0];
}

export function normalizeVideoAspectRatio(value: unknown, fallback = "16:9") {
    return parseAspectRatio(value) || parseAspectRatio(fallback) || "16:9";
}

export function resolveVideoDuration(value: unknown, fallback: number) {
    const number = Number(value);
    if (number === -1) return -1;
    const seconds = Number.isFinite(number) && number > 0 ? number : fallback;
    return Math.max(1, Math.floor(seconds));
}

export function withVideoReferenceFidelity(prompt: string, references: readonly VideoGenerationReference[], rules = DEFAULT_GENERATION_PROMPT_RULES) {
    const source = prompt.trim();
    const hasFirstFrame = references.some((reference) => reference.role === "first_frame");
    const hasLastFrame = references.some((reference) => reference.role === "last_frame");
    const hasImage = references.some((reference) => reference.type === "image");
    const hasVideo = references.some((reference) => reference.type === "video");
    if (!hasFirstFrame && !hasLastFrame && !hasImage && !hasVideo) return source;
    const rule = hasLastFrame ? rules.videoFirstLastFrame : hasFirstFrame ? rules.videoFirstFrame : rules.videoReference;
    const content = generationPromptRuleContent(rule, { referenceSource: hasImage && hasVideo ? "参考图和参考视频" : hasImage ? "参考图" : "参考视频" });
    return content && !source.includes(content) ? `${source}\n\n${content}` : source;
}

function text(value: unknown) {
    return typeof value === "string" ? value.trim() : "";
}

function parseDurationBounds(value: string) {
    const match = value.match(/(\d{1,4})\s*(?:-|~|～|—|至|到)\s*(\d{1,4})/);
    if (!match) return undefined;
    const left = Number(match[1]);
    const right = Number(match[2]);
    return { min: Math.min(left, right), max: Math.max(left, right) };
}

function parseDurationOptions(value: string) {
    if (!value || parseDurationBounds(value)) return [];
    const options = Array.from(value.matchAll(/\d{1,4}/g), (match) => Number(match[0])).filter((item) => item > 0 && item <= 3600);
    return Array.from(new Set(options)).sort((left, right) => left - right);
}

function positiveInteger(value: unknown) {
    const number = Math.floor(Number(value));
    return Number.isFinite(number) && number > 0 ? number : undefined;
}

function parseAspectRatio(value: unknown) {
    const match = text(value)
        .replace(/\s+/g, "")
        .match(/^(\d+)(?::|x|×)(\d+)$/i);
    if (!match) return "";
    const width = Number(match[1]);
    const height = Number(match[2]);
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) return "";
    const divisor = greatestCommonDivisor(width, height);
    return `${width / divisor}:${height / divisor}`;
}

function qualityKey(value: unknown) {
    return String(value || "")
        .trim()
        .toLowerCase()
        .replace(/\s+/g, "")
        .replace(/p$/, "");
}

function greatestCommonDivisor(left: number, right: number): number {
    let a = left;
    let b = right;
    while (b) [a, b] = [b, a % b];
    return a;
}
