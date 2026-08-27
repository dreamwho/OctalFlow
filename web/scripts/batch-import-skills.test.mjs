import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("真人感 Vlog Skill", () => {
    it("为完整一天 Vlog 提供六分镜默认值和参考图角色约束", async () => {
        const source = await readFile(resolve(process.cwd(), "scripts/batch-import-skills.mjs"), "utf8");
        const vlog = source.slice(source.indexOf('id: "skill-real-vlog"'), source.indexOf("\n    },", source.indexOf('id: "skill-real-vlog"')));

        expect(vlog).toContain("完整 Vlog 默认规划 6 个分镜，不得少于 6 个");
        expect(vlog).toContain("不得复制参考图的背景、动作或构图");
        expect(vlog).toContain("本轮调用的 Skill 名称与分镜数量");
    });
});
