import { describe, expect, it } from "vitest";

import { agentSkillSupportsNodeMode } from "@/lib/agent-skill-node-policy";
import { normalizeAgentSkill, normalizeAgentSkills } from "./store-normalizers";
import { MINIMAX_H3_OFFICIAL_STYLE_SKILLS } from "@/lib/server/agent-skills/minimax-h3-official";

describe("normalizeAgentSkill", () => {
    it("derives a zero-configuration planner summary and preserves full execution instructions", () => {
        const instructions = "完整执行规则".repeat(100);
        const skill = normalizeAgentSkill({ id: "skill", name: "技能", description: "用于规划的简要用途", instructions, enabled: true, keywords: [] });

        expect(skill.plannerSummary).toBe("用于规划的简要用途");
        expect(skill.instructions).toBe(instructions);
    });

    it("limits an explicit planner summary to 240 characters", () => {
        const skill = normalizeAgentSkill({ id: "skill", name: "技能", description: "", plannerSummary: "a".repeat(300), instructions: "执行", enabled: true, keywords: [] });

        expect(skill.plannerSummary).toHaveLength(240);
    });

    it("normalizes node media modes independently from Agent workspaces", () => {
        const imageSkill = normalizeAgentSkill({ id: "ecommerce-image", name: "电商生图", description: "", instructions: "执行", enabled: true, keywords: [], workspaces: ["image", "canvas"] });
        const agentOnlySkill = normalizeAgentSkill({ id: "skill-drama-pipeline", name: "短剧全流程导演", description: "", instructions: "执行", enabled: true, keywords: [], workspaces: ["image", "video", "canvas", "drama"] });
        const explicitlyAgentOnly = normalizeAgentSkill({ id: "ecommerce-image", name: "电商生图", description: "", instructions: "执行", enabled: true, keywords: [], nodeModes: [] });

        expect(imageSkill.nodeModes).toEqual(["image"]);
        expect(agentOnlySkill.nodeModes).toEqual([]);
        expect(explicitlyAgentOnly.nodeModes).toEqual([]);
    });

    it("migrates a persisted custom image-and-canvas Skill with a legacy empty node mode", () => {
        const skill = normalizeAgentSkill({
            id: "local-image-prompt-director",
            name: "真人感出图",
            description: "真人感图片提示词",
            instructions: "整理真人感图片生成规则",
            enabled: true,
            keywords: ["真人感"],
            workspaces: ["image", "canvas"],
            nodeModes: [],
        });

        expect(skill.nodeModes).toEqual(["image"]);
        expect(agentSkillSupportsNodeMode(skill, "image")).toBe(true);
        expect(agentSkillSupportsNodeMode(skill, "video")).toBe(false);
    });

    it("preserves normalized GitHub provenance across settings persistence", () => {
        const skill = normalizeAgentSkill({
            id: "github-skill",
            name: "公开 Skill",
            description: "公开说明",
            instructions: "完整执行规则",
            enabled: false,
            keywords: [],
            sourceUrl: " https://github.com/acme/skills/blob/0123456789abcdef0123456789abcdef01234567/SKILL.md ",
            sourceRepository: " acme/skills ",
            sourcePath: " poster/SKILL.md ",
            sourceVersion: " 0123456789abcdef0123456789abcdef01234567 ",
            sourceCommit: " 0123456789abcdef0123456789abcdef01234567 ",
            sourceContentHash: ` ${"a".repeat(64)} `,
            previewImageUrl: " /skills/previews/example.jpg ",
            license: " MIT ",
        });

        expect(skill).toMatchObject({
            enabled: false,
            sourceUrl: "https://github.com/acme/skills/blob/0123456789abcdef0123456789abcdef01234567/SKILL.md",
            sourceRepository: "acme/skills",
            sourcePath: "poster/SKILL.md",
            sourceVersion: "0123456789abcdef0123456789abcdef01234567",
            sourceCommit: "0123456789abcdef0123456789abcdef01234567",
            sourceContentHash: "a".repeat(64),
            previewImageUrl: "/skills/previews/example.jpg",
            license: "MIT",
        });
    });

    it("adds the built-in portrait image skills to existing settings with their preview assets", () => {
        const skills = normalizeAgentSkills([{ id: "custom", name: "自定义", description: "", instructions: "执行", enabled: true, keywords: [] }]);

        expect(skills).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ id: "portrait-realism-messy-hair", previewImageUrl: "/skills/previews/portrait-realism-messy-hair.jpg" }),
                expect.objectContaining({ id: "portrait-realism", previewImageUrl: "/skills/previews/portrait-realism.jpg" }),
                expect.objectContaining({ id: "character-storyboard-12-grid", previewImageUrl: "/skills/previews/character-storyboard-12-grid.jpg" }),
            ]),
        );
    });

    it("replaces the legacy local actor skill with the current backend-managed definition", () => {
        const skills = normalizeAgentSkills([
            {
                id: "skill-character-casting",
                name: "角色选角与定妆",
                description: "旧版规则",
                instructions: "旧版规则",
                enabled: true,
                keywords: ["选角"],
                workspaces: ["image", "canvas", "drama"],
                sourceVersion: "local-legacy",
            },
        ]);

        expect(skills.find((skill) => skill.id === "skill-character-casting")).toMatchObject({
            name: "演员建立",
            previewImageUrl: "/skills/previews/character-casting-studio.png",
            workspaces: ["image", "canvas"],
            nodeModes: ["image"],
        });
    });

    it("keeps only recognized model, asset-role, and staged-confirmation metadata", () => {
        const skill = normalizeAgentSkill({
            id: "h3-workflow",
            name: "H3 工作流",
            description: "说明",
            instructions: "执行",
            enabled: true,
            keywords: [],
            modelConstraints: { capability: "video", requiredModelFamilies: ["minimax-h3", "other" as never], preferredModelFamilies: ["other" as never] },
            requiredAssetRoles: [
                { id: " product reference ", label: " 产品图 ", required: true, acceptedAssetTypes: ["image", "other" as never] },
                { id: "", label: "无效", required: true, acceptedAssetTypes: ["image"] },
            ],
            stages: [
                { id: " preview ", label: " 预览确认 ", description: " 核对预览 ", requiresUserConfirmation: true },
                { id: "", label: "无效", description: "无效" },
            ],
        });

        expect(skill).toMatchObject({
            modelConstraints: { capability: "video", requiredModelFamilies: ["minimax-h3"] },
            requiredAssetRoles: [{ id: "product-reference", label: "产品图", required: true, acceptedAssetTypes: ["image"] }],
            stages: [{ id: "preview", label: "预览确认", description: "核对预览", requiresUserConfirmation: true }],
        });
    });

    it("adds native H3 styles with safe defaults while preserving an administrator enable choice", () => {
        const handdrawn = MINIMAX_H3_OFFICIAL_STYLE_SKILLS.find((skill) => skill.id === "minimax-h3-handdrawn-live")!;
        const brand = MINIMAX_H3_OFFICIAL_STYLE_SKILLS.find((skill) => skill.id === "minimax-h3-brand-promo")!;
        const skills = normalizeAgentSkills([
            { ...handdrawn, enabled: false, modelConstraints: undefined, requiredAssetRoles: undefined, stages: undefined },
            { ...brand, enabled: true, modelConstraints: undefined, requiredAssetRoles: undefined, stages: undefined },
        ]);

        expect(skills.find((skill) => skill.id === handdrawn.id)).toMatchObject({
            enabled: false,
            modelConstraints: { capability: "video", requiredModelFamilies: ["minimax-h3"] },
        });
        expect(skills.find((skill) => skill.id === brand.id)).toMatchObject({
            enabled: true,
            modelConstraints: { capability: "video", preferredModelFamilies: ["minimax-h3"] },
            stages: expect.arrayContaining([expect.objectContaining({ requiresUserConfirmation: true })]),
        });
        expect(skills.filter((skill) => skill.id.startsWith("minimax-h3-") && skill.id !== handdrawn.id).every((skill) => skill.enabled === false || skill.id === brand.id)).toBe(true);
    });

    it("retires the legacy selectable H3 prompt skill now that H3 prompt compilation is automatic", () => {
        const skills = normalizeAgentSkills([{ id: "skill-minimax-h3-prompt", name: "MiniMax H3 视频提示词", description: "旧入口", instructions: "旧规则", enabled: true, keywords: [] }]);

        expect(skills.some((skill) => skill.id === "skill-minimax-h3-prompt")).toBe(false);
        expect(skills.some((skill) => skill.id === "minimax-h3-handdrawn-live")).toBe(true);
    });
});
