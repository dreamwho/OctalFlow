import type { AgentSkillImportResult } from "@/lib/agent-skill-import-types";

export type { AgentSkillImportCandidate, AgentSkillImportResult, ImportedAgentSkill } from "@/lib/agent-skill-import-types";

export async function importAgentSkillFromGithub(input: { url: string; path?: string }): Promise<AgentSkillImportResult> {
    const response = await fetch("/api/admin/agent-skills/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
    });
    const payload = (await response.json().catch(() => null)) as { data?: AgentSkillImportResult; error?: string } | null;
    if (!response.ok || !payload?.data) throw new Error(payload?.error || "AI 提取 GitHub Skill 失败");
    return payload.data;
}

export async function importAgentSkillFromFile(input: { file: File; path?: string }): Promise<AgentSkillImportResult> {
    const formData = new FormData();
    formData.append("file", input.file);
    if (input.path) formData.append("path", input.path);

    const response = await fetch("/api/admin/agent-skills/import-file", {
        method: "POST",
        body: formData,
    });
    const payload = (await response.json().catch(() => null)) as { data?: AgentSkillImportResult; msg?: string } | null;
    if (!response.ok || !payload?.data) throw new Error(payload?.msg || "解析本地压缩包 Skill 失败");
    return payload.data;
}
