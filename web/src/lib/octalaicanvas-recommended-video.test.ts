import { describe, expect, it } from "vitest";

import { assertOctalaicanvasRecommendedVideoReferences, buildOctalaicanvasRecommendedVideoRequest } from "./octalaicanvas-recommended-video";

describe("OctalAICanvas recommended video protocol", () => {
    it("forces the 720p Seedance model to disable generated audio", () => {
        expect(
            buildOctalaicanvasRecommendedVideoRequest({
                model: "Seedance 2.0-fast-720p",
                prompt: "test",
                duration: 5,
                aspectRatio: "16:9",
                resolution: "1080p",
                generateAudio: true,
                images: [],
                videos: [],
                audios: [],
            }),
        ).toMatchObject({ resolution: "720p", metadata: { resolution: "720p" }, generate_audio: false });
    });

    it("keeps supported reference media in JSON arrays", () => {
        expect(
            buildOctalaicanvasRecommendedVideoRequest({
                model: "qy-seedance-2.0-fast",
                prompt: "test",
                duration: 10,
                aspectRatio: "9:16",
                resolution: "720p",
                generateAudio: true,
                images: ["image-one"],
                videos: ["video-one"],
                audios: ["audio-one"],
            }),
        ).toEqual({
            model: "qy-seedance-2.0-fast",
            prompt: "test",
            duration: 10,
            resolution: "720p",
            metadata: { resolution: "720p" },
            generate_audio: true,
            aspect_ratio: "9:16",
            images: ["image-one"],
            videos: ["video-one"],
            audios: ["audio-one"],
        });
    });

    it("rejects unsupported reference video and audio for Seedance 2.0-fast-720p", () => {
        expect(() => assertOctalaicanvasRecommendedVideoReferences("Seedance 2.0-fast-720p", [{ type: "video" }])).toThrow("不支持参考视频");
        expect(() => assertOctalaicanvasRecommendedVideoReferences("models/Seedance 2.0-fast-720p", [{ type: "audio" }])).toThrow("不支持参考音频");
    });
});
