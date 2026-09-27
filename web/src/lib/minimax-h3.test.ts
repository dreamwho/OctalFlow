import { describe, expect, it } from "vitest";

import { assertMinimaxH3VideoReferences, buildMinimaxH3VideoRequest, promoteMinimaxH3LogicalModels, MINIMAX_H3_MODELS } from "@/lib/minimax-h3";
import type { LogicalModel, SystemModelChannel } from "@/lib/auth/store-types";
import type { VideoGenerationReference } from "@/lib/video-reference-contract";

const IMAGE = "https://cdn.example.com/dog.png";

function reference(overrides: Partial<VideoGenerationReference> = {}): VideoGenerationReference {
    return { type: "image", url: IMAGE, ...overrides };
}

describe("minimax-h3 video contract", () => {
    it("builds a t2va request without media fields", () => {
        expect(buildMinimaxH3VideoRequest({ model: "minimax-h3-mini", prompt: "a dog runs", resolution: "1080p", aspectRatio: "16:9", duration: 5, references: [] })).toEqual({
            model: "minimax-h3-mini",
            mode: "t2va",
            resolution: "720p",
            seconds: "5",
            prompt: "a dog runs",
            aspect_ratio: "16:9",
        });
    });

    it("maps first and both frames to i2va and fl2va images", () => {
        expect(buildMinimaxH3VideoRequest({ model: "minimax-h3-base", prompt: "p", resolution: "480p", duration: 6, references: [reference({ role: "first_frame" })] })).toMatchObject({ mode: "i2va", images: [IMAGE] });
        const fl2va = buildMinimaxH3VideoRequest({ model: "minimax-h3-base", prompt: "p", resolution: "480p", duration: 6, references: [reference({ role: "first_frame" }), reference({ role: "last_frame", url: "https://cdn.example.com/last.png" })] });
        expect(fl2va).toMatchObject({ mode: "fl2va", images: [IMAGE, "https://cdn.example.com/last.png"] });
    });

    it("maps regular references to ref2va with typed media arrays", () => {
        const request = buildMinimaxH3VideoRequest({
            model: "minimax-h3-pro",
            prompt: "p",
            resolution: "480p",
            duration: 15,
            references: [reference(), reference({ type: "video", url: "https://cdn.example.com/dog.mp4" }), reference({ type: "audio", url: "https://cdn.example.com/bark.mp3" })],
        });
        expect(request).toMatchObject({ mode: "ref2va", images: [IMAGE], videos: ["https://cdn.example.com/dog.mp4"], audios: ["https://cdn.example.com/bark.mp3"] });
        expect(request).not.toHaveProperty("aspect_ratio");
    });

    it("rejects mixed keyframes and regular references, invalid durations, and unknown models", () => {
        expect(() => buildMinimaxH3VideoRequest({ model: "minimax-h3-mini", prompt: "p", resolution: "480p", duration: 5, references: [reference({ role: "first_frame" }), reference()] })).toThrow("不能与普通参考素材混用");
        expect(() => buildMinimaxH3VideoRequest({ model: "minimax-h3-mini", prompt: "p", resolution: "480p", duration: 4, references: [] })).toThrow("5-15 秒整数");
        expect(() => buildMinimaxH3VideoRequest({ model: "minimax-h3-unknown", prompt: "p", resolution: "480p", duration: 5, references: [] })).toThrow("公开模型列表");
        expect(() => buildMinimaxH3VideoRequest({ model: "minimax-h3-mini", prompt: "p", resolution: "480p", duration: 5, references: Array.from({ length: 10 }, (_, index) => reference({ url: `https://cdn.example.com/${index}.png` })) })).toThrow(
            "参考图片最多 9 张",
        );
    });

    it("asserts reference mixing before task creation", () => {
        expect(() => assertMinimaxH3VideoReferences([reference({ role: "first_frame" }), reference()])).toThrow("不能与普通参考素材混用");
        expect(() => assertMinimaxH3VideoReferences([reference()])).not.toThrow();
    });

    it("promotes and binds minimax-h3 logical models to the dedicated channel", () => {
        const channel: SystemModelChannel = {
            id: "easyframe-minimax-h3",
            name: "easyframe MiniMaxH3",
            baseUrl: "https://minimax.api.easyframe.cn",
            apiKey: "test-key",
            apiFormat: "openai",
            models: ["minimax-h3-mini", "minimax-h3-base"],
            enabled: true,
        };
        const existing: LogicalModel[] = [
            {
                id: "minimax-h3-mini",
                name: "MiniMax H3 Mini",
                capability: "video",
                enabled: true,
                bindings: [{ id: "old-channel:minimax-h3-mini", channelId: "old-channel", upstreamModel: "minimax-h3-mini", enabled: true, priority: 2 }],
            },
        ];
        const { logicalModels } = promoteMinimaxH3LogicalModels(existing, channel);
        const mini = logicalModels.find((m) => m.id === "minimax-h3-mini");
        expect(mini).toBeDefined();
        expect(mini?.bindings[0]).toMatchObject({
            channelId: "easyframe-minimax-h3",
            upstreamModel: "minimax-h3-mini",
            enabled: true,
            priority: 0,
        });
        const base = logicalModels.find((m) => m.id === "minimax-h3-base");
        expect(base).toBeDefined();
        expect(base?.bindings[0]).toMatchObject({
            channelId: "easyframe-minimax-h3",
            upstreamModel: "minimax-h3-base",
            enabled: true,
            priority: 0,
        });
    });
});
