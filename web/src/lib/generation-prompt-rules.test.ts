import { describe, expect, it } from "vitest";
import { applyGenerationPromptRule, DEFAULT_GENERATION_PROMPT_RULES, normalizeGenerationPromptRules } from "./generation-prompt-rules";
import { buildImageReferencePromptText } from "./image-reference-prompt";
import { buildPanoramaPrompt } from "@/app/(user)/canvas/utils/canvas-panorama";
import { withVideoReferenceFidelity } from "./server/video-task-config";

const image = { type: "image" as const, url: "https://example.com/image.png" };

describe("administrator generation prompt rules", () => {
    it("preserves the existing default image constraints and numbers real references", () => {
        const result = buildImageReferencePromptText("换成新服装", [{}, {}]);
        expect(result).toContain("Reference images: 图片1, 图片2.");
        expect(result).toContain("参考图片编号：图片1、图片2。");
        expect(result).toContain("Do not replace the referenced person");
        expect(result.endsWith("\n\n换成新服装")).toBe(true);
    });
    it("disables image instructions without removing the user's request", () => {
        expect(buildImageReferencePromptText("换成新服装", [{}], { enabled: false, content: "不要换衣服" })).toBe("换成新服装");
        expect(buildImageReferencePromptText("换成新服装", [], DEFAULT_GENERATION_PROMPT_RULES.imageReference)).toBe("换成新服装");
    });
    it("uses edited content literally, without falling back when emptied", () => {
        expect(buildImageReferencePromptText("换装", [{}, {}], { enabled: true, content: "只保留 {{referenceLabelsZh}} 的脸。" })).toBe("只保留 图片1、图片2 的脸。\n\n换装");
        expect(buildImageReferencePromptText("换装", [{}], { enabled: true, content: "" })).toBe("换装");
        expect(normalizeGenerationPromptRules({ imageReference: { enabled: false, content: "" } }).imageReference).toEqual({ enabled: false, content: "" });
    });
    it("independently controls video reference, first-frame and first/last-frame policies", () => {
        const rules = structuredClone(DEFAULT_GENERATION_PROMPT_RULES);
        rules.videoReference = { enabled: false, content: "原约束" };
        expect(withVideoReferenceFidelity("换装", [image], rules)).toBe("换装");
        rules.videoFirstFrame = { enabled: true, content: "从指定帧开场，不限制服装" };
        expect(withVideoReferenceFidelity("换装", [{ ...image, role: "first_frame" }], rules)).toBe("换装\n\n从指定帧开场，不限制服装");
        rules.videoFirstLastFrame.enabled = false;
        expect(withVideoReferenceFidelity("换装", [{ ...image, role: "first_frame" }, { ...image, role: "last_frame" }], rules)).toBe("换装");
        expect(withVideoReferenceFidelity("无参考图", [], rules)).toBe("无参考图");
    });
    it("allows editing or disabling panorama constraints without affecting the base request", () => {
        const initial = buildPanoramaPrompt("城市大厅", true);
        expect(buildPanoramaPrompt(initial, true)).toBe(initial);
        expect(buildPanoramaPrompt(initial, true, { enabled: false, content: "旧规则" })).toBe("城市大厅");
        expect(buildPanoramaPrompt("城市大厅", false, { enabled: true, content: "全景内容由管理员设定" })).toBe("城市大厅\n\n[全景输出约束]\n全景内容由管理员设定");
    });
    it("keeps generic modality rules independent", () => {
        const rules = structuredClone(DEFAULT_GENERATION_PROMPT_RULES);
        rules.image = { enabled: true, content: "允许重设角色" };
        expect(applyGenerationPromptRule("用户正文", rules.image)).toBe("允许重设角色\n\n用户正文");
        expect(applyGenerationPromptRule("用户正文", rules.video)).toBe("用户正文");
    });
});
