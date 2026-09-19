import { describe, expect, it } from "vitest";

import { applyCameraMotionPrompt, cameraMotionPromptToken, CANVAS_CAMERA_MOTIONS, getCanvasCameraMotion, inferCameraMotionPreviewClass } from "./canvas-camera-motion";
import { insertTextAtSelection } from "../components/canvas-resource-mention-textarea";

describe("canvas camera motion", () => {
    it("expands a named inline camera-motion token at its original position", () => {
        const motion = getCanvasCameraMotion("tilt-up")!;
        const prompt = `人物走进车库，${cameraMotionPromptToken(motion)}随后抬头。`;

        expect(applyCameraMotionPrompt(prompt)).toBe("人物走进车库，摄影机由下向上平稳摇摄，垂直透视自然，从细节过渡到主体全貌。随后抬头。");
    });

    it("keeps ordinary bracketed text intact", () => {
        expect(applyCameraMotionPrompt("人物走进车库【不要改写】")).toBe("人物走进车库【不要改写】");
    });

    it("provides a named handheld preset", () => {
        expect(getCanvasCameraMotion("handheld")?.label).toBe("手持跟拍");
    });

    it("uses camera-angle-specific raster sources across the motion plaza", () => {
        expect(new Set(CANVAS_CAMERA_MOTIONS.map((motion) => motion.previewImage)).size).toBeGreaterThanOrEqual(5);
        expect(getCanvasCameraMotion("tilt-up")?.previewImage).toContain("low-angle");
        expect(getCanvasCameraMotion("tilt-down")?.previewImage).toContain("high-angle");
        expect(getCanvasCameraMotion("tracking")?.previewImage).toContain("tracking-side");
    });

    it("uses the full prompt saved with a custom motion", () => {
        const motion = { id: "custom-one", label: "低机位跟拍", prompt: "低机位快速向右跟拍，保持主体在画面左三分之一处。", previewClass: "canvas-motion-pan-right" };
        const result = applyCameraMotionPrompt(`人物走进车库${cameraMotionPromptToken(motion)}`, { [motion.label]: motion });
        expect(result).toContain(motion.prompt);
        expect(inferCameraMotionPreviewClass(result)).toBe("canvas-motion-pan-right");
    });

    it("inserts a selected motion at the current prompt selection", () => {
        const motion = getCanvasCameraMotion("tilt-down")!;
        const prompt = "女孩起身。她走向窗边。";
        const result = insertTextAtSelection(prompt, 5, 5, cameraMotionPromptToken(motion));

        expect(result.value).toBe("女孩起身。【镜头下摇　】她走向窗边。");
        expect(result.caret).toBe(5 + cameraMotionPromptToken(motion).length);
    });
});
