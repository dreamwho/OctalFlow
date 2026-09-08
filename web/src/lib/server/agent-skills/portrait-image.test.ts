import { describe, expect, it } from "vitest";

import { agentSkillPromptMode } from "@/lib/agent-skill-presentation";
import { PORTRAIT_IMAGE_SKILLS } from "./portrait-image";

describe("portrait image skills", () => {
    it("provides three reference-based image skills with previews and optional prompts", () => {
        expect(PORTRAIT_IMAGE_SKILLS.map((skill) => skill.name)).toEqual(["人物真人感优化（发丝凌乱）", "人物真人感优化", "人物分镜12格"]);
        for (const skill of PORTRAIT_IMAGE_SKILLS) {
            expect(skill.workspaces).toEqual(["image", "canvas"]);
            expect(skill.action).toBe("edit");
            expect(skill.requiresReference).toBe(true);
            expect(skill.previewImageUrl).toMatch(/^\/skills\/previews\/.+\.jpg$/);
            expect(agentSkillPromptMode(skill)).toBe("optional");
        }
    });

    it("keeps the defining portrait and storyboard constraints in execution prompts", () => {
        expect(PORTRAIT_IMAGE_SKILLS[0].instructions).toContain("凌乱的几缕头发自然地垂落在脸部");
        expect(PORTRAIT_IMAGE_SKILLS[1].instructions).not.toContain("部分遮住眼睛");
        expect(PORTRAIT_IMAGE_SKILLS[2].instructions).toContain("3 行 4 列");
        expect(PORTRAIT_IMAGE_SKILLS[2].instructions).toContain("低角度仰拍");
        expect(PORTRAIT_IMAGE_SKILLS[2].instructions).toContain("超特写");
    });
});
