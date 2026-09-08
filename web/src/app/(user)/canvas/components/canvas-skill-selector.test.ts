import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { CANVAS_SKILL_CATEGORIES, canvasSkillMatchesCategory } from "./canvas-skill-selector";

describe("canvas skill selector categories", () => {
    it("keeps categories and search in one compact toolbar above a dense grid", () => {
        expect(CANVAS_SKILL_CATEGORIES.map((category) => category.label)).toEqual(["全部技能", "短剧导演", "真人Vlog", "角色定妆", "电影画幅", "微表情", "AI 视频", "视觉海报"]);

        const source = readFileSync(new URL("./canvas-skill-selector.tsx", import.meta.url), "utf8");
        expect(source).toContain('role="tablist"');
        expect(source).toContain('data-canvas-skill-toolbar');
        expect(source).toContain('aria-label="搜索 Skill"');
        expect(source).toContain("lg:grid-cols-3");
        expect(source).toContain("whitespace-nowrap");
        expect(source).toContain("visibleCategories.map");
        expect(source).toContain("<AgentSkillPreview skill={skill}");
        expect(source).toContain('data-canvas-skill-dialog');
        expect(source).toContain('width="min(1000px, calc(100vw - 24px))"');
        expect(source).toContain('max-h-[min(640px,calc(100dvh-48px))]');
        expect(source).not.toContain("选择后由默认文本模型融合到本次生成提示词");
    });

    it("matches only semantically relevant node categories", () => {
        expect(canvasSkillMatchesCategory({ id: "portrait-realism", name: "人物真人感优化", description: "", nodeModes: ["image"] }, "casting")).toBe(true);
        expect(canvasSkillMatchesCategory({ id: "portrait-realism", name: "人物真人感优化", description: "", nodeModes: ["image"] }, "vlog")).toBe(false);
        expect(canvasSkillMatchesCategory({ id: "image-motion", name: "图片动效", description: "", nodeModes: ["video"] }, "video")).toBe(true);
    });
});
