import { NextResponse } from "next/server";
import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS } from "./store-foundation";
import type { AuthSettings } from "./store-types";
import { serializePublicSettings, setSessionCookie } from "./session";
import { DEFAULT_USER_ROLE } from "@/lib/user-roles";

afterEach(() => {
    delete process.env.DREAMYO_COOKIE_SECURE;
    delete process.env.DREAMYO_TRUSTED_PROXY_HOPS;
});

describe("serializePublicSettings", () => {
    it("only exposes the browser settings allowlist", () => {
        const settings: AuthSettings = structuredClone(DEFAULT_SETTINGS);
        settings.mail = { ...settings.mail, host: "smtp.internal", username: "mail-user", password: "mail-secret" };
        settings.allowUserApiConfig = true;
        settings.freeDailyPointsEnabled = true;
        settings.freeDailyPoints = 99;
        settings.agentSkills = [
            {
                id: "secret-skill",
                name: "内部 Skill",
                description: "内部说明",
                instructions: "不得进入公开会话的完整指令",
                enabled: true,
                keywords: ["内部"],
            },
        ];
        settings.systemChannels = [
            {
                id: "channel-one",
                name: "渠道一",
                baseUrl: "https://internal-provider.example/v1",
                apiKey: "provider-secret",
                apiFormat: "openai",
                models: ["vendor-image"],
                enabled: true,
                advancedConfig: {
                    protocol: "custom",
                    authHeader: "X-Secret-Key",
                    authPrefix: "Private ",
                    textModel: "",
                    imageModel: "vendor-image",
                    videoModel: "",
                    createPath: "/private/create",
                    queryPath: "/private/query/:id",
                    requestTemplate: '{"secret":true}',
                    resultField: "private.result",
                    statusField: "private.status",
                    durationRange: "",
                    referenceRule: "",
                    supportsReferenceImage: true,
                    supportsReferenceVideo: false,
                    supportsReferenceAudio: false,
                    modelCatalogPaths: ["/private/models"],
                },
            },
        ];
        settings.logicalModels = [
            {
                id: "image-main",
                name: "图片模型",
                capability: "image",
                enabled: true,
                pickerVisible: false,
                bindings: [
                    {
                        id: "binding-one",
                        channelId: "channel-one",
                        upstreamModel: "vendor-image",
                        enabled: true,
                        priority: 1,
                        weight: 8,
                        capabilityProfile: { unitCost: 3, unitCostCurrency: "USD", timeoutMs: 60_000 },
                    },
                ],
            },
        ];
        settings.site.socials = {
            email: { enabled: true, label: "邮箱", url: "mailto:owner@example.com" },
            telegram: { enabled: true, label: "Telegram", url: "https://t.me/dreamyo_group" },
            x: { enabled: true, label: "X", url: "https://x.com/dreamyo" },
            instagram: { enabled: true, label: "Instagram", url: "https://instagram.com/dreamyo.pro" },
        };

        const result = serializePublicSettings(settings);
        const serialized = JSON.stringify(result);

        expect(result.systemChannels).toEqual([
            {
                id: "channel-one",
                name: "渠道一",
                baseUrl: "/api/ai/system/channel-one",
                apiKey: "system",
                apiFormat: "openai",
                models: ["vendor-image"],
                enabled: true,
                hasApiKey: true,
            },
        ]);
        expect(result.logicalModels[0]).toMatchObject({ id: "image-main", pickerVisible: false });
        expect(result.logicalModels[0]?.bindings[0]).toEqual({ id: "binding-one", channelId: "channel-one", upstreamModel: "vendor-image", enabled: true, priority: 1 });
        expect(serialized).not.toContain("provider-secret");
        expect(serialized).not.toContain("internal-provider.example");
        expect(serialized).not.toContain("smtp.internal");
        expect(serialized).not.toContain("mail-secret");
        expect(serialized).not.toContain("private/create");
        expect(serialized).not.toContain("完整指令");
        expect(result).not.toHaveProperty("mail");
        expect(result).not.toHaveProperty("agentSkills");
        expect(result).not.toHaveProperty("entitlements");
        expect(result).not.toHaveProperty("allowUserApiConfig");
        expect(result).not.toHaveProperty("freeDailyPoints");
        expect(result.site).not.toHaveProperty("homeShowcaseMode");
        expect(result.site).not.toHaveProperty("homeShowcaseItems");
        expect(result.site.socials).toEqual(settings.site.socials);
    });

    it("publishes provider-managed channels as ready without exposing a server credential", () => {
        const settings: AuthSettings = structuredClone(DEFAULT_SETTINGS);
        settings.systemChannels = [
            {
                id: "geminiai",
                name: "GeminiAI",
                baseUrl: "http://127.0.0.1:18080/v1",
                apiKey: "",
                apiFormat: "openai",
                models: ["gemini-3.1-flash-image-preview"],
                enabled: true,
                advancedConfig: {
                    protocol: "geminiai",
                    authMode: "provider-managed",
                    textModel: "",
                    imageModel: "gemini-3.1-flash-image-preview",
                    videoModel: "",
                    createPath: "/images/generations",
                    editPath: "/images/edits",
                    queryPath: "",
                    requestTemplate: '{"model":"{{model}}"}',
                    resultField: "data[0].b64_json",
                    statusField: "",
                    durationRange: "",
                    referenceRule: "",
                    supportsReferenceImage: true,
                    supportsReferenceVideo: false,
                    supportsReferenceAudio: false,
                },
            },
        ];
        settings.logicalModels = [{ id: "geminiai-image", name: "GeminiAI 生图", capability: "image", enabled: true, bindings: [{ id: "geminiai-binding", channelId: "geminiai", upstreamModel: "gemini-3.1-flash-image-preview", enabled: true, priority: 1 }] }];

        const result = serializePublicSettings(settings);

        expect(result.systemChannels[0]).toMatchObject({ id: "geminiai", apiKey: "system", hasApiKey: true });
        expect(JSON.stringify(result)).not.toContain("127.0.0.1:18080");
        expect(JSON.stringify(result)).not.toContain("provider-managed");
    });

    it("publishes only safe audio feature switches to the browser", () => {
        const settings: AuthSettings = structuredClone(DEFAULT_SETTINGS);
        settings.systemChannels = [
            {
                id: "minimax-audio",
                name: "MiniMax 音频",
                baseUrl: "https://api.minimaxi.com",
                apiKey: "provider-secret",
                apiFormat: "openai",
                models: ["speech-2.8-hd"],
                enabled: true,
                advancedConfig: {
                    protocol: "minimax-audio",
                    minimaxVoiceCloneEnabled: false,
                    minimaxVoiceDesignEnabled: false,
                    authHeader: "X-Secret-Key",
                    textModel: "",
                    imageModel: "",
                    videoModel: "",
                    createPath: "/private/create",
                    queryPath: "/private/query",
                    requestTemplate: "secret",
                    resultField: "result",
                    statusField: "status",
                    durationRange: "",
                    referenceRule: "",
                    supportsReferenceImage: false,
                    supportsReferenceVideo: false,
                    supportsReferenceAudio: false,
                },
            },
        ];
        settings.logicalModels = [{ id: "minimax-audio-model", name: "MiniMax 音频模型", capability: "audio", enabled: true, bindings: [{ id: "minimax-audio-binding", channelId: "minimax-audio", upstreamModel: "speech-2.8-hd", enabled: true, priority: 1 }] }];

        const result = serializePublicSettings(settings);
        expect(result.systemChannels[0]?.advancedConfig).toEqual({ protocol: "minimax-audio", minimaxVoiceCloneEnabled: false, minimaxVoiceDesignEnabled: false });
        expect(JSON.stringify(result)).not.toContain("provider-secret");
        expect(JSON.stringify(result)).not.toContain("private/create");
        expect(JSON.stringify(result)).not.toContain("X-Secret-Key");
    });

    it("filters model choices and applies role pricing in the public settings", () => {
        const settings: AuthSettings = structuredClone(DEFAULT_SETTINGS);
        settings.userRoles = [structuredClone(DEFAULT_USER_ROLE), {
            ...structuredClone(DEFAULT_USER_ROLE),
            id: "image-only",
            name: "图片用户",
            pointsMultiplier: 0.5,
            modelAccess: { all: false, capabilities: ["image"], modelIds: [], excludedModelIds: [] },
        }];
        settings.systemChannels = [{ id: "channel", name: "渠道", baseUrl: "https://example.test", apiKey: "secret", apiFormat: "openai", models: ["vendor-image", "vendor-video"], enabled: true }];
        settings.logicalModels = [
            { id: "image-main", name: "图片模型", capability: "image", enabled: true, bindings: [{ id: "image-binding", channelId: "channel", upstreamModel: "vendor-image", enabled: true, priority: 1 }] },
            { id: "video-main", name: "视频模型", capability: "video", enabled: true, bindings: [{ id: "video-binding", channelId: "channel", upstreamModel: "vendor-video", enabled: true, priority: 1 }] },
        ];
        settings.modelPointCosts = { "image-main": 4, "vendor-image": 6, "video-main": 10, "vendor-video": 12 };

        const result = serializePublicSettings(settings, { role: "image-only" });

        expect(result.logicalModels.map((model) => model.id)).toEqual(["image-main"]);
        expect(result.systemChannels[0]?.models).toEqual(["vendor-image"]);
        expect(result.modelPointCosts).toEqual({ "image-main": 2, "vendor-image": 3 });
    });
});

describe("session cookie security", () => {
    it("ignores forwarded protocol headers unless proxy trust is configured", () => {
        const response = NextResponse.json({ ok: true });
        setSessionCookie(response, "session", new Request("http://localhost", { headers: { "x-forwarded-proto": "https" } }));

        expect(response.headers.get("set-cookie")).not.toContain("Secure");
    });

    it("uses Secure behind a configured HTTPS reverse proxy", () => {
        process.env.DREAMYO_TRUSTED_PROXY_HOPS = "1";
        const response = NextResponse.json({ ok: true });
        setSessionCookie(response, "session", new Request("http://localhost", { headers: { "x-forwarded-proto": "https" } }));

        expect(response.headers.get("set-cookie")).toContain("Secure");
    });

    it("uses Secure for direct HTTPS requests", () => {
        const response = NextResponse.json({ ok: true });
        setSessionCookie(response, "session", new Request("https://example.test/login"));

        expect(response.headers.get("set-cookie")).toContain("Secure");
    });
});
