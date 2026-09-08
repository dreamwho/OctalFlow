import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthSettings } from "@/lib/auth/store";
import { emptyAdvancedConfig } from "@/lib/channel-protocol-registry";

const fixture = vi.hoisted(() => {
    class FixtureChatGptApiError extends Error {
        constructor(
            message: string,
            readonly status = 502,
        ) {
            super(message);
        }
    }
    return {
        ChatGptApiError: FixtureChatGptApiError,
        getFreshAuthSettings: vi.fn(),
        setAuthSettings: vi.fn(),
        runtimeConfig: vi.fn(),
        runtimeJson: vi.fn(),
    };
});

vi.mock("@/lib/auth/store", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/lib/auth/store")>();
    return { ...actual, getFreshAuthSettings: fixture.getFreshAuthSettings, setAuthSettings: fixture.setAuthSettings };
});

vi.mock("@/lib/server/chatgpt-api-service", () => ({
    ChatGptApiError: fixture.ChatGptApiError,
    chatGptRuntimeJson: fixture.runtimeJson,
    getChatGptRuntimeConfig: fixture.runtimeConfig,
}));

import { CHATGPT_API_CHANNEL_ID, CHATGPT_API_PROTOCOL, getChatGptModelCatalog, getChatGptSavedModels, isChatGptApiRuntimePath, normalizeChatGptApiRuntimePath, saveChatGptModels } from "./chatgpt-api-models";

