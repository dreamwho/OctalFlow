export const DEFAULT_MODEL_PICKER_GROUPS = [
    "Google Gemini", "ByteDance Seedream", "OpenAI", "MiniMax", "Anthropic", "阿里云 / 通义千问", "DeepSeek", "智谱 GLM", "xAI", "其他模型",
];

export function inferredModelPickerGroup(value: string) {
    const name = value.toLowerCase();
    if (/gemini|google|imagen|veo/.test(name)) return "Google Gemini";
    if (/seedream|seedance|dreamina|jimeng|即梦|doubao|bytedance/.test(name)) return "ByteDance Seedream";
    if (/gpt|openai/.test(name)) return "OpenAI";
    if (/minimax|hailuo|海螺|(?:^|[-_ ])(?:speech|music)-/.test(name)) return "MiniMax";
    if (/claude|anthropic/.test(name)) return "Anthropic";
    if (/qwen|aliyun|bailian|cosyvoice|通义/.test(name)) return "阿里云 / 通义千问";
    if (/deepseek/.test(name)) return "DeepSeek";
    if (/glm|chatglm|智谱/.test(name)) return "智谱 GLM";
    if (/grok|xai/.test(name)) return "xAI";
    return "其他模型";
}

export function normalizeModelPickerGroups(value: unknown) {
    if (!Array.isArray(value)) return [...DEFAULT_MODEL_PICKER_GROUPS];
    const groups = Array.from(new Set(value.filter((item): item is string => typeof item === "string").map((item) => item.trim().slice(0, 80)).filter(Boolean)));
    return groups.length ? groups : [...DEFAULT_MODEL_PICKER_GROUPS];
}
