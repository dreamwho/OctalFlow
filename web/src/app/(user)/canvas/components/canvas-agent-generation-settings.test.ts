import { describe, expect, it } from "vitest";

import type { AiConfig } from "@/stores/use-config-store";

import {
    canvasAgentCompactPreferenceSummary,
    canvasAgentSelectedVideoProfile,
    canvasAgentVideoCapabilityHint,
    normalizeCanvasAgentVideoPreferences,
    selectSingleCanvasAgentModel,
    updateCanvasAgentGenerationPreferences,
} from "./canvas-agent-generation-settings";

const config = {
    model: "Seedance 2.0 Mini",
    logicalModels: [
        {
            id: "Seedance 2.0 Mini",
            name: "Seedance 2.0 Mini",
            capability: "video",
            enabled: true,
            bindings: [{ id: "dreamina:mini", channelId: "dreamina-cli", upstreamModel: "dreamina-seedance-2-0-mini", enabled: true, priority: 1 }],
        },
    ],
    channels: [{ id: "dreamina-cli", name: "即梦 CLI", baseUrl: "/api/ai/system/dreamina-cli", apiKey: "system", apiFormat: "openai", models: ["dreamina-seedance-2-0-mini"] }],
} as AiConfig;

describe("Canvas Agent generation settings", () => {
    it("maps explicit image size, quality and count into the existing config surface", () => {
        const preferences = updateCanvasAgentGenerationPreferences({}, "image", { size: "1536x1024", quality: "high", count: 4 });

        expect(preferences).toEqual({ mode: "image", image: { size: "1536x1024", quality: "high", count: 4 } });
    });

    it("maps custom video dimensions and output controls into Agent preferences", () => {
        const preferences = updateCanvasAgentGenerationPreferences({}, "video", { size: "1080x1920", quality: "1080", seconds: 10, generateAudio: false, watermark: true });

        expect(preferences).toEqual({ mode: "video", video: { size: "1080x1920", quality: "1080", seconds: 10, generateAudio: false, watermark: true } });
    });

    it("keeps the compact trigger readable without dropping the primary output values", () => {
        expect(canvasAgentCompactPreferenceSummary("image", { mode: "image", image: { size: "1:1", quality: "low", count: 4 } })).toBe("1:1 · 4张");
        expect(canvasAgentCompactPreferenceSummary("video", { mode: "video", video: { size: "16:9", quality: "1080", seconds: 10, generateAudio: true, watermark: false } })).toBe("16:9 · 10秒");
        expect(canvasAgentCompactPreferenceSummary("image", {})).toBe("智能 · 1张");
        expect(canvasAgentCompactPreferenceSummary("video", {})).toBe("智能 · 5秒");
        expect(canvasAgentCompactPreferenceSummary("image", { mode: "image", image: { size: "1824x1024", quality: "high", count: 4 } })).toBe("1824×1024");
        expect(canvasAgentCompactPreferenceSummary("video", { mode: "video", video: { size: "1080x1920", quality: "1080", seconds: 10 } })).toBe("1080×1920");
    });

    it("uses the selected Mini model binding to expose only 720P and valid durations", () => {
        const profile = canvasAgentSelectedVideoProfile(config, [{ id: "Seedance 2.0 Mini", name: "Seedance 2.0 Mini", capability: "video" }]);

        expect(profile?.qualities.map((item) => item.value)).toEqual(["720"]);
        expect(profile?.durationRange).toEqual({ min: 4, max: 15 });
        expect(profile?.durations.map((item) => item.value)).toEqual([4, 5, 8, 10, 12, 15]);
        expect(canvasAgentVideoCapabilityHint(profile!)).toBe("当前模型支持 720P · 4–15 秒");
        expect(normalizeCanvasAgentVideoPreferences({ mode: "video", video: { size: "16:9", quality: "1080", seconds: 30 } }, profile!)).toEqual({ mode: "video", video: { size: "16:9", quality: "720", seconds: 15 } });
    });

    it("keeps one selected model for each generation capability", () => {
        const imageOne = { id: "image-one", name: "图片一", capability: "image" } as const;
        const imageTwo = { id: "image-two", name: "图片二", capability: "image" } as const;
        const videoOne = { id: "video-one", name: "视频一", capability: "video" } as const;

        expect(selectSingleCanvasAgentModel(imageOne)).toEqual(["image-one"]);
        expect(selectSingleCanvasAgentModel(videoOne, [imageOne])).toEqual(["image-one", "video-one"]);
        expect(selectSingleCanvasAgentModel(imageTwo, [imageOne, videoOne])).toEqual(["video-one", "image-two"]);
    });

    it("keeps the previously configured image and video parameters while changing the active mode", () => {
        const image = updateCanvasAgentGenerationPreferences({}, "image", { size: "3:2", quality: "high", count: 2 });
        const video = updateCanvasAgentGenerationPreferences(image, "video", { size: "16:9", quality: "720", seconds: 10 });
        const restoredImage = updateCanvasAgentGenerationPreferences(video, "image", { size: "3:2" });

        expect(video).toEqual({ mode: "video", image: { size: "3:2", quality: "high", count: 2 }, video: { size: "16:9", quality: "720", seconds: 10 } });
        expect(restoredImage).toEqual({ mode: "image", image: { size: "3:2", quality: "high", count: 2 }, video: { size: "16:9", quality: "720", seconds: 10 } });
    });
});
