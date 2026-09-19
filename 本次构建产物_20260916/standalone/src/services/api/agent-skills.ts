import type { AgentSkillModelConstraints, AgentSkillNodeMode, AgentSkillRequiredAssetRole, AgentSkillStage, AgentSkillWorkspace } from "@/lib/auth/store-types";
import { agentSkillSupportsNodeMode } from "@/lib/agent-skill-node-policy";

export type AgentSkillSummary = {
    id: string;
    name: string;
    description: string;
    keywords?: string[];
    action?: "generate" | "edit";
    requiresReference?: boolean;
    modelConstraints?: AgentSkillModelConstraints;
    requiredAssetRoles?: AgentSkillRequiredAssetRole[];
    stages?: AgentSkillStage[];
    previewImageUrl?: string;
    defaultConfig?: Record<string, string | number | boolean>;
    workspaces?: AgentSkillWorkspace[];
    nodeModes?: readonly AgentSkillNodeMode[];
    promptMode?: "required" | "optional";
    promptHint?: string;
};

export function agentSkillSupportsMode(skill: AgentSkillSummary, mode: "image" | "video") {
    return agentSkillSupportsNodeMode(skill, mode);
}

type ApiResponse<T> = { code: number; data: T; msg: string };

export async function listAgentSkills(workspace: AgentSkillWorkspace | "all" = "all"): Promise<AgentSkillSummary[]> {
    const response = await fetch(`/api/agent/skills?workspace=${encodeURIComponent(workspace)}`, { cache: "no-store" });
    const payload = (await response.json().catch(() => null)) as ApiResponse<{ skills: AgentSkillSummary[] }> | null;
    if (!response.ok || !payload || payload.code !== 0) throw new Error(payload?.msg || "获取创作 Skill 失败");
    return payload.data.skills;
}

export async function listNodeAgentSkills(mode: AgentSkillNodeMode): Promise<AgentSkillSummary[]> {
    const response = await fetch(`/api/agent/skills?workspace=all&nodeMode=${encodeURIComponent(mode)}`, { cache: "no-store" });
    const payload = (await response.json().catch(() => null)) as ApiResponse<{ skills: AgentSkillSummary[] }> | null;
    if (!response.ok || !payload || payload.code !== 0) throw new Error(payload?.msg || "获取节点 Skill 失败");
    return payload.data.skills;
}

export const getPublicAgentSkills = listAgentSkills;