describe("chatgpt api model selection", () => {
    it("exposes typed managed catalog for generic channel onboarding without persistence", async () => {
        fixture.runtimeJson.mockResolvedValueOnce({ chat_models: ["gpt-5", "gpt-5"], image_models: ["gpt-image-2"] });
        const catalog = await getChatGptModelCatalog();
        expect(catalog.models).toEqual(["gpt-5", "gpt-image-2"]);
        expect(catalog.modelCapabilities).toEqual({ "gpt-5": "text", "gpt-image-2": "image" });
        expect(catalog.modelConfigs["gpt-image-2"].supportsReferenceImage).toBe(true);
        expect(fixture.setAuthSettings).not.toHaveBeenCalled();
    });
    let settings: Pick<AuthSettings, "systemChannels" | "logicalModels" | "defaultModels">;

    beforeEach(() => {
        settings = {
            systemChannels: [],
            logicalModels: [],
            defaultModels: { textModel: "", imageModel: "", videoModel: "", audioModel: "" },
        };
        fixture.getFreshAuthSettings.mockImplementation(async () => settings);
        fixture.setAuthSettings.mockImplementation(async (patch: Partial<AuthSettings>) => {
            settings = { ...settings, ...patch };
            return settings;
        });
        fixture.runtimeConfig.mockReturnValue({ url: "https://runtime.example", key: "runtime-master-key" });
        fixture.runtimeJson.mockImplementation(async (path: string, init?: RequestInit) => {
            if (path === "/api/model-catalog") return { chat_models: ["gpt-5.6"], image_models: ["gpt-image-1"] };
            throw new Error(`unexpected runtime path: ${path}`);
        });
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    it("returns the saved selection from fresh settings", async () => {
        settings.systemChannels = [
            {
                id: CHATGPT_API_CHANNEL_ID,
                name: "GPTAPI",
                baseUrl: "",
                apiKey: "",
                apiFormat: "openai",
                models: ["gpt-5.6"],
                enabled: true,
                advancedConfig: { ...emptyAdvancedConfig(), protocol: CHATGPT_API_PROTOCOL, authMode: "provider-managed" },
            },
        ];

        await expect(getChatGptSavedModels()).resolves.toEqual({ models: ["gpt-5.6"] });
        expect(fixture.getFreshAuthSettings).toHaveBeenCalledTimes(1);
    });

    it("validates the native catalog and persists a provider-managed channel with logical model bindings", async () => {
        const saved = await saveChatGptModels({ models: ["gpt-5.6", "gpt-image-1"] });

        expect(fixture.runtimeJson).toHaveBeenCalledWith("/api/model-catalog", { method: "GET" });
        expect(fixture.runtimeJson.mock.calls.some(([path]) => String(path).startsWith("/api/auth/users"))).toBe(false);
        expect(saved).toEqual({
            models: ["gpt-5.6", "gpt-image-1"],
            channel: { id: CHATGPT_API_CHANNEL_ID, name: "GPTAPI", enabled: true, models: ["gpt-5.6", "gpt-image-1"] },
        });
        const channel = settings.systemChannels[0];
        expect(channel).toMatchObject({
            id: CHATGPT_API_CHANNEL_ID,
            baseUrl: "",
            apiKey: "",
            apiFormat: "openai",
            enabled: true,
            advancedConfig: {
                protocol: CHATGPT_API_PROTOCOL,
                authMode: "provider-managed",
                modelCapabilities: { "gpt-5.6": "text", "gpt-image-1": "image" },
                modelConfigs: {
                    "gpt-5.6": { protocol: CHATGPT_API_PROTOCOL, capability: "text", createPath: "/chat/completions" },
                    "gpt-image-1": { protocol: CHATGPT_API_PROTOCOL, capability: "image", createPath: "/images/generations", editPath: "/images/edits" },
                },
            },
        });
        expect(channel.apiKey).not.toBe("runtime-master-key");
        expect(settings.logicalModels).toMatchObject([
            { id: "gpt-5.6", capability: "text", bindings: [{ channelId: CHATGPT_API_CHANNEL_ID, upstreamModel: "gpt-5.6" }] },
            { id: "gpt-image-1", capability: "image", bindings: [{ channelId: CHATGPT_API_CHANNEL_ID, upstreamModel: "gpt-image-1" }] },
        ]);
    });

    it("replaces a legacy self-HTTP source key with the managed channel semantics", async () => {
        settings.systemChannels = [{ id: CHATGPT_API_CHANNEL_ID, name: "GPTAPI", baseUrl: "https://octal.example/api/chatgpt-api/v1", apiKey: "persisted-source-key", apiFormat: "openai", models: ["gpt-5.6"], enabled: true }];

        await saveChatGptModels({ models: ["gpt-5.6"] });

        expect(fixture.runtimeJson.mock.calls.some(([path]) => String(path).startsWith("/api/auth/users"))).toBe(false);
        expect(settings.systemChannels[0]).toMatchObject({ baseUrl: "", apiKey: "", advancedConfig: { protocol: CHATGPT_API_PROTOCOL, authMode: "provider-managed" } });
    });

    it("rejects a selection outside the native catalog without persisting it", async () => {
        await expect(saveChatGptModels({ models: ["not-in-catalog"] })).rejects.toMatchObject({ status: 422 });
        expect(fixture.setAuthSettings).not.toHaveBeenCalled();
    });

    it("serializes concurrent saves without creating native source users", async () => {
        await Promise.all([saveChatGptModels({ models: ["gpt-5.6"] }), saveChatGptModels({ models: ["gpt-5.6"] })]);

        expect(fixture.runtimeJson.mock.calls.some(([path]) => String(path).startsWith("/api/auth/users"))).toBe(false);
        expect(settings.systemChannels[0]).toMatchObject({ apiKey: "", advancedConfig: { protocol: CHATGPT_API_PROTOCOL } });
    });

    it("accepts only the runtime endpoints exposed by the managed protocol", () => {
        expect(normalizeChatGptApiRuntimePath("/chat/completions")).toBe("/v1/chat/completions");
        expect(normalizeChatGptApiRuntimePath("/v1/images/edits?stream=false")).toBe("/v1/images/edits?stream=false");
        expect(isChatGptApiRuntimePath("/v1/responses")).toBe(true);
        expect(isChatGptApiRuntimePath("/api/model-catalog")).toBe(false);
        expect(isChatGptApiRuntimePath("//v1/chat/completions")).toBe(false);
        expect(isChatGptApiRuntimePath("/v1/../integration/auth")).toBe(false);
    });
});
