import { DEFAULT_GENERATION_PROMPT_RULES, generationPromptRuleContent } from "@/lib/generation-prompt-rules";
export const PANORAMA_IMAGE_SIZE = "2048x1024";
export const PANORAMA_NODE_SIZE = { width: 340, height: 170 } as const;

const PANORAMA_PROMPT_MARKER = "\n\n[全景输出约束]\n";

export function buildPanoramaPrompt(prompt: string, hasReferences: boolean, rule = DEFAULT_GENERATION_PROMPT_RULES.panorama) {
    const basePrompt = prompt.split(PANORAMA_PROMPT_MARKER)[0].trim();
    const referenceDirection = hasReferences ? "参考素材只用于保留主体、材质、色彩和空间线索；补全四周环境，不要拉伸原图。" : "根据文字完整构建观看者四周的连续环境。";
    const content = generationPromptRuleContent(rule, { referenceDirection });
    return content ? `${basePrompt}${PANORAMA_PROMPT_MARKER}${content}` : basePrompt;
}

export function isPanoramaRatio(width: number, height: number) {
    return width > 0 && height > 0 && Math.abs(width / height - 2) <= 0.02;
}
