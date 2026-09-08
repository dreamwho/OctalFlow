export const CREATE_AGENT_PROMPT_MAX_LENGTH = 4000;

export const CREATE_AGENT_MODES = ["agent", "image", "video", "audio"] as const;

export type CreateAgentMode = (typeof CREATE_AGENT_MODES)[number];
export type CreateAgentPromptSource = "gallery" | "home";

type CreateAgentPromptOptions = {
    source?: CreateAgentPromptSource;
    mode?: CreateAgentMode;
    skillIds?: string[];
    modelIds?: string[];
};

export type CreateAgentDraft = {
    source: CreateAgentPromptSource;
    prompt: string;
    mode?: CreateAgentMode;
    skillIds?: string[];
    modelIds?: string[];
};

export function createAgentPromptHref(value: string, options: CreateAgentPromptOptions = {}) {
    const prompt = value.trim().slice(0, CREATE_AGENT_PROMPT_MAX_LENGTH);
    const skillIds = normalizeSelectionIds(options.skillIds, 8);
    const modelIds = normalizeSelectionIds(options.modelIds, 6);
    if (!prompt && (!options.mode || options.mode === "agent") && !skillIds.length && !modelIds.length) return "/create";
    const params = new URLSearchParams({ source: options.source || "gallery" });
    if (prompt) params.set("prompt", prompt);
    if (options.mode) params.set("mode", options.mode);
    if (skillIds.length) params.set("skills", skillIds.join(","));
    if (modelIds.length) params.set("models", modelIds.join(","));
    return `/create#${params}`;
}

export function createAgentPromptFromHash(value: string) {
    return createAgentDraftFromHash(value)?.prompt || "";
}

export function createAgentDraftFromHash(value: string): CreateAgentDraft | null {
    const params = new URLSearchParams(value.replace(/^#/, ""));
    const source = params.get("source");
    if (source !== "gallery" && source !== "home") return null;
    const mode = params.get("mode");
    const skillIds = normalizeSelectionIds(params.get("skills")?.split(","), 8);
    const modelIds = normalizeSelectionIds(params.get("models")?.split(","), 6);
    return {
        source,
        prompt: (params.get("prompt") || "").trim().slice(0, CREATE_AGENT_PROMPT_MAX_LENGTH),
        ...(isCreateAgentMode(mode) ? { mode } : {}),
        ...(skillIds.length ? { skillIds } : {}),
        ...(modelIds.length ? { modelIds } : {}),
    };
}

function normalizeSelectionIds(values: string[] | undefined, limit: number) {
    return Array.from(new Set((values || []).map((value) => value.trim()).filter((value) => /^[a-z0-9][a-z0-9_.:/-]{0,127}$/i.test(value)))).slice(0, limit);
}

function isCreateAgentMode(value: string | null): value is CreateAgentMode {
    return CREATE_AGENT_MODES.includes(value as CreateAgentMode);
}
