import { describe, expect, it } from "vitest";

import {
    applyChannelProtocol,
    channelProtocolDefinition,
    protocolModelConfig,
} from "@/lib/channel-protocol-registry";

describe("geminivids protocol", () => {
    it("registers a provider-managed video-only protocol", () => {
        const definition = channelProtocolDefinition("geminivids");
        expect(definition).toBeDefined();
        expect(definition?.authMode).toBe("provider-managed");
        expect(definition?.capabilities).toEqual(["video"]);
        expect(definition?.builtInModels?.map((model) => model.id)).toContain("google-vids-omni");
        const operation = definition?.operations.video;
        expect(operation?.createPath).toBe("/v1/videos");
        expect(operation?.queryPath).toBe("/v1/videos/:task_id");
        expect(operation?.durationRange).toBe("4-10 秒");
        expect(operation?.aspectRatios).toEqual(["16:9", "9:16"]);
        expect(operation?.qualityOptions).toEqual(["720p", "1080p"]);
        expect(operation?.supportsReferenceImage).toBe(true);
        expect(operation?.supportsReferenceVideo).toBe(false);
        expect(operation?.supportsReferenceAudio).toBe(false);
    });

    it("derives per-model video config with duration/quality contract", () => {
        const config = protocolModelConfig("geminivids", "video", "google-vids-omni");
        expect(config?.capability).toBe("video");
        expect(config?.durationRange).toBe("4-10 秒");
        expect(config?.qualityOptions).toEqual(["720p", "1080p"]);
        expect(config?.aspectRatios).toEqual(["16:9", "9:16"]);
    });

    it("applies the protocol to a channel without credentials", () => {
        const channel = applyChannelProtocol(
            {
                id: "geminivids",
                name: "GeminiVids",
                baseUrl: "",
                apiKey: "",
                apiFormat: "openai",
                models: ["google-vids-omni"],
                enabled: true,
            },
            "geminivids",
        );
        expect(channel.advancedConfig?.protocol).toBe("geminivids");
        expect(channel.advancedConfig?.authMode).toBe("provider-managed");
        expect(channel.advancedConfig?.modelCapabilities?.["google-vids-omni"]).toBe("video");
        expect(channel.advancedConfig?.queryPath).toBe("/v1/videos/:task_id");
    });

    it("normalizes runtime paths to sidecar video endpoints only", async () => {
        const { isGeminiVidsRuntimePath } = await import("@/lib/server/geminivids-provider");
        expect(isGeminiVidsRuntimePath("/v1/videos")).toBe(true);
        expect(isGeminiVidsRuntimePath("/v1/videos/vt_abc")).toBe(true);
        expect(isGeminiVidsRuntimePath("/v1/videos/vt_abc/content")).toBe(true);
        expect(isGeminiVidsRuntimePath("/v1/videos/vt_abc/media")).toBe(true);
        expect(isGeminiVidsRuntimePath("/v1/chat/completions")).toBe(false);
        expect(isGeminiVidsRuntimePath("/accounts")).toBe(false);
        expect(isGeminiVidsRuntimePath("/v1/videos/../../etc")).toBe(false);
    });

    it("registers geminiai omni video runtime paths and request builder", async () => {
        const { isGeminiAiRuntimePath } = await import("@/lib/server/geminiai-provider");
        expect(isGeminiAiRuntimePath("/v1/videos")).toBe(true);
        expect(isGeminiAiRuntimePath("/v1/videos/vt_abc")).toBe(true);
        expect(isGeminiAiRuntimePath("/v1/videos/vt_abc/content")).toBe(true);
        expect(isGeminiAiRuntimePath("/v1/chat/completions")).toBe(true);
        expect(isGeminiAiRuntimePath("/accounts")).toBe(false);

        const route = await import("@/app/api/video-generation-tasks/video-generation-route");
        const build = (route as unknown as { buildGeminiAiOmniVideoRequest?: (input: { model: string; prompt: string; aspectRatio: string; resolution: string; duration: number }) => Record<string, unknown> }).buildGeminiAiOmniVideoRequest;
        expect(build).toBeDefined();
        expect(build!({ model: "gemini-omni-1.1-flash", prompt: "p", aspectRatio: "9:16", resolution: "1080p", duration: 5 })).toEqual({ model: "gemini-omni-1.1-flash", prompt: "p", duration_seconds: 5, resolution: "1080p", aspect_ratio: "9:16" });
        expect(build!({ model: "gemini-omni-1.1-flash", prompt: "p", aspectRatio: "1:1", resolution: "8k", duration: 99 })).toEqual({ model: "gemini-omni-1.1-flash", prompt: "p", duration_seconds: 10, aspect_ratio: "auto" });
    });

    it("builds the sidecar create body with clamped params", async () => {
        const route = await import("@/app/api/video-generation-tasks/video-generation-route");
        const build = (route as unknown as { buildGeminiVidsVideoRequest?: (input: { model: string; prompt: string; aspectRatio: string; resolution: string; duration: number; images?: string[] }) => Record<string, unknown> }).buildGeminiVidsVideoRequest;
        expect(build).toBeDefined();
        expect(build!({ model: "google-vids-omni", prompt: "p", aspectRatio: "9:16", resolution: "1080p", duration: 8 })).toEqual({ model: "google-vids-omni", prompt: "p", aspect_ratio: "9:16", resolution: "1080p", duration_seconds: 8 });
        expect(build!({ model: "m", prompt: "p", aspectRatio: "1:1", resolution: "480p", duration: -1 })).toEqual({ model: "m", prompt: "p", aspect_ratio: "16:9", resolution: "720p", duration_seconds: 5 });
        expect(build!({ model: "m", prompt: "p", aspectRatio: "16:9", resolution: "720p", duration: 99 })).toEqual({ model: "m", prompt: "p", aspect_ratio: "16:9", resolution: "720p", duration_seconds: 10 });
        expect(build!({ model: "m", prompt: "p", aspectRatio: "16:9", resolution: "720p", duration: 5, images: ["http://127.0.0.1:3333/api/reference-assets/a?sig=1", "data:image/png;base64,AAA", "not-a-url"] })).toEqual({ model: "m", prompt: "p", aspect_ratio: "16:9", resolution: "720p", duration_seconds: 5, images: ["http://127.0.0.1:3333/api/reference-assets/a?sig=1", "data:image/png;base64,AAA"] });
    });
});
