import { describe, expect, it } from "vitest";

import { dramaVisualStylePrompt, getDramaVisualStylePreset } from "./drama-visual-style-presets";

describe("drama visual style presets", () => {
    it("compiles camera language, grading, equipment and production design", () => {
        const prompt = dramaVisualStylePrompt("真人 Vlog", "live-vlog");
        expect(prompt).toContain("镜头语言：");
        expect(prompt).toContain("调色：");
        expect(prompt).toContain("iPhone 17 Pro");
        expect(prompt).toContain("美术设计：");
    });

    it("keeps a custom style as an additional direction", () => {
        expect(dramaVisualStylePrompt("雨夜蓝紫霓虹", "cinematic-realism")).toContain("补充风格：雨夜蓝紫霓虹");
    });

    it("resolves legacy labels to a stable preset", () => {
        expect(getDramaVisualStylePreset(undefined, "电影感国漫").id).toBe("cinematic-guoman");
    });
});
