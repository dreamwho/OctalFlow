import { describe, expect, it } from "vitest";

import { MINIMAX_H3_OFFICIAL_STYLE_SKILLS, cloneMinimaxH3OfficialStyleSkill } from "./minimax-h3-official";

describe("native MiniMax H3 style skills", () => {
    it("enables only the directly executable hand-drawn live workflow", () => {
        expect(MINIMAX_H3_OFFICIAL_STYLE_SKILLS).toHaveLength(8);
        const enabled = MINIMAX_H3_OFFICIAL_STYLE_SKILLS.filter((skill) => skill.enabled);

        expect(enabled.map((skill) => skill.id)).toEqual(["minimax-h3-handdrawn-live"]);
        expect(enabled[0]).toMatchObject({
            nodeModes: ["video"],
            modelConstraints: { capability: "video", requiredModelFamilies: ["minimax-h3"] },
        });
        expect(enabled[0].instructions).toContain("具名参考");
        expect(enabled[0].instructions).toContain("不得把参考素材概括成模糊“灵感”");
        expect(enabled[0].defaultConfig).not.toHaveProperty("videoSeconds");
    });

    it("keeps complex workflows disabled with explicit confirmation stages and provenance", () => {
        const staged = MINIMAX_H3_OFFICIAL_STYLE_SKILLS.filter((skill) => !skill.enabled);

        expect(staged).toHaveLength(7);
        for (const skill of staged) {
            expect(skill.nodeModes).toEqual([]);
            expect(skill.modelConstraints).toEqual({ capability: "video", preferredModelFamilies: ["minimax-h3"] });
            expect(skill.stages?.some((item) => item.requiresUserConfirmation)).toBe(true);
            expect(skill.sourceRepository).toBe("MiniMax-AI/MiniMax-H3");
            expect(skill.sourcePath).toMatch(/\/SKILL\.md$/);
            expect(skill.sourceContentHash).toMatch(/^[a-f0-9]{64}$/);
            expect(skill.defaultConfig).not.toHaveProperty("videoSeconds");
        }
    });

    it("uses native instructions rather than copied third-party brand, font, or tool defaults", () => {
        const text = MINIMAX_H3_OFFICIAL_STYLE_SKILLS.map((skill) => `${skill.name}\n${skill.description}\n${skill.instructions}`).join("\n");

        expect(text).not.toMatch(/Apple|SF Pro|music-2\.6|Seedance/i);
        expect(text).toContain("当前已解析的视频模型能力");
    });

    it("clones nested catalog metadata before settings persistence", () => {
        const source = MINIMAX_H3_OFFICIAL_STYLE_SKILLS.find((skill) => skill.id === "minimax-h3-brand-promo")!;
        const copy = cloneMinimaxH3OfficialStyleSkill(source);
        copy.keywords.push("测试");
        copy.requiredAssetRoles?.[0].acceptedAssetTypes.push("audio");
        copy.stages?.[0] && (copy.stages[0].label = "已修改");

        expect(source.keywords).not.toContain("测试");
        expect(source.requiredAssetRoles?.[0].acceptedAssetTypes).not.toContain("audio");
        expect(source.stages?.[0].label).not.toBe("已修改");
    });
});
