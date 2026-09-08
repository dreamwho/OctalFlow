import type { AgentSkill, AgentSkillNodeMode, AgentSkillWorkspace } from "@/lib/auth/store-types";

const BUILT_IN_NODE_MODES: Record<string, AgentSkillNodeMode> = {
    "ecommerce-image": "image",
    "yanai-natural-beauty": "image",
    "character-design": "image",
    "skill-character-casting": "image",
    "skill-cinema-dna-21x9": "image",
    "skill-fantasy-poster": "image",
    "portrait-realism-messy-hair": "image",
    "portrait-realism": "image",
    "character-storyboard-12-grid": "image",
    "image-motion": "video",
    "skill-seedance-director": "video",
    "skill-minimax-h3-prompt": "video",
};

const BUILT_IN_AGENT_ONLY_SKILL_IDS = new Set(["drama-planning", "skill-drama-pipeline", "skill-real-vlog"]);

export function isBuiltInAgentSkillId(skillId: string) {
    return Boolean(BUILT_IN_NODE_MODES[skillId]) || BUILT_IN_AGENT_ONLY_SKILL_IDS.has(skillId) || skillId.startsWith("video-remake-") || skillId.startsWith("minimax-h3-");
}

export function inferAgentSkillNodeModes(workspaces: readonly AgentSkillWorkspace[] | undefined): AgentSkillNodeMode[] {
    const mediaModes = [...new Set((workspaces || ["image"]).filter((workspace): workspace is AgentSkillNodeMode => workspace === "image" || workspace === "video"))];
    return mediaModes.length === 1 ? mediaModes : [];
}

export function defaultAgentSkillNodeModes(skillId: string): AgentSkillNodeMode[] {
    const mode = BUILT_IN_NODE_MODES[skillId];
    return mode ? [mode] : [];
}

export function resolveAgentSkillNodeModes(skill: Pick<AgentSkill, "id" | "nodeModes" | "workspaces">) {
    const configuredNodeModes = Array.isArray(skill.nodeModes) ? [...new Set(skill.nodeModes.filter((item): item is AgentSkillNodeMode => item === "image" || item === "video"))] : undefined;
    if (isBuiltInAgentSkillId(skill.id)) return configuredNodeModes ?? defaultAgentSkillNodeModes(skill.id);
    return configuredNodeModes?.length ? configuredNodeModes : inferAgentSkillNodeModes(skill.workspaces);
}

export function agentSkillSupportsNodeMode(skill: Pick<AgentSkill, "id" | "nodeModes" | "workspaces">, mode: AgentSkillNodeMode) {
    const nodeModes = resolveAgentSkillNodeModes(skill);
    return nodeModes.length === 1 && nodeModes[0] === mode;
}
