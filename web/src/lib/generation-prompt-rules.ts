export type GenerationPromptRule = { enabled: boolean; content: string };
export type GenerationPromptRuleKey = "minimaxH3Base" | "minimaxH3Reference" | "minimaxH3Bindings" | "videoReference" | "videoFirstFrame" | "videoFirstLastFrame" | "imageReference" | "sub2ApiImageReference" | "panorama" | "image" | "video" | "text" | "audio";
export type GenerationPromptRules = Record<GenerationPromptRuleKey, GenerationPromptRule>;

export const DEFAULT_GENERATION_PROMPT_RULES: GenerationPromptRules = {
    imageReference: { enabled: true, content: "Reference images: {{referenceLabels}}. Use the reference image as real visual input, not as a text description. If a reference image contains a person or character, keep the same identity/character, face proportions, hairstyle, body shape, clothing, and main pose as much as possible. Only change the scene, style, background, or details requested by the user. Do not replace the referenced person with a new person.\n\n参考图片编号：{{referenceLabelsZh}}。如果参考图中包含人物或角色，请保持同一人物/角色、五官比例、发型、体型、服饰和主要姿态，只按用户要求修改场景、风格、背景或细节，不要换成新人物。" },
    sub2ApiImageReference: { enabled: true, content: "Use the actual reference image supplied in the JSON field {{referenceField}} as visual input, not as a text-only hint.\nThe first reference image, image_urls[0], is the primary identity and character reference. Keep the same person or character, face proportions, hairstyle, body shape, clothing, and main pose as much as possible.\nOnly apply the user's requested edit to the existing referenced subject. Do not replace the referenced person or character with a new unrelated person." },
    panorama: { enabled: true, content: "{{referenceDirection}} 最终只输出一张 2:1 等距柱状投影全景图，水平覆盖 360 度，垂直覆盖 180 度，观看者位于场景中心。地平线保持在垂直中心附近，左右边缘自然无缝衔接，天空或天花板、地面或地板必须完整。不要普通横幅、鱼眼圆形边框、多图拼接、文字、水印、界面元素或明显接缝。" },
    videoReference: { enabled: true, content: "参考素材一致性要求：将{{referenceSource}}作为首帧、主体身份、外观和场景的主要依据。除非用户明确要求改变，否则必须保持同一人物或产品、五官与轮廓、服装与材质、颜色、背景、构图和镜头视角；只添加用户描述的动作、运镜和必要的自然变化，禁止替换主体、重新设计外观或生成无关场景。" },
    videoFirstFrame: { enabled: true, content: "首尾帧连续性要求：首帧是唯一开场画面；保持其中主体身份、外观、构图和场景，再按用户描述产生连续动作与运镜，禁止重设计主体或换成无关开场。" },
    videoFirstLastFrame: { enabled: true, content: "首尾帧连续性要求：首帧是唯一开场画面，尾帧是唯一结束画面；镜头、主体姿态、光线和环境变化必须在两帧之间自然连续过渡，禁止交换两帧、跳切到无关场景或把尾帧当普通参考图。" },
    minimaxH3Base: { enabled: true, content: "integrated_multimodal_description:\n\n{{frameAlignment}}\n\n{{referenceBindings}}\n\nOriginal user brief (preserve its stated names, dialogue, lyrics, and visible text verbatim):\n\n{{prompt}}\n\noverall_soundscape:\n\nUse only sound, ambience, dialogue, and synchronized actions requested by the original user brief; otherwise use an appropriate coherent soundscape.\n\nnon_diegetic_music:\n\nN/A unless the original user brief explicitly requests music." },
    minimaxH3Reference: { enabled: true, content: "subject_definitions:\n\n{{referenceDefinitions}}\n\nsummary:\n\n[reference generation] Create the requested video while preserving the independently submitted reference bindings below.\n\nretention_analysis:\n\n{{retentionAnalysis}}\n\ndetailed_description:\n\n{{durationDirection}}Original user brief (preserve its stated names, dialogue, lyrics, and visible text verbatim):\n{{prompt}}\n\noverall_soundscape:\n\nUse only audio information explicitly supplied by the bound references or requested by the original user brief; otherwise use an appropriate coherent soundscape.\n\nnon_diegetic_music:\n\nN/A unless the original user brief explicitly requests music." },
    minimaxH3Bindings: { enabled: true, content: "Reference binding lock:\n{{referenceDefinitions}}\nEach label is bound only to the independently submitted reference at its original array position. Do not swap, merge, substitute, renumber, reinterpret, or invent references." },
    image: { enabled: false, content: "" },
    video: { enabled: false, content: "" },
    text: { enabled: false, content: "" },
    audio: { enabled: false, content: "" },
};

export function normalizeGenerationPromptRules(value?: Partial<GenerationPromptRules>): GenerationPromptRules {
    return Object.fromEntries(Object.entries(DEFAULT_GENERATION_PROMPT_RULES).map(([key, fallback]) => {
        const rule = value?.[key as GenerationPromptRuleKey];
        return [key, { enabled: typeof rule?.enabled === "boolean" ? rule.enabled : fallback.enabled, content: typeof rule?.content === "string" ? rule.content : fallback.content }];
    })) as GenerationPromptRules;
}

export function generationPromptRuleContent(rule: GenerationPromptRule, values: Record<string, string> = {}) {
    if (!rule.enabled) return "";
    return rule.content.replace(/\{\{(\w+)\}\}/g, (token, key: string) => values[key] ?? token).trim();
}

export function applyGenerationPromptRule(prompt: string, rule: GenerationPromptRule, values: Record<string, string> = {}) {
    const prefix = generationPromptRuleContent(rule, values);
    return prefix ? `${prefix}\n\n${prompt.trim()}` : prompt.trim();
}
