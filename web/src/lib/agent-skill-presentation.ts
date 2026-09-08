import type { AgentSkill, AgentSkillWorkspace } from "@/lib/auth/store-types";

export type AgentSkillPromptMode = "required" | "optional";

const OPTIONAL_PROMPT_SKILL_IDS = new Set(["character-design", "skill-character-casting", "yanai-natural-beauty", "image-motion"]);
const OPTIONAL_PROMPT_SKILL_NAMES = new Set(["真人感出图"]);

export function agentSkillPromptMode(skill: Pick<AgentSkill, "id" | "defaultConfig"> & Partial<Pick<AgentSkill, "name">>): AgentSkillPromptMode {
    if (skill.defaultConfig?.promptOptional === true || OPTIONAL_PROMPT_SKILL_IDS.has(skill.id) || OPTIONAL_PROMPT_SKILL_NAMES.has(skill.name?.trim() || "") || skill.id.startsWith("video-remake-")) return "optional";
    return "required";
}

export function agentSkillPromptHint(skill: Pick<AgentSkill, "name" | "description" | "requiresReference">, mode: AgentSkillPromptMode) {
    if (mode === "optional") return skill.requiresReference ? `点击生成，直接基于当前参考素材执行「${skill.name}」；也可继续补充细节。` : `点击生成，直接执行「${skill.name}」的默认流程；也可继续补充要求。`;
    return skill.description ? `${skill.description} 请继续描述主体、场景或目标效果。` : `请继续补充「${skill.name}」需要处理的内容。`;
}

export function agentSkillSupportsWorkspace(skill: Pick<AgentSkill, "workspaces">, workspace: AgentSkillWorkspace) {
    return (skill.workspaces || ["image"]).includes(workspace);
}
