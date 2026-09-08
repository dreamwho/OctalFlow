import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    getAuthSettings: vi.fn(),
    setAuthSettings: vi.fn(),
    synchronizeLogicalModelsWithChannels: vi.fn(),
    normalizeDefaultModelsConfig: vi.fn(),
    sidecarRequest: vi.fn(),
    providerConfigured: vi.fn(),
    providerHealth: vi.fn(),
    inlineRemoteImageResult: vi.fn(),
    writePersistentMediaDataUrl: vi.fn(),
}));

vi.mock("@/lib/auth/store", () => ({ getAuthSettings: mocks.getAuthSettings, setAuthSettings: mocks.setAuthSettings }));
vi.mock("@/lib/model-routing-config", () => ({
    synchronizeLogicalModelsWithChannels: mocks.synchronizeLogicalModelsWithChannels,
    normalizeDefaultModelsConfig: mocks.normalizeDefaultModelsConfig,
    channelModelCapability: (channel: { advancedConfig?: { modelCapabilities?: Record<string, string> } }, model: string) => channel.advancedConfig?.modelCapabilities?.[model.toLowerCase()],
}));
vi.mock("@/lib/server/geminiai-provider", () => {
    class GeminiAiProviderError extends Error {
        constructor(
            message: string,
            readonly status = 502,
        ) {
            super(message);
        }
    }
    return {
        GEMINIAI_PROTOCOL: "geminiai",
        GEMINIAI_CHANNEL_ID: "geminiai",
        GEMINIAI_CHANNEL_NAME: "Gemini AI Studio",
        GeminiAiProviderError,
        geminiAiHealth: mocks.providerHealth,
        geminiAiProviderConfigured: mocks.providerConfigured,
        geminiAiSidecarRequest: mocks.sidecarRequest,
    };
});
vi.mock("@/app/api/image-tasks/image-task-support", () => ({ inlineRemoteImageResult: mocks.inlineRemoteImageResult }));
vi.mock("@/lib/server/reference-asset-store", () => ({ writePersistentMediaDataUrl: mocks.writePersistentMediaDataUrl }));

import { getGeminiAiLoginStatus, getGeminiAiOverview, listGeminiAiCatalog, listGeminiAiAccounts, runGeminiAiImageTest, runGeminiAiSearchTest, runGeminiAiTextTest, saveGeminiAiModelSelection, setGeminiAiRotation } from "./geminiai-service";

const emptySettings = { systemChannels: [], logicalModels: [], defaultModels: {}, generationDefaults: { videoQuality: "standard", videoSeconds: 8 } };

function sidecarJson(payload: unknown) {
    return Response.json(payload);
}

