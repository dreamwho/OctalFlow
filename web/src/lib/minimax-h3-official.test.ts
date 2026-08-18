import { describe, expect, it } from "vitest";

import { assertMinimaxH3OfficialVideoReferences, buildMinimaxH3OfficialVideoRequest, minimaxH3OfficialResolution } from "@/lib/minimax-h3-official";
import type { VideoGenerationReference } from "@/lib/video-reference-contract";

const IMAGE = "https://cdn.example.com/dog.png";

function reference(overrides: Partial<VideoGenerationReference> = {}): VideoGenerationReference {
    return { type: "image", url: IMAGE, ...overrides };
}

describe("minimax-h3-official video contract", () => {
    it("builds a text-to-video request with a mandatory non-adaptive ratio", () => {
        expect(buildMinimaxH3OfficialVideoRequest({ model: "MiniMax-H3", prompt: "a dog runs", resolution: "2K", ratio: "16:9", duration: 5, references: [] })).toEqual({
            model: "MiniMax-H3",
            content: [{ type: "text", text: "a dog runs" }],
            resolution: "2K",
            duration: 5,
            ratio: "16:9",
        });
    });

    it("defaults the resolution to 768P and ratio to 16:9 for text-to-video", () => {
        const request = buildMinimaxH3OfficialVideoRequest({ model: "MiniMax-H3", prompt: "p", resolution: "720p", duration: 6, references: [] });
        expect(request).toMatchObject({ resolution: "768P", ratio: "16:9" });
    });

    it("maps first frame and both frames into content with first_frame/last_frame roles and adaptive ratio", () => {
        const i2va = buildMinimaxH3OfficialVideoRequest({ model: "MiniMax-H3", prompt: "p", resolution: "768P", duration: 6, references: [reference({ role: "first_frame" })] });
        expect(i2va).toMatchObject({
            ratio: "adaptive",
            content: [
                { type: "text", text: "p" },
                { type: "image_url", image_url: { url: IMAGE }, role: "first_frame" },
            ],
        });

        const fl2va = buildMinimaxH3OfficialVideoRequest({
            model: "MiniMax-H3",
            prompt: "p",
            resolution: "768P",
            duration: 6,
            references: [reference({ role: "first_frame" }), reference({ role: "last_frame", url: "https://cdn.example.com/last.png" })],
        });
        expect(fl2va.content).toHaveLength(3);
        expect(fl2va.content![2]).toMatchObject({ type: "image_url", role: "last_frame", image_url: { url: "https://cdn.example.com/last.png" } });
    });

    it("maps regular references into reference_image/video/audio roles", () => {
        const request = buildMinimaxH3OfficialVideoRequest({
            model: "MiniMax-H3",
            prompt: "p",
            resolution: "768P",
            duration: 15,
            references: [reference(), reference({ type: "video", url: "https://cdn.example.com/dog.mp4" }), reference({ type: "audio", url: "https://cdn.example.com/bark.mp3" })],
        });
        expect(request.content).toEqual([
            { type: "text", text: "p" },
            { type: "image_url", image_url: { url: IMAGE }, role: "reference_image" },
            { type: "video_url", video_url: { url: "https://cdn.example.com/dog.mp4" }, role: "reference_video" },
            { type: "audio_url", audio_url: { url: "https://cdn.example.com/bark.mp3" }, role: "reference_audio" },
        ]);
    });

    it("rejects mixed keyframes and references, invalid durations, unknown models, and over-limit references", () => {
        expect(() => buildMinimaxH3OfficialVideoRequest({ model: "MiniMax-H3", prompt: "p", resolution: "768P", duration: 5, references: [reference({ role: "first_frame" }), reference()] })).toThrow("不能与参考素材混用");
        expect(() => buildMinimaxH3OfficialVideoRequest({ model: "MiniMax-H3", prompt: "p", resolution: "768P", duration: 3, references: [] })).toThrow("4-15 秒整数");
        expect(() => buildMinimaxH3OfficialVideoRequest({ model: "MiniMax-H3x", prompt: "p", resolution: "768P", duration: 5, references: [] })).toThrow("官方模型列表");
        expect(() => buildMinimaxH3OfficialVideoRequest({ model: "MiniMax-H3", prompt: "p", resolution: "768P", duration: 5, references: Array.from({ length: 10 }, (_, index) => reference({ url: `https://cdn.example.com/${index}.png` })) })).toThrow(
            "参考图片最多 9 张",
        );
    });

    it("normalizes only 2K-style resolutions to 2K", () => {
        expect(minimaxH3OfficialResolution("2K")).toBe("2K");
        expect(minimaxH3OfficialResolution("2Kp")).toBe("2K");
        expect(minimaxH3OfficialResolution("2160")).toBe("2K");
        expect(minimaxH3OfficialResolution("720p")).toBe("768P");
        expect(minimaxH3OfficialResolution("1080")).toBe("768P");
    });

    it("asserts reference mixing before task creation", () => {
        expect(() => assertMinimaxH3OfficialVideoReferences([reference({ role: "first_frame" }), reference()])).toThrow("不能与参考素材混用");
        expect(() => assertMinimaxH3OfficialVideoReferences([reference()])).not.toThrow();
    });
});
