import { applyGenerationPromptRule, DEFAULT_GENERATION_PROMPT_RULES, type GenerationPromptRule } from "./generation-prompt-rules";

export function imageReferenceLabel(index: number) {
    return `图片${index + 1}`;
}

export function buildImageReferencePromptText(prompt: string, references: readonly unknown[], rule: GenerationPromptRule = DEFAULT_GENERATION_PROMPT_RULES.imageReference) {
    const text = prompt.trim();
    if (!references.length) return text;
    const labels = references.map((_, index) => imageReferenceLabel(index));
    return applyGenerationPromptRule(text, rule, { referenceLabels: labels.join(", "), referenceLabelsZh: labels.join("、"), referenceField: references.length === 1 ? "image_urls[0]" : "image_urls" });
}
