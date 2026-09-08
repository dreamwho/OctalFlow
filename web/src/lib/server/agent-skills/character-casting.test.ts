import { describe, expect, it } from "vitest";

import { agentSkillPromptHint, agentSkillPromptMode } from "@/lib/agent-skill-presentation";
import { CHARACTER_CASTING_SKILL } from "./character-casting";

describe("演员建立 Skill", () => {
    it("uses the supplied preview and image-node defaults", () => {
        expect(CHARACTER_CASTING_SKILL.name).toBe("演员建立");
        expect(CHARACTER_CASTING_SKILL.workspaces).toEqual(["image", "canvas"]);
        expect(CHARACTER_CASTING_SKILL.nodeModes).toEqual(["image"]);
        expect(CHARACTER_CASTING_SKILL.previewImageUrl).toBe("/skills/previews/character-casting-studio.png");
        expect(CHARACTER_CASTING_SKILL.defaultConfig).toMatchObject({ size: "16:9", quality: "high", count: 1, promptOptional: true });
        expect(agentSkillPromptMode(CHARACTER_CASTING_SKILL)).toBe("optional");
        expect(agentSkillPromptHint(CHARACTER_CASTING_SKILL, "optional")).toContain("人物基础信息");
    });

    it("keeps the three explicit creation modes separate", () => {
        expect(CHARACTER_CASTING_SKILL.instructions).toContain("默认先生成一张单人物图");
        expect(CHARACTER_CASTING_SKILL.instructions).toContain("头肩照片");
        expect(CHARACTER_CASTING_SKILL.instructions).toContain("character turnaround");
        expect(CHARACTER_CASTING_SKILL.instructions).toContain("不得未经用户明确要求自动生成三视图");
    });
});
