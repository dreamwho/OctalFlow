import { describe, expect, it } from "vitest";

import { defaultConfig, type AiConfig } from "@/stores/use-config-store";
import { qwenAudioSystemVoices, qwenDefaultAudioVoice } from "@/lib/qwen-audio";
import { CanvasNodeType } from "../types";
import { buildCanvasNodeConfig, selectableCanvasAudioModels, resolveCanvasGenerationModel } from "./canvas-node-config";

const config: AiConfig = {
    ...defaultConfig,
    model: "image-main",
    imageModel: "image-main",
    videoModel: "studio-motion",
    textModel: "writer-main",
    audioModel: "voice-main",
    models: ["image-main", "image-alt", "studio-motion", "writer-main", "voice-main"],
    imageModels: ["image-main", "image-alt"],
    videoModels: ["studio-motion"],
    textModels: ["writer-main"],
    audioModels: ["voice-main"],
};

describe("resolveCanvasGenerationModel", () => {
    it("switches to the first model exposed by the selected capability", () => {
        expect(resolveCanvasGenerationModel(config, "video", "image-alt")).toBe("studio-motion");
        expect(resolveCanvasGenerationModel(config, "text", "studio-motion")).toBe("writer-main");
        expect(resolveCanvasGenerationModel(config, "audio", "writer-main")).toBe("voice-main");
    });

    it("preserves a model that belongs to the selected capability", () => {
        expect(resolveCanvasGenerationModel(config, "image", "IMAGE-ALT")).toBe("image-alt");
    });

    it("does not show an unavailable model when the capability has no configured model", () => {
        expect(resolveCanvasGenerationModel({ ...config, videoModels: [] }, "video", "image-main")).toBe("");
    });
});

describe("qwen audio defaults", () => {
    it("uses only voices documented for the selected TTS model", () => {
        expect(qwenDefaultAudioVoice("qwen-audio-3.0-tts-plus")).toBe("longanlingxin");
        expect(qwenDefaultAudioVoice("qwen-audio-3.0-tts-flash")).toBe("longanfengyue");
        expect(qwenDefaultAudioVoice("cosyvoice-v3.5-plus")).toBe("");
        expect(qwenDefaultAudioVoice("qwen3-tts-vc-2026-01-22")).toBe("");
        expect(qwenDefaultAudioVoice("qwen3-tts-vd-2026-01-26")).toBe("");
        expect(qwenDefaultAudioVoice("qwen3-tts-flash")).toBe("Cherry");
        expect(qwenAudioSystemVoices("qwen-audio-3.0-tts-flash")[0]).toMatchObject({ voiceName: "龙安风悦", voiceParam: "longanfengyue", feature: "自然亲切音", scene: "社交陪伴（精品中文）" });
    });

    it("does not turn an explicit empty Qwen3 voice into the generic Alloy voice", () => {
        const node = { id: "audio-qwen3", type: CanvasNodeType.Audio, title: "音频", position: { x: 0, y: 0 }, width: 320, height: 240, metadata: { audioVoice: "" } };
        expect(buildCanvasNodeConfig({ ...config, audioVoice: "alloy" }, node, "audio", "qwen3-tts-vc-2026-01-22").audioVoice).toBe("");
    });

    it("does not submit a generic OpenAI voice to a MiniMax audio model", () => {
        const node = { id: "audio-minimax", type: CanvasNodeType.Audio, title: "音频", position: { x: 0, y: 0 }, width: 320, height: 240, metadata: {} };
        expect(buildCanvasNodeConfig({ ...config, audioVoice: "alloy" }, node, "audio", "speech-2.8-hd").audioVoice).toBe("");
    });

    it("preserves CosyVoice instructions in the node configuration", () => {
        const node = { id: "audio-cosyvoice", type: CanvasNodeType.Audio, title: "音频", position: { x: 0, y: 0 }, width: 320, height: 240, metadata: { audioMode: "tts" as const, audioInstructions: "请用河南话表达。" } };
        expect(buildCanvasNodeConfig({ ...config, audioInstructions: "" }, node, "audio", "cosyvoice-v3-flash").audioInstructions).toBe("请用河南话表达。");
    });
});

