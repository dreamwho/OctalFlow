import type { VideoGenerationReference, VideoReferenceRole } from "@/lib/video-reference-contract";

export const minimaxH3Protocols = ["minimax-h3", "minimax-h3-official"] as const;
export type MinimaxH3Protocol = (typeof minimaxH3Protocols)[number];
export type MinimaxH3PromptMode = "t2va" | "i2va" | "fl2va" | "l2va" | "ref2va";

export type MinimaxH3ReferenceBinding = {
    referenceIndex: number;
    type: VideoGenerationReference["type"];
    url: string;
    role: VideoReferenceRole;
    label: string;
    assetId?: string;
    nodeId?: string;
    sourceTaskId?: string;
    alias?: string;
};

export type MinimaxH3PromptCompilation = {
    applied: boolean;
    mode?: MinimaxH3PromptMode;
    prompt: string;
    referenceBindings: MinimaxH3ReferenceBinding[];
};

type ReferenceMetadata = Pick<MinimaxH3ReferenceBinding, "type" | "url" | "role" | "assetId" | "nodeId" | "sourceTaskId" | "alias">;

export function isMinimaxH3Protocol(value: unknown): value is MinimaxH3Protocol {
    return minimaxH3Protocols.includes(value as MinimaxH3Protocol);
}

/**
 * Keeps the source-order binding manifest outside the provider prompt. The provider only sees
 * its own URL/type/role references, while this manifest proves that an H3 label was never
 * assigned to a different source asset.
 */
export function createMinimaxH3ReferenceBindings(references: readonly VideoGenerationReference[], rawReferences?: unknown): MinimaxH3ReferenceBinding[] {
    const metadata = referenceMetadata(rawReferences);
    const canonicalKeys = new Set(references.map(referenceKey));
    if (metadata.some((item) => !canonicalKeys.has(referenceKey(item)))) throw new Error("MiniMax H3 引用绑定与已规范化参考素材不一致");

    const metadataByKey = new Map<string, ReferenceMetadata[]>();
    for (const item of metadata) {
        const key = referenceKey(item);
        const current = metadataByKey.get(key) || [];
        current.push(item);
        metadataByKey.set(key, current);
    }

    const counters = { image: 0, video: 0, audio: 0 };
    const hasFirstFrame = references.some((reference) => reference.role === "first_frame");
    return references.map((reference, referenceIndex) => {
        const key = referenceKey(reference);
        const candidates = metadataByKey.get(key) || [];
        const identities = new Set(candidates.map(identityKey));
        if (identities.size > 1) throw new Error("MiniMax H3 无法安全绑定指向同一素材地址的多个不同引用");
        const source = candidates[0];
        return {
            referenceIndex,
            type: reference.type,
            url: reference.url,
            role: reference.role || "reference",
            label: referenceLabel(reference, counters, hasFirstFrame),
            ...(source?.assetId ? { assetId: source.assetId } : {}),
            ...(source?.nodeId ? { nodeId: source.nodeId } : {}),
            ...(source?.sourceTaskId ? { sourceTaskId: source.sourceTaskId } : {}),
            ...(source?.alias ? { alias: source.alias } : {}),
        };
    });
}

export function rebindMinimaxH3ReferenceUrls(bindings: readonly MinimaxH3ReferenceBinding[], references: readonly VideoGenerationReference[]) {
    assertReferenceBindings(references, bindings, false);
    return bindings.map((binding, referenceIndex) => ({ ...binding, url: references[referenceIndex].url }));
}

