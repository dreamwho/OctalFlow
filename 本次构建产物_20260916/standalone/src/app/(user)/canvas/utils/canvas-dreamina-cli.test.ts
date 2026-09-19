import { describe, expect, it } from "vitest";

import type { AiConfig } from "@/stores/use-config-store";

import { canvasDreaminaImageProfile, canvasDreaminaModelCompatible, canvasDreaminaVideoCommand, canvasDreaminaVideoProfile, resolveCanvasDreaminaModelId } from "./canvas-dreamina-cli";

const config = {
    model: "即梦 5 Pro",
    logicalModels: [
        {
            id: "即梦 5 Pro",
            name: "即梦 5 Pro",
            capability: "image",
            enabled: true,
            bindings: [{ id: "dreamina:image", channelId: "dreamina-cli", upstreamModel: "dreamina-seedream-5-0-pro", enabled: true, priority: 1 }],
        },
        {
            id: "即梦视频",
            name: "即梦视频",
            capability: "video",
            enabled: true,
            bindings: [{ id: "dreamina:video", channelId: "dreamina-cli", upstreamModel: "dreamina-seedance-2-0", enabled: true, priority: 1 }],
        },
    ],
    channels: [{ id: "dreamina-cli", name: "即梦 CLI", baseUrl: "/api/ai/system/dreamina-cli", apiKey: "system", apiFormat: "openai", models: ["dreamina-seedream-5-0-pro", "dreamina-seedance-2-0"] }],
} as AiConfig;

describe("Canvas Dreamina CLI profiles", () => {
    it("resolves renamed logical models through their Dreamina binding", () => {
        expect(resolveCanvasDreaminaModelId(config)).toBe("dreamina-seedream-5-0-pro");
    });

    it("switches Seedream resolution choices by model", () => {
        expect(canvasDreaminaImageProfile("dreamina-seedream-3-0")?.qualities.map((item) => item.label)).toEqual(["1K", "2K"]);
        expect(canvasDreaminaImageProfile("dreamina-seedream-4-7")?.qualities.map((item) => item.label)).toEqual(["2K", "4K"]);
        expect(canvasDreaminaImageProfile("dreamina-seedream-5-0-pro")?.qualities.map((item) => item.label)).toEqual(["1.5K", "2K", "4K"]);
    });

    it("derives video commands from current references and frame roles", () => {
        expect(canvasDreaminaVideoCommand(undefined, [])).toBe("text2video");
        expect(canvasDreaminaVideoCommand(undefined, [{ kind: "image" }, { kind: "image" }] as never)).toBe("multiframe2video");
        expect(canvasDreaminaVideoCommand(undefined, [{ kind: "audio" }] as never)).toBe("multimodal2video");
        expect(canvasDreaminaVideoCommand({ videoReferenceMode: "first_last", videoFirstFrame: { assetId: "a" }, videoLastFrame: { assetId: "b" } } as never, [])).toBe("frames2video");
    });

    it("switches Seedance quality and duration bounds by model", () => {
        expect(canvasDreaminaVideoProfile("dreamina-seedance-2-0", "text2video")).toMatchObject({ qualities: [{ value: "720" }], durationRange: { min: 4, max: 15 } });
        expect(canvasDreaminaVideoProfile("dreamina-seedance-2-0-mini", "text2video")).toMatchObject({ qualities: [{ value: "720" }], durationRange: { min: 4, max: 15 } });
        expect(canvasDreaminaVideoProfile("dreamina-seedance-2-0-vip", "text2video")?.qualities.map((item) => item.value)).toEqual(["720", "1080", "4k"]);
        expect(canvasDreaminaVideoProfile("dreamina-seedance-2-5", "text2video")).toMatchObject({ durationRange: { min: 4, max: 30 } });
    });

    it("filters command-incompatible Dreamina logical models", () => {
        expect(canvasDreaminaModelCompatible(config, "即梦视频", "video", "text2video")).toBe(true);
        const imageConfig = { ...config, model: "dreamina-seedream-3-0", logicalModels: [], channels: [{ ...config.channels[0], models: ["dreamina-seedream-3-0"] }] } as AiConfig;
        expect(canvasDreaminaModelCompatible(imageConfig, "dreamina-seedream-3-0", "image", "image2image")).toBe(false);
    });
});
