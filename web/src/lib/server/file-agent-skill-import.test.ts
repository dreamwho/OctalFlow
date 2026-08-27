import { readFile } from "node:fs/promises";

import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";

import { importAgentSkillFromFile } from "./file-agent-skill-import";

describe("local Agent Skill archive import", () => {
    it("reads the real SKILL.md and bundles nearby reference documents without extracting assets", async () => {
        const archive = zip({
            "casting/SKILL.md": `---\nname: character-casting\ndescription: 角色选角与定妆\nversion: 1.2.0\nmetadata:\n  license: MIT\n---\n# Character Casting\n先建立角色身份，再读取 [面部规则](references/face.md)。`,
            "casting/references/face.md": "保留毛孔、轻微不对称和年龄痕迹，避免蜡像皮肤。",
            "casting/examples/portrait.png": new Uint8Array(1024),
        });

        const result = await importAgentSkillFromFile({ fileName: "casting.zip", fileBuffer: archive });

        expect(result.candidates).toEqual([]);
        expect(result.skill).toMatchObject({ name: "character-casting", sourcePath: "casting/SKILL.md", sourceVersion: "1.2.0", license: "MIT" });
        expect(result.skill?.instructions).toContain("先建立角色身份");
        expect(result.skill?.instructions).toContain("保留毛孔");
        expect(result.skill?.instructions).not.toContain("portrait.png");
    });

    it("returns every SKILL.md candidate and only accepts a selected candidate from that archive", async () => {
        const archive = zip({
            "bundle/skills/story/SKILL.md": "---\nname: story\n---\n# Story\n拆解剧情结构并校验每集钩子。",
            "bundle/skills/shot/SKILL.md": "---\nname: shot\n---\n# Shot\n拆解镜头语言并保持连续性。",
            "bundle/README.md": "不是技能入口",
        });
        const listed = await importAgentSkillFromFile({ fileName: "drama.zip", fileBuffer: archive });

        expect(listed.skill).toBeUndefined();
        expect(listed.candidates.map((item) => item.path)).toEqual(["bundle/skills/shot/SKILL.md", "bundle/skills/story/SKILL.md"]);

        const selected = await importAgentSkillFromFile({ fileName: "drama.zip", fileBuffer: archive, selectedPath: "bundle/skills/story/SKILL.md" });
        expect(selected.skill).toMatchObject({ name: "story", sourcePath: "bundle/skills/story/SKILL.md" });
        await expect(importAgentSkillFromFile({ fileName: "drama.zip", fileBuffer: archive, selectedPath: "bundle/README.md" })).rejects.toThrow("不属于当前压缩包");
    });

    it("rejects unsafe paths and unsupported file types", async () => {
        const traversal = zip({ "../SKILL.md": "# Unsafe\n不应被读取。" });
        await expect(importAgentSkillFromFile({ fileName: "unsafe.zip", fileBuffer: traversal })).rejects.toThrow("不安全路径");
        await expect(importAgentSkillFromFile({ fileName: "skill.7z", fileBuffer: Buffer.from("data") })).rejects.toMatchObject({ status: 415 });
    });

    it.runIf(Boolean(process.env.LOCAL_SKILL_RAR_FIXTURE))("reads RAR5 Skill packages through the in-process parser", async () => {
        const path = process.env.LOCAL_SKILL_RAR_FIXTURE!;
        const result = await importAgentSkillFromFile({ fileName: "minimax.rar", fileBuffer: await readFile(path) });
        expect(result.candidates.some((candidate) => candidate.path === "h3-prompt-writing/SKILL.md")).toBe(true);
        const selected = await importAgentSkillFromFile({ fileName: "minimax.rar", fileBuffer: await readFile(path), selectedPath: "h3-prompt-writing/SKILL.md" });
        expect(selected.skill).toMatchObject({ name: "h3-prompt-writing", sourcePath: "h3-prompt-writing/SKILL.md" });
        expect(selected.skill?.instructions).toContain("integrated_multimodal_description");
    });
});

function zip(entries: Record<string, string | Uint8Array>) {
    return Buffer.from(
        zipSync(
            Object.fromEntries(Object.entries(entries).map(([path, value]) => [path, typeof value === "string" ? strToU8(value) : value])),
            { level: 6 },
        ),
    );
}