export function compileMinimaxH3Prompt(input: {
    protocol: unknown;
    prompt: string;
    durationSeconds?: number;
    references: readonly VideoGenerationReference[];
    referenceBindings?: readonly MinimaxH3ReferenceBinding[];
}): MinimaxH3PromptCompilation {
    const originalPrompt = input.prompt;
    const prompt = originalPrompt.trim();
    const bindings = input.referenceBindings ? cloneAndAssertBindings(input.references, input.referenceBindings) : createMinimaxH3ReferenceBindings(input.references);
    if (!isMinimaxH3Protocol(input.protocol)) return { applied: false, prompt: originalPrompt, referenceBindings: bindings };

    const mode = promptMode(input.references);
    if (isMinimaxH3StructuredPrompt(prompt)) {
        const bindingLock = referenceBindingLock(bindings);
        return { applied: true, mode, prompt: bindingLock ? injectBindingLock(prompt, bindingLock) : prompt, referenceBindings: bindings };
    }

    const bindingLock = referenceBindingLock(bindings);
    const duration = formattedDuration(input.durationSeconds);
    return {
        applied: true,
        mode,
        prompt:
            mode === "ref2va"
                ? compileReferencePrompt(prompt, bindings, duration)
                : compileBasePrompt(prompt, mode, bindingLock, duration),
        referenceBindings: bindings,
    };
}

export function isMinimaxH3StructuredPrompt(prompt: string) {
    return /^(?:subject_definitions|integrated_multimodal_description)\s*:/im.test(prompt) && /^(?:detailed_description|overall_soundscape)\s*:/im.test(prompt);
}

function compileBasePrompt(prompt: string, mode: Exclude<MinimaxH3PromptMode, "ref2va">, bindingLock: string, duration: string) {
    const alignment =
        mode === "i2va"
            ? "The first generated frame must align with <Picture 1>; preserve its supplied subject identity, scene anchor, composition, and visual continuity only as provided."
            : mode === "fl2va"
              ? `The first generated frame must align with <Picture 1>, and the final generated frame must align with <Picture 2>${duration ? ` at ${duration}` : ""}; do not exchange their roles.`
              : mode === "l2va"
                ? `The final generated frame must align with <Picture 1>${duration ? ` at ${duration}` : ""}; do not invent a first-frame reference.`
                : "Create the requested video directly from the user brief without inventing unprovided reference media.";
    return [
        "integrated_multimodal_description:",
        alignment,
        ...(bindingLock ? [bindingLock] : []),
        "Original user brief (preserve its stated names, dialogue, lyrics, and visible text verbatim):",
        prompt,
        "overall_soundscape:",
        "Use only sound, ambience, dialogue, and synchronized actions requested by the original user brief; otherwise use an appropriate coherent soundscape.",
        "non_diegetic_music:",
        "N/A unless the original user brief explicitly requests music.",
    ].join("\n\n");
}

function compileReferencePrompt(prompt: string, bindings: readonly MinimaxH3ReferenceBinding[], duration: string) {
    const definitions = bindings.map((binding) => `${binding.label} is the ${bindingDescription(binding)}.`).join("\n");
    const retention = bindings.map((binding) => `${binding.label} (${bindingDescription(binding)}): fully_preserved - preserve only the identity, appearance, motion, audio, or scene information explicitly supplied by this exact reference; do not swap it with another reference.`).join("\n");
    return [
        "subject_definitions:",
        definitions,
        "summary:",
        "[reference generation] Create the requested video while preserving the independently submitted reference bindings below.",
        "retention_analysis:",
        retention,
        "detailed_description:",
        `${duration ? `Plan the audiovisual sequence for the resolved ${duration}. ` : ""}Original user brief (preserve its stated names, dialogue, lyrics, and visible text verbatim):\n${prompt}`,
        "overall_soundscape:",
        "Use only audio information explicitly supplied by the bound references or requested by the original user brief; otherwise use an appropriate coherent soundscape.",
        "non_diegetic_music:",
        "N/A unless the original user brief explicitly requests music.",
    ].join("\n\n");
}

function referenceBindingLock(bindings: readonly MinimaxH3ReferenceBinding[]) {
    if (!bindings.length) return "";
    return [
        "Reference binding lock:",
        ...bindings.map((binding) => `${binding.label} = ${bindingDescription(binding)}.`),
        "Each label is bound only to the independently submitted reference at its original array position. Do not swap, merge, substitute, renumber, reinterpret, or invent references.",
    ].join("\n");
}

function injectBindingLock(prompt: string, bindingLock: string) {
    const header = /^(subject_definitions|integrated_multimodal_description)\s*:\s*$/im;
    if (!header.test(prompt)) return `${bindingLock}\n\n${prompt}`;
    return prompt.replace(header, (value) => `${value}\n${bindingLock}`);
}

