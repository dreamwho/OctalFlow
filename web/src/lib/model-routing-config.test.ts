import { describe, expect, it } from "vitest";

import type { LogicalModel, SystemModelChannel } from "@/lib/auth/store";
import {
    resolveLogicalModelCapabilityProfile,
    channelDetectedCapabilities,
    channelModelCapability,
    deriveLogicalModelsConfig,
    isLogicalModelResolvable,
    mergeChannelModelsIntoLogicalModels,
    modelRoutingValidationErrors,
    normalizeDefaultModelsConfig,
    normalizeLogicalModelsConfig,
    resolveLogicalModelConfig,
    synchronizeLogicalModelsWithChannels,
} from "./model-routing-config";

const channel = (id: string, models: string[], enabled = true): SystemModelChannel => ({ id, name: id, baseUrl: `https://${id}.example.com/v1`, apiKey: "test-secret", apiFormat: "openai", models, enabled });

describe("model routing config", () => {
    it("preserves uploaded icons through normalization and synchronization, and clears them when restored", () => {
        const channels = [channel("one", ["gemini-image"])];
        const iconUrl = "data:image/png;base64,YQ==";
        const model: LogicalModel = { id: "gemini-image", name: "图片", capability: "image", icon: "openai", iconUrl, enabled: true, bindings: [{ id: "binding", channelId: "one", upstreamModel: "gemini-image", enabled: true, priority: 1 }] };
        expect(normalizeLogicalModelsConfig([model], channels)[0]).toMatchObject({ icon: "openai", iconUrl });
        expect(synchronizeLogicalModelsWithChannels([model], channels)[0]).toMatchObject({ iconUrl });
        const restored = normalizeLogicalModelsConfig([{ ...model, icon: undefined, iconUrl: undefined }], channels)[0];
        expect(restored).not.toHaveProperty("iconUrl");
        expect(restored).not.toHaveProperty("icon");
    });
    it("preserves a configured fallback model through settings normalization", () => {
        const channels = [channel("primary", ["gpt-image-2"]), channel("backup", ["flux-image-pro"] )];
        const models: LogicalModel[] = [
            { id: "poster-image", name: "海报模型", capability: "image", fallbackModelId: "backup-image", enabled: true, bindings: [{ id: "primary", channelId: "primary", upstreamModel: "gpt-image-2", enabled: true, priority: 1 }] },
            { id: "backup-image", name: "备用海报模型", capability: "image", enabled: true, bindings: [{ id: "backup", channelId: "backup", upstreamModel: "flux-image-pro", enabled: true, priority: 1 }] },
        ];

        expect(normalizeLogicalModelsConfig(models, channels)[0]?.fallbackModelId).toBe("backup-image");
        expect(synchronizeLogicalModelsWithChannels(models, channels)[0]?.fallbackModelId).toBe("backup-image");
        expect(modelRoutingValidationErrors(models, channels, { textModel: "", imageModel: "", videoModel: "", audioModel: "" })).toEqual([]);
    });

    it("rejects missing, self, cross-capability, unavailable, and cyclic fallback models", () => {
        const channels = [channel("one", ["gpt-image-2", "flux-image-pro", "seedance-2.0"]), channel("off", ["flux-image-pro"], false)];
        const models: LogicalModel[] = [
            { id: "missing-source", name: "Missing", capability: "image", fallbackModelId: "missing", enabled: true, bindings: [{ id: "a", channelId: "one", upstreamModel: "gpt-image-2", enabled: true, priority: 1 }] },
            { id: "self-source", name: "Self", capability: "image", fallbackModelId: "self-source", enabled: true, bindings: [{ id: "b", channelId: "one", upstreamModel: "gpt-image-2", enabled: true, priority: 1 }] },
            { id: "cross-source", name: "Cross", capability: "image", fallbackModelId: "video-model", enabled: true, bindings: [{ id: "c", channelId: "one", upstreamModel: "gpt-image-2", enabled: true, priority: 1 }] },
            { id: "disabled-source", name: "Disabled", capability: "image", fallbackModelId: "disabled-model", enabled: true, bindings: [{ id: "d", channelId: "one", upstreamModel: "gpt-image-2", enabled: true, priority: 1 }] },
            { id: "disabled-model", name: "Disabled target", capability: "image", enabled: false, bindings: [{ id: "e", channelId: "one", upstreamModel: "flux-image-pro", enabled: true, priority: 1 }] },
            { id: "cycle-a", name: "Cycle A", capability: "image", fallbackModelId: "cycle-b", enabled: true, bindings: [{ id: "f", channelId: "one", upstreamModel: "gpt-image-2", enabled: true, priority: 1 }] },
            { id: "cycle-b", name: "Cycle B", capability: "image", fallbackModelId: "cycle-a", enabled: true, bindings: [{ id: "g", channelId: "one", upstreamModel: "flux-image-pro", enabled: true, priority: 1 }] },
            { id: "video-model", name: "Video", capability: "video", enabled: true, bindings: [{ id: "h", channelId: "one", upstreamModel: "seedance-2.0", enabled: true, priority: 1 }] },
        ];
        const errors = modelRoutingValidationErrors(models, channels, { textModel: "", imageModel: "", videoModel: "", audioModel: "" });

        expect(errors).toEqual(expect.arrayContaining([
            "逻辑模型 missing-source 的备用模型不存在：missing",
            "逻辑模型 self-source 不能将自身设为备用模型",
            "逻辑模型 cross-source 的备用模型能力必须为图片：video-model",
            "逻辑模型 disabled-source 的备用模型不可用：disabled-model",
            "逻辑模型 cycle-a 的备用模型配置存在循环引用",
            "逻辑模型 cycle-b 的备用模型配置存在循环引用",
        ]));
    });
    it("uses the fixed Dola media contract for logical aliases and keeps Fast image-only", () => {
        const binding = { capabilityProfile: { supportsReferenceVideo: false, supportsReferenceAudio: false } };
        const dola = { advancedConfig: { protocol: "dola" } } as Pick<SystemModelChannel, "advancedConfig">;
        expect(resolveLogicalModelCapabilityProfile(binding, "video", dola, "dola-seedance-2-5")).toMatchObject({ supportsReferenceVideo: true, supportsReferenceAudio: true });
        expect(resolveLogicalModelCapabilityProfile({ capabilityProfile: { supportsReferenceAudio: true } }, "video", dola, "dola-seedance-2-0-fast")).toMatchObject({ supportsReferenceVideo: false, supportsReferenceAudio: false });
    });

    it("removes missing, unsupported, and duplicate bindings", () => {
        const channels = [channel("one", ["models/GPT-TEST"]), channel("two", ["gpt-test-2"], false)];
        const models: LogicalModel[] = [
            {
                id: "writer",
                name: "Writer",
                capability: "text",
                enabled: true,
                bindings: [
                    { id: "one", channelId: "one", upstreamModel: "gpt-test", enabled: true, priority: 2 },
                    { id: "duplicate", channelId: "one", upstreamModel: "models/GPT-TEST", enabled: true, priority: 1 },
                    { id: "missing", channelId: "missing", upstreamModel: "gpt-test", enabled: true, priority: 3 },
                    { id: "unsupported", channelId: "two", upstreamModel: "other", enabled: true, priority: 4 },
                ],
            },
        ];
        expect(normalizeLogicalModelsConfig(models, channels)[0].bindings).toEqual([{ id: "one", channelId: "one", upstreamModel: "models/GPT-TEST", enabled: true, priority: 2 }]);
    });

    it("preserves an explicitly empty catalog and only derives one when the field is absent", () => {
        const channels = [channel("one", ["writer"])];

        expect(normalizeLogicalModelsConfig([], channels)).toHaveLength(0);
        expect(normalizeLogicalModelsConfig(undefined, channels)).toHaveLength(1);
    });

    it("distinguishes SD2.0 video aliases from full Stable Diffusion image names", () => {
        const models = normalizeLogicalModelsConfig(undefined, [channel("one", ["sd2.0", "sd_2.0_fast_discount_720p", "seedance-2.0", "stable-diffusion-2.0", "sdxl"])]);

        expect(models.find((model) => model.id === "sd2.0")?.capability).toBe("video");
        expect(models.find((model) => model.id === "sd_2.0_fast_discount_720p")?.capability).toBe("video");
        expect(models.find((model) => model.id === "seedance-2.0")?.capability).toBe("video");
        expect(models.find((model) => model.id === "stable-diffusion-2.0")?.capability).toBe("image");
        expect(models.find((model) => model.id === "sdxl")?.capability).toBe("image");
    });

    it("recognizes MiniMax H3 models as video capability", () => {
        const models = normalizeLogicalModelsConfig(undefined, [channel("one", ["minimax-h3-mini", "minimax-h3-fast", "minimax-h3-base", "minimax-h3-pro", "MiniMax-H3"])]);
        for (const id of ["minimax-h3-mini", "minimax-h3-fast", "minimax-h3-base", "minimax-h3-pro", "minimax-h3"]) {
            expect(models.find((model) => model.id.toLowerCase() === id.toLowerCase())?.capability).toBe("video");
        }
    });

    it("keeps an explicitly selected logical model capability", () => {
        const channels = [channel("one", ["stable-diffusion-2.0"])];
        const models = normalizeLogicalModelsConfig(
            [{ id: "stable-diffusion-2.0", name: "自定义视频能力", capability: "video", enabled: true, bindings: [{ id: "one", channelId: "one", upstreamModel: "stable-diffusion-2.0", enabled: true, priority: 1 }] }],
            channels,
        );

        expect(models[0]?.capability).toBe("video");
        expect(normalizeDefaultModelsConfig({ textModel: "", imageModel: "", videoModel: "stable-diffusion-2.0", audioModel: "" }, models, channels).videoModel).toBe("stable-diffusion-2.0");
    });

    it("uses channel capability metadata before model-name inference", () => {
        const source = channel("one", ["opaque-a", "stable-video-diffusion"]);
        source.advancedConfig = { modelCapabilities: { "opaque-a": "image", "stable-video-diffusion": "video" } } as never;

        const models = deriveLogicalModelsConfig([source]);

        expect(models.find((model) => model.id === "opaque-a")?.capability).toBe("image");
        expect(models.find((model) => model.id === "stable-video-diffusion")?.capability).toBe("video");
    });

    it("repairs stale health detection for Nano Banana image models", () => {
        const source = channel("sub2api", ["gemini-3.1-flash-image-preview", "nano-banana-2"]);
        source.advancedConfig = {
            modelCapabilities: { "gemini-3.1-flash-image-preview": "text", "nano-banana-2": "text" },
            modelConfigs: {
                "gemini-3.1-flash-image-preview": { capability: "text", source: "health" },
                "nano-banana-2": { capability: "text", source: "health" },
            },
        } as never;

        expect(channelModelCapability(source, "gemini-3.1-flash-image-preview")).toBe("image");
        expect(channelModelCapability(source, "nano-banana-2")).toBe("image");
        expect(Array.from(channelDetectedCapabilities(source))).toEqual(["image"]);
    });

    it("uses refreshed protocol catalog metadata to repair an existing logical capability", () => {
        const source = channel("newapi", ["opaque-media"]);
        source.advancedConfig = {
            protocol: "newapi",
            modelCapabilities: { "opaque-media": "image" },
            modelConfigs: { "opaque-media": { capability: "image", source: "provider" } },
        } as never;
        const existing: LogicalModel[] = [{ id: "opaque-media", name: "opaque-media", capability: "text", enabled: true, bindings: [{ id: "old", channelId: "newapi", upstreamModel: "opaque-media", enabled: true, priority: 1 }] }];

        expect(synchronizeLogicalModelsWithChannels(existing, [source])[0]?.capability).toBe("image");
    });

    it("uses single-capability protocol catalogs for opaque model names", () => {
        const video = channel("seedance", ["opaque-video-model"]);
        video.advancedConfig = { protocol: "seedance" } as never;
        const image = channel("stable-diffusion", ["opaque-image-model"]);
        image.advancedConfig = { protocol: "stable-diffusion" } as never;

        expect(channelModelCapability(video, "opaque-video-model")).toBe("video");
        expect(channelModelCapability(image, "opaque-image-model")).toBe("image");
    });

    it("does not expose non-creative channel models to generation surfaces", () => {
        const source = channel("newapi", ["gpt-4.1", "text-embedding-3-small", "bge-reranker-v2-m3", "dots.ocr", "gcp-speech-to-text", "whisper-1", "llama-3.1-nemoguard-8b-topic-control", "tts-1"]);
        source.advancedConfig = {
            protocol: "newapi",
            modelConfigs: {
                "gcp-speech-to-text": { capability: "audio", source: "provider" },
                "whisper-1": { capability: "audio", source: "provider" },
                "tts-1": { capability: "audio", source: "provider" },
            },
        } as never;

        const models = deriveLogicalModelsConfig([source]);

        expect(models.map((model) => model.id)).toEqual(["gpt-4.1", "tts-1"]);
        expect(Array.from(channelDetectedCapabilities(source))).toEqual(["text", "audio"]);
        expect(normalizeDefaultModelsConfig({ textModel: "gpt-4.1", imageModel: "", videoModel: "", audioModel: "gcp-speech-to-text" }, models, [source]).audioModel).toBe("tts-1");
    });

    it("keeps the same upstream model from different channels independently selectable", () => {
        const channels = [channel("one", ["models/GPT-IMAGE-2"]), channel("two", ["gpt-image-2"])];
        const existing: LogicalModel[] = [{ id: "gpt-image-2", name: "GPT Image 2", capability: "image", enabled: true, bindings: [{ id: "one:gpt-image-2", channelId: "one", upstreamModel: "gpt-image-2", enabled: true, priority: 1 }] }];

        const models = mergeChannelModelsIntoLogicalModels(existing, channels);

        expect(models).toHaveLength(2);
        expect(models[0]).toMatchObject({ id: "gpt-image-2", bindings: [{ channelId: "one", upstreamModel: "models/GPT-IMAGE-2" }] });
        expect(models[1]).toMatchObject({ id: "gpt-image-2-2", bindings: [{ channelId: "two", upstreamModel: "gpt-image-2" }] });
    });

    it("removes stale bindings and creates separate logical models for different upstream names", () => {
        const channels = [channel("one", ["writer", "writer-mini"]), channel("two", ["models/WRITER"])];
        const existing: LogicalModel[] = [
            {
                id: "custom-writer",
                name: "旧名称",
                capability: "text",
                enabled: false,
                bindings: [
                    { id: "keep", channelId: "one", upstreamModel: "writer", enabled: false, priority: 9, weight: 25 },
                    { id: "stale", channelId: "gone", upstreamModel: "writer", enabled: true, priority: 1 },
                ],
            },
        ];

        const models = synchronizeLogicalModelsWithChannels(existing, channels);

        expect(models).toHaveLength(3);
        expect(models[0]).toMatchObject({ id: "custom-writer", name: "旧名称", enabled: false });
        expect(models[0].bindings).toEqual([expect.objectContaining({ id: "keep", channelId: "one", upstreamModel: "writer", enabled: false, priority: 9, weight: 25 })]);
        expect(models[1]).toMatchObject({ id: "writer-mini", name: "writer-mini", bindings: [{ channelId: "one", upstreamModel: "writer-mini" }] });
        expect(models[2]).toMatchObject({ id: "WRITER", bindings: [{ channelId: "two", upstreamModel: "models/WRITER" }] });
        expect(models.flatMap((model) => model.bindings).some((binding) => binding.channelId === "gone")).toBe(false);
    });

    it("preserves an administrator model nickname when the channel catalog is synchronized", () => {
        const existing: LogicalModel[] = [
            {
                id: "image-pro",
                name: "商业图片 Pro",
                capability: "image",
                pickerGroup: "  商业图片  ",
                enabled: true,
                bindings: [{ id: "binding", channelId: "one", upstreamModel: "vendor/image-v2", enabled: true, priority: 1 }],
            },
        ];

        expect(synchronizeLogicalModelsWithChannels(existing, [channel("one", ["vendor/image-v2"])])[0]).toMatchObject({ name: "商业图片 Pro", pickerGroup: "商业图片" });
    });

    it("persists administrator-selected model icons and drops unsupported icon keys", () => {
        const channels = [channel("one", ["vendor/image-v2"])];
        const configured: LogicalModel = {
            id: "image-pro",
            name: "商业图片 Pro",
            capability: "image",
            enabled: true,
            icon: "doubao",
            bindings: [{ id: "binding", channelId: "one", upstreamModel: "vendor/image-v2", enabled: true, priority: 1 }],
        };
        const unsupported = { ...configured, icon: "custom-url" } as unknown as LogicalModel;

        expect(normalizeLogicalModelsConfig([configured], channels)[0]?.icon).toBe("doubao");
        expect(normalizeLogicalModelsConfig([unsupported], channels)[0]?.icon).toBeUndefined();
    });

    it("preserves model picker visibility and administrator ordering", () => {
        const existing: LogicalModel[] = [
            { id: "image-second", name: "第二模型", capability: "image", enabled: true, pickerVisible: false, bindings: [{ id: "second", channelId: "one", upstreamModel: "image-second", enabled: true, priority: 1 }] },
            { id: "image-first", name: "第一模型", capability: "image", enabled: true, bindings: [{ id: "first", channelId: "one", upstreamModel: "image-first", enabled: true, priority: 1 }] },
        ];

        const normalized = synchronizeLogicalModelsWithChannels(existing, [channel("one", ["image-first", "image-second"])]);

        expect(normalized.map((model) => model.id)).toEqual(["image-second", "image-first"]);
        expect(normalized[0]?.pickerVisible).toBe(false);
        expect(normalized[1]?.pickerVisible).toBeUndefined();
    });

    it("preserves a per-binding display name across catalog synchronization", () => {
        const existing: LogicalModel[] = [
            {
                id: "gpt-image-2",
                name: "GPT Image 2",
                capability: "image",
                enabled: true,
                bindings: [{ id: "one", channelId: "one", upstreamModel: "gpt-image-2", enabled: true, priority: 1, displayName: "官方图片" }],
            },
        ];

        expect(synchronizeLogicalModelsWithChannels(existing, [channel("one", ["gpt-image-2"])])[0]?.bindings[0]?.displayName).toBe("官方图片");
    });

    it("keeps the upstream auto model classified as text", () => {
        const source = channel("one", ["auto"]);
        source.advancedConfig = { modelCapabilities: { auto: "audio" }, modelConfigs: { auto: { capability: "audio", source: "health" } } } as never;

        expect(channelModelCapability(source, "auto")).toBe("text");
    });

    it("only exposes capabilities represented by real channel models", () => {
        const source = channel("one", ["auto", "gpt-5-3", "gpt-image-2"]);

        expect(Array.from(channelDetectedCapabilities(source))).toEqual(["text", "image"]);
    });

    it("requires an enabled matching binding for defaults", () => {
        const channels = [channel("one", ["vendor/writer"]), channel("off", ["voice"], false)];
        const models: LogicalModel[] = [
            { id: "writer", name: "Writer", capability: "text", enabled: true, bindings: [{ id: "one", channelId: "one", upstreamModel: "vendor/writer", enabled: true, priority: 1 }] },
            { id: "voice", name: "Voice", capability: "audio", enabled: true, bindings: [{ id: "two", channelId: "off", upstreamModel: "voice", enabled: true, priority: 1 }] },
        ];
        expect(isLogicalModelResolvable(models, channels, "text", "writer")).toBe(true);
        expect(normalizeDefaultModelsConfig({ textModel: "writer", imageModel: "writer", videoModel: "", audioModel: "voice" }, models, channels)).toEqual({ textModel: "writer", imageModel: "", videoModel: "", audioModel: "" });
    });

    it("switches a stale default to another resolvable model of the same capability", () => {
        const channels = [channel("off", ["gpt-image-2"], false), channel("backup", ["flux-pro"])];
        const models: LogicalModel[] = [
            { id: "gpt-image-2", name: "GPT Image 2", capability: "image", enabled: true, bindings: [{ id: "off", channelId: "off", upstreamModel: "gpt-image-2", enabled: true, priority: 1 }] },
            { id: "flux-pro", name: "Flux Pro", capability: "image", enabled: true, bindings: [{ id: "backup", channelId: "backup", upstreamModel: "flux-pro", enabled: true, priority: 1 }] },
        ];

        expect(normalizeDefaultModelsConfig({ textModel: "", imageModel: "gpt-image-2", videoModel: "", audioModel: "" }, models, channels).imageModel).toBe("flux-pro");
    });

    it("uses binding priority and falls back from a disabled channel", () => {
        const channels = [channel("primary", ["writer-v1"], false), channel("backup", ["writer-v2"])];
        const models: LogicalModel[] = [
            {
                id: "writer",
                name: "Writer",
                capability: "text",
                enabled: true,
                bindings: [
                    { id: "one", channelId: "primary", upstreamModel: "writer-v1", enabled: true, priority: 1 },
                    { id: "two", channelId: "backup", upstreamModel: "writer-v2", enabled: true, priority: 2 },
                ],
            },
        ];
        expect(resolveLogicalModelConfig(models, channels, "text", "writer")).toMatchObject({ channel: { id: "backup" }, binding: { upstreamModel: "writer-v2" } });
    });

    it("normalizes binding weight and capability profile limits", () => {
        const channels = [channel("one", ["video-model"])];
        const models = normalizeLogicalModelsConfig(
            [
                {
                    id: "video",
                    name: "Video",
                    capability: "video",
                    enabled: true,
                    bindings: [
                        {
                            id: "one",
                            channelId: "one",
                            upstreamModel: "video-model",
                            enabled: true,
                            priority: 1,
                            weight: 250,
                            capabilityProfile: {
                                supportsReferenceImage: true,
                                maxReferenceImages: 4,
                                aspectRatios: ["16:9", "16:9", "9:16"],
                                durationRange: "5-15 秒",
                                qualityOptions: ["720p", "1080p", "720p"],
                                maxDurationSeconds: 10,
                                maxBatchSize: 2,
                                timeoutMs: 600000,
                                concurrencyLimit: 3,
                                unitCost: 0.25,
                                unitCostCurrency: "USD",
                            },
                        },
                    ],
                },
            ],
            channels,
        );

        expect(models[0].bindings[0]).toMatchObject({
            weight: 250,
            capabilityProfile: {
                supportsReferenceImage: true,
                maxReferenceImages: 4,
                aspectRatios: ["16:9", "9:16"],
                durationRange: "5-15 秒",
                qualityOptions: ["720p", "1080p"],
                maxDurationSeconds: 10,
                maxBatchSize: 2,
                timeoutMs: 600000,
                concurrencyLimit: 3,
                unitCost: 0.25,
                unitCostCurrency: "USD",
            },
        });
    });

    it("reports duplicate bindings and invalid defaults", () => {
        const channels = [channel("one", ["writer"])];
        const models: LogicalModel[] = [
            {
                id: "writer",
                name: "Writer",
                capability: "text",
                enabled: true,
                bindings: [
                    { id: "one", channelId: "one", upstreamModel: "writer", enabled: true, priority: 1 },
                    { id: "two", channelId: "one", upstreamModel: "models/WRITER", enabled: true, priority: 2 },
                ],
            },
        ];
        expect(modelRoutingValidationErrors(models, channels, { textModel: "missing", imageModel: "", videoModel: "", audioModel: "" })).toEqual(expect.arrayContaining(["逻辑模型 writer 存在重复绑定", "默认文本模型不可解析：missing"]));
    });

    it("does not reject an administrator capability override based only on its name", () => {
        const channels = [channel("one", ["stable-diffusion-2.0"])];
        const models: LogicalModel[] = [{ id: "stable-diffusion-2.0", name: "自定义视频能力", capability: "video", enabled: true, bindings: [{ id: "one", channelId: "one", upstreamModel: "stable-diffusion-2.0", enabled: true, priority: 1 }] }];

        expect(modelRoutingValidationErrors(models, channels, { textModel: "", imageModel: "", videoModel: "stable-diffusion-2.0", audioModel: "" })).not.toContain("逻辑模型 stable-diffusion-2.0 更像图片模型，请调整能力类型");
    });
});
