export const CREATE_AGENT_PROMPT_MAX_LENGTH = 4000;

export const CREATE_AGENT_MODES = ["agent", "image", "video", "audio"] as const;

export type CreateAgentMode = (typeof CREATE_AGENT_MODES)[number];
export type CreateAgentPromptSource = "gallery" | "home";

type CreateAgentPromptOptions = {
    source?: CreateAgentPromptSource;
    mode?: CreateAgentMode;
    skillIds?: string[];
};

export type CreateAgentDraft = {
    source: CreateAgentPromptSource;
    prompt: string;
    mode?: CreateAgentMode;
    skillIds?: string[];
};

export function createAgentPromptHref(value: string, options: CreateAgentPromptOptions = {}) {
    const prompt = value.trim().slice(0, CREATE_AGENT_PROMPT_MAX_LENGTH);
    const skillIds = normalizeSkillIds(options.skillIds);
    if (!prompt && (!options.mode || options.mode === "agent") && !skillIds.length) return "/create";
    const params = new URLSearchParams({ source: options.source || "gallery" });
    if (prompt) params.set("prompt", prompt);
    if (options.mode) params.set("mode", options.mode);
    if (skillIds.length) params.set("skills", skillIds.join(","));
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
    const skillIds = normalizeSkillIds(params.get("skills")?.split(","));
    return {
        source,
        prompt: (params.get("prompt") || "").trim().slice(0, CREATE_AGENT_PROMPT_MAX_LENGTH),
        ...(isCreateAgentMode(mode) ? { mode } : {}),
        ...(skillIds.length ? { skillIds } : {}),
    };
}

function normalizeSkillIds(values?: string[]) {
    return Array.from(new Set((values || []).map((value) => value.trim()).filter((value) => /^[a-z0-9][a-z0-9_-]{0,79}$/i.test(value)))).slice(0, 8);
}

function isCreateAgentMode(value: string | null): value is CreateAgentMode {
    return CREATE_AGENT_MODES.includes(value as CreateAgentMode);
}