function promptMode(references: readonly VideoGenerationReference[]): MinimaxH3PromptMode {
    const first = references.filter((reference) => reference.role === "first_frame");
    const last = references.filter((reference) => reference.role === "last_frame");
    const regular = references.filter((reference) => (reference.role || "reference") === "reference");
    if (first.length > 1 || last.length > 1) throw new Error("MiniMax H3 每次只能绑定一张首帧和一张尾帧");
    if (regular.length && (first.length || last.length)) throw new Error("MiniMax H3 首尾帧不能与普通参考素材混用");
    if (regular.length) return "ref2va";
    if (first.length && last.length) return "fl2va";
    if (first.length) return "i2va";
    if (last.length) return "l2va";
    return "t2va";
}

function referenceLabel(reference: VideoGenerationReference, counters: Record<VideoGenerationReference["type"], number>, hasFirstFrame: boolean) {
    const role = reference.role || "reference";
    if (role === "first_frame") return "<Picture 1>";
    if (role === "last_frame") return hasFirstFrame ? "<Picture 2>" : "<Picture 1>";
    counters[reference.type] += 1;
    const type = reference.type === "image" ? "Picture" : reference.type === "video" ? "Video" : "Audio";
    return `<${type} ${counters[reference.type]}>`;
}

function bindingDescription(binding: MinimaxH3ReferenceBinding) {
    const role = binding.role === "first_frame" ? "first-frame image" : binding.role === "last_frame" ? "last-frame image" : `${binding.type} reference`;
    return `${role} at original reference position ${binding.referenceIndex + 1}${binding.alias ? ` (user alias @${binding.alias.replace(/^@+/, "")})` : ""}`;
}

function formattedDuration(value: number | undefined) {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? `${value.toFixed(2)} seconds` : "";
}

function cloneAndAssertBindings(references: readonly VideoGenerationReference[], bindings: readonly MinimaxH3ReferenceBinding[]) {
    assertReferenceBindings(references, bindings);
    return bindings.map((binding) => ({ ...binding }));
}

function assertReferenceBindings(references: readonly VideoGenerationReference[], bindings: readonly MinimaxH3ReferenceBinding[], requireUrls = true) {
    if (references.length !== bindings.length) throw new Error("MiniMax H3 引用绑定数量与提交素材不一致");
    for (const [referenceIndex, reference] of references.entries()) {
        const binding = bindings[referenceIndex];
        if (!binding || binding.referenceIndex !== referenceIndex || binding.type !== reference.type || (requireUrls && binding.url !== reference.url) || binding.role !== (reference.role || "reference")) {
            throw new Error("MiniMax H3 引用绑定与提交素材不一致");
        }
    }
}

function referenceMetadata(value: unknown): ReferenceMetadata[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return [];
        const source = item as Record<string, unknown>;
        const type = source.type === "image" || source.type === "video" || source.type === "audio" ? source.type : undefined;
        const url = stringValue(source.url);
        const role = source.role === "first_frame" || source.role === "last_frame" || source.role === "reference" || source.role === undefined ? (source.role || "reference") : undefined;
        if (!type || !url || !role) return [];
        const metadata = {
            type,
            url,
            role,
            assetId: stringValue(source.assetId),
            nodeId: stringValue(source.nodeId),
            sourceTaskId: stringValue(source.sourceTaskId),
            alias: stringValue(source.alias),
        } satisfies ReferenceMetadata;
        return metadata.assetId || metadata.nodeId || metadata.sourceTaskId || metadata.alias ? [metadata] : [];
    });
}

function referenceKey(reference: Pick<VideoGenerationReference, "type" | "url" | "role">) {
    return `${reference.type}\u0000${reference.role || "reference"}\u0000${reference.url}`;
}

function identityKey(reference: ReferenceMetadata) {
    return [reference.assetId || "", reference.nodeId || "", reference.sourceTaskId || "", reference.alias || ""].join("\u0000");
}

function stringValue(value: unknown) {
    return typeof value === "string" && value.trim() ? value : undefined;
}