describe("selectableCanvasAudioModels", () => {
    it("filters provider models by the selected audio function", () => {
        const audioConfig = {
            ...defaultConfig,
            models: ["qwen-audio-3.0-tts-flash", "qwen-audio-3.0-tts-plus", "speech-2.8-hd", "speech-2.8-turbo", "minimax-music-v3.0"],
            audioModels: ["qwen-audio-3.0-tts-flash", "qwen-audio-3.0-tts-plus", "speech-2.8-hd", "speech-2.8-turbo", "minimax-music-v3.0"],
            channels: [
                {
                    id: "minimax-audio",
                    name: "MiniMax 音频",
                    baseUrl: "/api/ai/system/minimax-audio",
                    apiKey: "system",
                    apiFormat: "openai" as const,
                    models: ["speech-2.8-hd", "speech-2.8-turbo"],
                    advancedConfig: { protocol: "minimax-audio" as const } as never,
                },
                {
                    id: "aliyun-bailian-audio",
                    name: "阿里云百炼语音",
                    baseUrl: "/api/ai/system/aliyun-bailian-audio",
                    apiKey: "system",
                    apiFormat: "openai" as const,
                    models: ["qwen-audio-3.0-tts-flash", "qwen-audio-3.0-tts-plus"],
                    advancedConfig: { protocol: "aliyun-bailian-audio" as const } as never,
                },
                {
                    id: "tencent-tokenhub-music",
                    name: "TokenHub 音乐",
                    baseUrl: "/api/ai/system/tencent-tokenhub-music",
                    apiKey: "system",
                    apiFormat: "openai" as const,
                    models: ["minimax-music-v3.0"],
                    advancedConfig: { protocol: "tencent-tokenhub-music" as const } as never,
                },
            ],
        } as AiConfig;

        expect(selectableCanvasAudioModels(audioConfig, "voice-design")).toEqual(["qwen-audio-3.0-tts-plus", "speech-2.8-hd"]);
        expect(selectableCanvasAudioModels(audioConfig, "voice-clone")).toEqual(["qwen-audio-3.0-tts-flash", "speech-2.8-hd"]);
        expect(selectableCanvasAudioModels(audioConfig, "tts")).toEqual(["speech-2.8-hd", "speech-2.8-turbo", "qwen-audio-3.0-tts-flash", "qwen-audio-3.0-tts-plus"]);
        expect(selectableCanvasAudioModels(audioConfig, "music")).toEqual(["minimax-music-v3.0"]);
    });

    it("offers cosyvoice-v3.5-plus for both voice cloning and voice design", () => {
        const cosyConfig = {
            ...defaultConfig,
            models: ["cosyvoice-v3-plus", "cosyvoice-v3.5-plus"],
            audioModels: ["cosyvoice-v3-plus", "cosyvoice-v3.5-plus"],
            channels: [{ id: "aliyun-bailian-audio", name: "阿里云百炼语音", baseUrl: "/api/ai/system/aliyun-bailian-audio", apiKey: "system", apiFormat: "openai" as const, models: ["cosyvoice-v3-plus", "cosyvoice-v3.5-plus"], advancedConfig: { protocol: "aliyun-bailian-audio" as const } as never }],
        } as AiConfig;

        expect(selectableCanvasAudioModels(cosyConfig, "voice-clone")).toEqual(["cosyvoice-v3-plus", "cosyvoice-v3.5-plus"]);
        expect(selectableCanvasAudioModels(cosyConfig, "voice-design")).toEqual(["cosyvoice-v3.5-plus"]);
        expect(selectableCanvasAudioModels(cosyConfig, "tts")).toEqual(["cosyvoice-v3-plus", "cosyvoice-v3.5-plus"]);
    });

    it("hides MiniMax voice features when the channel switch is disabled", () => {
        const audioConfig = {
            ...defaultConfig,
            models: ["speech-2.8-hd", "speech-2.8-turbo"],
            audioModels: ["speech-2.8-hd", "speech-2.8-turbo"],
            channels: [{ id: "minimax-audio", name: "MiniMax 音频", baseUrl: "/api/ai/system/minimax-audio", apiKey: "system", apiFormat: "openai" as const, models: ["speech-2.8-hd", "speech-2.8-turbo"], advancedConfig: { protocol: "minimax-audio" as const, minimaxVoiceCloneEnabled: false, minimaxVoiceDesignEnabled: false } as never }],
        } as AiConfig;

        expect(selectableCanvasAudioModels(audioConfig, "voice-clone")).toEqual([]);
        expect(selectableCanvasAudioModels(audioConfig, "voice-design")).toEqual([]);
        expect(selectableCanvasAudioModels(audioConfig, "tts")).toEqual(["speech-2.8-hd", "speech-2.8-turbo"]);
    });
});
