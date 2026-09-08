import { describe, expect, it } from "vitest";

import { agentSkillPromptHint, agentSkillPromptMode, agentSkillSupportsWorkspace } from "./agent-skill-presentation";

describe("agent skill presentation", () => {
    it("allows direct generation for explicit prompt-optional skills", () => {
        expect(agentSkillPromptMode({ id: "character-design" })).toBe("optional");
        expect(agentSkillPromptMode({ id: "video-remake-vlog" })).toBe("optional");
        expect(agentSkillPromptMode({ id: "skill-QxZRTQJC", name: "真人感出图" })).toBe("optional");
    });

    it("keeps other skills prompt-required", () => {
        expect(agentSkillPromptMode({ id: "skill-cinema-dna-21x9" })).toBe("required");
    });

    it("describes reference requirements and filters media workspaces", () => {
        expect(agentSkillPromptHint({ id: "other", name: "角色三视图", description: "", requiresReference: true }, "optional")).toContain("参考素材");
        expect(agentSkillPromptHint({ id: "skill-character-casting", name: "演员建立", description: "", requiresReference: false }, "optional")).toContain("人物基础信息");
        expect(agentSkillSupportsWorkspace({ workspaces: ["image", "canvas"] }, "image")).toBe(true);
        expect(agentSkillSupportsWorkspace({ workspaces: ["image", "canvas"] }, "video")).toBe(false);
    });
});
