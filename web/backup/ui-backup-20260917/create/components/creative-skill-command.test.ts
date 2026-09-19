import { describe, expect, it } from "vitest";

import { creativeSkillCommandAtCursor, creativeSkillMatchesQuery, removeCreativeSkillCommand } from "./creative-skill-command";

describe("creativeSkillCommandAtCursor", () => {
    it("识别行首和空格后的 Skill 命令", () => {
        expect(creativeSkillCommandAtCursor("/电影", 3)).toEqual({ start: 0, end: 3, query: "电影" });
        expect(creativeSkillCommandAtCursor("生成角色 /选角", 8)).toEqual({ start: 5, end: 8, query: "选角" });
    });

    it("不把 URL 或普通路径识别为 Skill 命令", () => {
        expect(creativeSkillCommandAtCursor("https://example.com", 19)).toBeNull();
        expect(creativeSkillCommandAtCursor("目录/文件", 5)).toBeNull();
    });

    it("选择后只移除当前斜杠查询", () => {
        expect(removeCreativeSkillCommand("生成角色 /选角 保持黑发", { start: 5, end: 8, query: "选角" })).toEqual({ value: "生成角色 保持黑发", cursor: 5 });
    });
});

describe("creativeSkillMatchesQuery", () => {
    it("按名称和说明进行中文匹配", () => {
        const skill = { name: "电影感生图", description: "优化构图、光影和综合色" };
        expect(creativeSkillMatchesQuery(skill, "电影")).toBe(true);
        expect(creativeSkillMatchesQuery(skill, "光影")).toBe(true);
        expect(creativeSkillMatchesQuery(skill, "配音")).toBe(false);
    });
});
