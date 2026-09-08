import { describe, expect, it } from "vitest";

import { normalizeSystemChannel, normalizeSystemChannelAdvancedConfig } from "./store-normalizers";

describe("system channel model capabilities", () => {
    it("keeps the Yumeng protocol identity", () => {
        expect(normalizeSystemChannelAdvancedConfig({ protocol: "yumeng" } as never)?.protocol).toBe("yumeng");
    });

    it("upgrades an existing GeminiTools channel to the current visual text contract", () => {
        const normalized = normalizeSystemChannel({
            id: "gemini-antigravity-tools",
            name: "旧名称",
            baseUrl: "",
            apiKey: "",
            apiFormat: "openai",
            models: ["gemini-3.7-flash-high"],
            enabled: true,
            advancedConfig: {
                protocol: "gemini-tools",
                supportsReferenceImage: false,
                modelConfigs: { "gemini-3.7-flash-high": { capability: "text", supportsReferenceImage: false } },
            },
        } as never);

        expect(normalized.name).toBe("Gemini Antigravity Tools");
        expect(normalized.advancedConfig).toMatchObject({
            protocol: "gemini-tools",
            supportsReferenceImage: true,
            modelConfigs: { "gemini-3.7-flash-high": { capability: "text", supportsReferenceImage: true } },
        });
    });

    it("upgrades the fixed GPTAPI channel from self-HTTP credentials to the managed text and image contract", () => {
        const normalized = normalizeSystemChannel({
            id: "chatgpt-api",
            name: "旧 ChatGPT 通道",
            baseUrl: "https://canvas.example/api/chatgpt-api/v1",
            apiKey: "legacy-source-user-key",
            apiFormat: "openai",
            models: ["gpt-5.6", "gpt-image-2"],
            enabled: true,
            advancedConfig: {
                protocol: "openai",
                modelCapabilities: { "gpt-5.6": "text", "gpt-image-2": "image" },
            },
        } as never);

        expect(normalized).toMatchObject({ name: "GPTAPI", baseUrl: "", apiKey: "", hasApiKey: false });
        expect(normalized.advancedConfig).toMatchObject({
            protocol: "chatgpt-api",
            authMode: "provider-managed",
            modelConfigs: {
                "gpt-5.6": { capability: "text", protocol: "chatgpt-api", createPath: "/chat/completions" },
                "gpt-image-2": { capability: "image", protocol: "chatgpt-api", createPath: "/images/generations", editPath: "/images/edits" },
            },
        });
    });

    it("normalizes supported capabilities and removes invalid entries", () => {
        const normalized = normalizeSystemChannelAdvancedConfig({
            protocol: "auto",
            modelCapabilities: {
                "models/Writer-V1": "text",
                " image-v1 ": "image",
                "video-v1": "video",
                invalid: "unknown",
            },
        } as never);

        expect(normalized?.modelCapabilities).toEqual({ "writer-v1": "text", "image-v1": "image", "video-v1": "video" });
    });

    it("persists the OctalAICanvas recommended protocol after a settings round-trip", () => {
        expect(normalizeSystemChannelAdvancedConfig({ protocol: "octalaicanvas-recommended" } as never)?.protocol).toBe("octalaicanvas-recommended");
    });

    it("normalizes per-model routes for mixed company APIs", () => {
        const normalized = normalizeSystemChannelAdvancedConfig({
            protocol: "auto",
            modelConfigs: {
                "models/OpenAI-Text": { capability: "text", apiFormat: "openai", createPath: "chat/completions" },
                "SD2.0": { capability: "video", protocol: "seedance", createPath: "/videos", queryPath: "/videos/:task_id" },
                invalid: { capability: "other", createPath: "/bad" },
            },
        } as never);

        expect(normalized?.modelConfigs).toEqual({
            "openai-text": { capability: "text", apiFormat: "openai", createPath: "/chat/completions" },
            "sd2.0": { capability: "video", protocol: "seedance", createPath: "/videos", queryPath: "/videos/:task_id" },
        });
    });

    it("normalizes capability-level protocol operations and cancellation settings", () => {
        const normalized = normalizeSystemChannelAdvancedConfig({
            protocol: "custom",
            operationConfigs: {
                video: {
                    capability: "video",
                    protocol: "custom",
                    createPath: "/jobs",
                    queryPath: "/jobs/:task_id",
                    cancelPath: "/jobs/:task_id/cancel",
                    cancelMethod: "DELETE",
                    requestTemplate: '{"model":"{{model}}"}',
                    resultField: "data.url",
                },
                text: { capability: "video", createPath: "/invalid" },
            },
        } as never);

        expect(normalized?.operationConfigs).toEqual({
            video: expect.objectContaining({ capability: "video", protocol: "custom", createPath: "/jobs", cancelPath: "/jobs/:task_id/cancel", cancelMethod: "DELETE" }),
        });
    });
});