describe("GeminiAI service", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getAuthSettings.mockResolvedValue(structuredClone(emptySettings));
        mocks.providerConfigured.mockReturnValue(true);
        mocks.providerHealth.mockResolvedValue(true);
        mocks.synchronizeLogicalModelsWithChannels.mockReturnValue([{ id: "geminiai-text", capability: "text", enabled: true, bindings: [] }]);
        mocks.normalizeDefaultModelsConfig.mockReturnValue({ textModel: "geminiai-text" });
        mocks.writePersistentMediaDataUrl.mockImplementation(async (_data: unknown, _kind: unknown, metadata: { originalName: string }) => ({ url: `/media/${metadata.originalName}`, token: `token-${metadata.originalName}` }));
    });

    it("does not report zero accounts when the configured provider is unreachable", async () => {
        mocks.providerHealth.mockResolvedValue(false);
        mocks.sidecarRequest.mockRejectedValue(new Error("provider unavailable"));

        await expect(getGeminiAiOverview()).resolves.toMatchObject({ configured: true, healthy: false, accounts: [], accountsAvailable: false });
    });

    it("maps only supported GeminiAI catalog capabilities and exposes explicit search support", async () => {
        mocks.sidecarRequest.mockResolvedValue(sidecarJson({ data: [{ id: "gemini-2.5-pro", type: "text" }, { id: "gemini-2.5-flash-image" }, { id: "veo-3.1-video" }, { id: "lyria-audio" }] }));

        await expect(listGeminiAiCatalog()).resolves.toEqual([
            { id: "gemini-2.5-flash-image", name: "gemini-2.5-flash-image", capabilities: ["image"], enabled: false, source: "geminiai" },
            { id: "gemini-2.5-pro", name: "gemini-2.5-pro", capabilities: ["text", "search"], enabled: false, source: "geminiai" },
        ]);
    });

    it("normalizes sidecar account wrappers and its last_used timestamp", async () => {
        mocks.sidecarRequest.mockResolvedValue(sidecarJson({ data: { accounts: [{ id: "account-a", name: "主账号", email: "a@example.com", last_used: "2026-08-30T12:00:00Z" }] } }));

        await expect(listGeminiAiAccounts()).resolves.toEqual([{ id: "account-a", name: "主账号", email: "a@example.com", status: "ready", lastUsedAt: "2026-08-30T12:00:00Z" }]);
    });

    it("returns a sanitized sidecar login failure instead of discarding headed-login diagnostics", async () => {
        mocks.sidecarRequest.mockResolvedValue(sidecarJson({ data: { session_id: "login-a", status: "failed", error: "DISPLAY unavailable; authorization=secret" } }));

        await expect(getGeminiAiLoginStatus("login-a")).resolves.toEqual({ sessionId: "login-a", status: "failed", error: "DISPLAY unavailable; authorization=[REDACTED]" });
    });

    it("updates rotation through the sidecar POST contract", async () => {
        mocks.sidecarRequest.mockResolvedValue(sidecarJson({ enabled: true, mode: "lru", cooldown_seconds: 15 }));

        await expect(setGeminiAiRotation({ mode: "lru", cooldownSeconds: 15 })).resolves.toMatchObject({ enabled: true, mode: "lru", cooldownSeconds: 15 });
        expect(mocks.sidecarRequest).toHaveBeenCalledWith("/rotation/mode", expect.objectContaining({ method: "POST", body: JSON.stringify({ mode: "lru", cooldown_seconds: 15 }) }));
    });

    it("saves a keyless provider-managed channel only from the synchronized catalog", async () => {
        mocks.sidecarRequest.mockResolvedValue(sidecarJson({ data: [{ id: "gemini-2.5-pro", type: "text" }, { id: "gemini-2.5-flash-image" }] }));

        const result = await saveGeminiAiModelSelection({ models: ["gemini-2.5-pro", "gemini-2.5-flash-image"] });

        expect(result.models).toEqual([
            { id: "gemini-2.5-pro", name: "gemini-2.5-pro", capabilities: ["text", "search"], enabled: true, source: "geminiai" },
            { id: "gemini-2.5-flash-image", name: "gemini-2.5-flash-image", capabilities: ["image"], enabled: true, source: "geminiai" },
        ]);
        expect(mocks.setAuthSettings).toHaveBeenCalledWith(
            expect.objectContaining({
                systemChannels: [
                    expect.objectContaining({
                        id: "geminiai",
                        apiKey: "",
                        hasApiKey: false,
                        advancedConfig: expect.objectContaining({ protocol: "geminiai", authMode: "provider-managed" }),
                    }),
                ],
            }),
        );
        expect(mocks.synchronizeLogicalModelsWithChannels).toHaveBeenCalled();
    });

    it("uses the native Google Search tool and returns grounding citations", async () => {
        mocks.sidecarRequest.mockResolvedValueOnce(sidecarJson({ data: [{ id: "gemini-2.5-pro", type: "text" }] })).mockResolvedValueOnce(
            sidecarJson({
                candidates: [
                    {
                        content: { parts: [{ text: "检索结果" }] },
                        groundingMetadata: { groundingChunks: [{ web: { uri: "https://example.com/source", title: "来源" } }] },
                    },
                ],
            }),
        );

        await expect(runGeminiAiSearchTest({ model: "gemini-2.5-pro", prompt: "今天的新闻" })).resolves.toEqual({ model: "gemini-2.5-pro", text: "检索结果", citations: [{ url: "https://example.com/source", title: "来源" }] });
        const [, init] = mocks.sidecarRequest.mock.calls[1]!;
        expect(mocks.sidecarRequest.mock.calls[1]![0]).toBe("/v1beta/models/gemini-2.5-pro:generateContent");
        expect(JSON.parse(init.body)).toMatchObject({ tools: [{ googleSearchRetrieval: {} }] });
    });

    it("persists every valid image result and never returns upstream image URLs", async () => {
        mocks.sidecarRequest.mockResolvedValueOnce(sidecarJson({ data: [{ id: "gemini-2.5-flash-image" }] })).mockResolvedValueOnce(sidecarJson({ data: [{ b64_json: "aGVsbG8=" }, { b64_json: "d29ybGQ=" }] }));

        await expect(runGeminiAiImageTest({ userId: "admin-a", model: "gemini-2.5-flash-image", prompt: "海边日落", aspectRatio: "9:16", imageSize: "4K" })).resolves.toEqual({
            model: "gemini-2.5-flash-image",
            images: ["/media/geminiai-test-1.png", "/media/geminiai-test-2.png"],
        });
        expect(JSON.parse(mocks.sidecarRequest.mock.calls[1]![1].body)).toMatchObject({ aspect_ratio: "9:16", image_size: "4K", google_search: false, image_search: false });
        expect(mocks.writePersistentMediaDataUrl).toHaveBeenCalledTimes(2);
        expect(mocks.inlineRemoteImageResult).not.toHaveBeenCalled();
    });

    it("keeps Auto as an omitted aspect ratio while preserving image resolution", async () => {
        mocks.sidecarRequest.mockResolvedValueOnce(sidecarJson({ data: [{ id: "gemini-2.5-flash-image" }] })).mockResolvedValueOnce(sidecarJson({ data: [{ b64_json: "aGVsbG8=" }] }));

        await runGeminiAiImageTest({ userId: "admin-a", model: "gemini-2.5-flash-image", prompt: "自动构图", aspectRatio: "auto", imageSize: "2K" });

        expect(JSON.parse(mocks.sidecarRequest.mock.calls[1]![1].body)).toEqual({ model: "gemini-2.5-flash-image", prompt: "自动构图", n: 1, image_size: "2K", google_search: false, image_search: false });
    });

    it("reports a page-native model access failure without claiming an API key is required", async () => {
        mocks.sidecarRequest.mockResolvedValueOnce(sidecarJson({ data: [{ id: "gemma-4-31b-it", type: "text" }] })).mockResolvedValueOnce(
            new Response(JSON.stringify({ detail: { message: '禁止访问: [,[7,"The caller does not have permission"]]', type: "server_error" } }), {
                status: 500,
                headers: { "content-type": "application/json" },
            }),
        );

        await expect(runGeminiAiTextTest({ model: "gemma-4-31b-it", prompt: "你好" })).rejects.toThrow("页面原生通道未能使用当前账号");
    });

    it("preserves the sidecar account-pool access diagnosis", async () => {
        mocks.sidecarRequest.mockResolvedValueOnce(sidecarJson({ data: [{ id: "gemini-3.1-flash-image", type: "image" }] })).mockResolvedValueOnce(
            new Response(JSON.stringify({ detail: { message: "Google AI Studio 已拒绝账号池调用模型 gemini-3.1-flash-image。账号登录成功只代表浏览器身份有效。", type: "account_access_denied" } }), {
                status: 403,
                headers: { "content-type": "application/json" },
            }),
        );

        await expect(runGeminiAiImageTest({ userId: "admin-a", model: "gemini-3.1-flash-image", prompt: "蓝色圆形" })).rejects.toThrow("账号登录成功只代表浏览器身份有效");
    });
});
