import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    appendLog: vi.fn(),
    createOAuthSession: vi.fn(),
    getGateway: vi.fn(),
    getPrivateAccount: vi.fn(),
    listAccounts: vi.fn(),
    listApiKeys: vi.fn(),
    listCandidates: vi.fn(),
    listLogs: vi.fn(),
    recordUsage: vi.fn(),
    getAuthSettings: vi.fn(),
    setAuthSettings: vi.fn(),
    updateCredentials: vi.fn(),
    updateAccount: vi.fn(),
    ensureMagicProxy: vi.fn(),
    safeFetch: vi.fn(),
}));

vi.mock("@/lib/auth/store", () => ({ getAuthSettings: mocks.getAuthSettings, setAuthSettings: mocks.setAuthSettings }));
vi.mock("@/lib/server/gemini-tools-store", () => ({
    appendGeminiToolsRequestLog: mocks.appendLog,
    openGeminiToolsRequestLog: vi.fn(async () => ""),
    markGeminiToolsRequestLogRunning: vi.fn(async () => undefined),
    settleGeminiToolsRequestLog: vi.fn(async () => undefined),
    consumeGeminiToolsOAuthSession: vi.fn(),
    createGeminiToolsOAuthSession: mocks.createOAuthSession,
    getGeminiToolsGatewaySettings: mocks.getGateway,
    getGeminiToolsPrivateAccount: mocks.getPrivateAccount,
    listGeminiToolsAccounts: mocks.listAccounts,
    listGeminiToolsApiKeys: mocks.listApiKeys,
    listGeminiToolsCandidateAccounts: mocks.listCandidates,
    listGeminiToolsRequestLogs: mocks.listLogs,
    recordGeminiToolsAccountUsage: mocks.recordUsage,
    updateGeminiToolsAccountCredentials: mocks.updateCredentials,
    updateGeminiToolsAccount: mocks.updateAccount,
    upsertGeminiToolsAccount: vi.fn(),
}));
vi.mock("@/lib/server/magic-proxy-service", () => ({ ensureMagicProxyProvider: mocks.ensureMagicProxy }));
vi.mock("@/lib/server/safe-outbound-fetch", () => ({ fetchSafeOutbound: mocks.safeFetch }));

import {
    geminiToolsOAuthConfigured,
    geminiToolsRuntimeRequest,
    getGeminiToolsOverview,
    isGeminiToolsRuntimePath,
    parseGeminiToolsModelCatalog,
    refreshGeminiToolsAccount,
    saveGeminiToolsModelSelection,
    startGeminiToolsOAuth,
    syncGeminiToolsModelCatalog,
} from "./gemini-tools-service";

describe("GeminiTools runtime", () => {
    afterEach(() => vi.unstubAllEnvs());

    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubEnv("GEMINI_TOOLS_OAUTH_CLIENT_ID", "test-oauth-client-id");
        vi.stubEnv("GEMINI_TOOLS_OAUTH_CLIENT_SECRET", "test-oauth-client-secret");
        mocks.getGateway.mockResolvedValue({ enabled: true, strategy: "round_robin", sessionStickiness: false });
        mocks.ensureMagicProxy.mockResolvedValue({ enabled: false });
        mocks.safeFetch.mockImplementation((url: string | URL, init?: RequestInit) => fetch(url, init));
        mocks.createOAuthSession.mockResolvedValue("fresh-oauth-state");
        mocks.listApiKeys.mockResolvedValue([]);
        mocks.listLogs.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 8 });
        mocks.getAuthSettings.mockResolvedValue({
            systemChannels: [],
            logicalModels: [],
            defaultModels: { textModel: "", imageModel: "", videoModel: "", audioModel: "" },
        });
        mocks.listAccounts.mockResolvedValue([
            {
                id: "one",
                email: "one@example.com",
                name: "One",
                status: "active",
                proxyEnabled: true,
                priority: 0,
                quotas: [{ model: "gemini-2.5-pro", displayName: "Gemini 2.5 Pro" }],
                requestCount: 0,
                totalTokens: 0,
                errorCount: 0,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            },
        ]);
        mocks.listCandidates.mockResolvedValue([
            {
                id: "one",
                email: "one@example.com",
                name: "One",
                status: "active",
                proxyEnabled: true,
                priority: 0,
                quotas: [{ model: "gemini-2.5-pro", displayName: "Gemini 2.5 Pro", remainingPercent: 100 }],
                requestCount: 0,
                totalTokens: 0,
                errorCount: 0,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                accessToken: "token",
                refreshToken: "refresh",
                expiresAt: Date.now() + 3_600_000,
                projectId: "project-one",
            },
        ]);
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue(
                new Response(JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: "真实返回" }] } }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4, totalTokenCount: 7 } } }), {
                    status: 200,
                    headers: { "content-type": "application/json" },
                }),
            ),
        );
    });

    it("reports GeminiTools OAuth as unconfigured and blocks authorization without client env", async () => {
        vi.stubEnv("GEMINI_TOOLS_OAUTH_CLIENT_ID", "");
        vi.stubEnv("GEMINI_TOOLS_OAUTH_CLIENT_SECRET", "");
        vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://public.example.com");

        expect(geminiToolsOAuthConfigured()).toBe(false);
        await expect(
            startGeminiToolsOAuth(
                new Request("https://public.example.com/api/admin/gemini-tools/oauth/start", {
                    headers: { "x-octalflow-browser-origin": "http://localhost:3333" },
                }),
            ),
        ).rejects.toMatchObject({ status: 400 });
    });

    it("keeps a custom OAuth client on the configured public callback", async () => {
        vi.stubEnv("GEMINI_TOOLS_OAUTH_CLIENT_ID", "custom-client-id");
        vi.stubEnv("GEMINI_TOOLS_OAUTH_CLIENT_SECRET", "custom-client-secret");
        vi.stubEnv("GEMINI_TOOLS_OAUTH_REDIRECT_URI", "https://public.example.com/oauth/callback");
        vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://public.example.com");

        const result = await startGeminiToolsOAuth(
            new Request("https://public.example.com/api/admin/gemini-tools/oauth/start", {
                headers: { "x-octalflow-browser-origin": "http://localhost:3333" },
            }),
        );

        expect(result.redirectUri).toBe("https://public.example.com/oauth/callback");
        expect(new URL(result.authUrl).searchParams.get("client_id")).toBe("custom-client-id");
        expect(mocks.createOAuthSession).toHaveBeenCalledWith(result.redirectUri, "http://localhost:3333");
    });

    it("converts OpenAI chat input and Google response while recording the actual account and usage", async () => {
        const response = await geminiToolsRuntimeRequest("/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "gemini-2.5-pro", messages: [{ role: "user", content: "你好" }] }) }, { keyPrefix: "oct_gat_demo" });
        const payload = await response.json();

        expect(response.status, JSON.stringify(payload)).toBe(200);
        expect(response.headers.get("x-gemini-tools-total-tokens")).toBe("7");
        expect(payload).toMatchObject({ model: "gemini-2.5-pro", choices: [{ message: { content: "真实返回" } }], usage: { total_tokens: 7 } });
        expect(fetch).toHaveBeenCalledWith(expect.stringContaining(":generateContent"), expect.objectContaining({ method: "POST" }));
        expect(mocks.recordUsage).toHaveBeenCalledWith("one", 7, false);
        expect(mocks.appendLog).toHaveBeenCalledWith(expect.objectContaining({ accountEmail: "one@example.com", model: "gemini-2.5-pro", totalTokens: 7, keyPrefix: "oct_gat_demo" }));
    });

    it("uses the dedicated listener only as a request-scoped proxy override", async () => {
        mocks.ensureMagicProxy.mockResolvedValue({ enabled: true, proxyUrl: "http://mihomo-listener.test:17891/" });

        await geminiToolsRuntimeRequest("/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "gemini-2.5-pro", messages: [{ role: "user", content: "你好" }] }) });

        expect(mocks.ensureMagicProxy).toHaveBeenCalledTimes(1);
        expect(mocks.safeFetch).toHaveBeenCalledWith(expect.stringContaining(":generateContent"), expect.objectContaining({ method: "POST" }), { allowProxyFakeIpSpace: true, proxyUrl: "http://mihomo-listener.test:17891/" });
    });

    it("does not replay a generation through another account after an ambiguous upstream failure", async () => {
        mocks.listCandidates.mockResolvedValue([
            ...(await mocks.listCandidates()),
            {
                id: "two",
                email: "two@example.com",
                name: "Two",
                status: "active",
                proxyEnabled: true,
                priority: 1,
                quotas: [{ model: "gemini-2.5-pro", displayName: "Gemini 2.5 Pro" }],
                requestCount: 0,
                totalTokens: 0,
                errorCount: 0,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                accessToken: "token-two",
                refreshToken: "refresh-two",
                expiresAt: Date.now() + 3_600_000,
                projectId: "project-two",
            },
        ]);
        mocks.safeFetch.mockResolvedValue(new Response(JSON.stringify({ error: { message: "temporary upstream failure" } }), { status: 502 }));

        const response = await geminiToolsRuntimeRequest("/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "gemini-2.5-pro", messages: [{ role: "user", content: "不要重试" }] }) });

        expect(response.status).toBe(502);
        expect(mocks.safeFetch).toHaveBeenCalledTimes(1);
        expect(mocks.recordUsage).toHaveBeenCalledWith("one", 0, true);
        expect(mocks.recordUsage).not.toHaveBeenCalledWith("two", 0, true);
        expect(mocks.appendLog).toHaveBeenCalledWith(expect.objectContaining({ accountId: "one", accountEmail: "one@example.com", error: "temporary upstream failure" }));
    });

    it("surfaces a string Google OAuth error and identifies the failed account", async () => {
        mocks.listCandidates.mockResolvedValue([
            {
                ...(await mocks.listCandidates())[0],
                accessToken: "expired-token",
                refreshToken: "refresh-token",
                expiresAt: 0,
            },
        ]);
        mocks.safeFetch.mockResolvedValue(Response.json({ error: "invalid_grant" }, { status: 400 }));

        const response = await geminiToolsRuntimeRequest("/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "gemini-2.5-pro", messages: [{ role: "user", content: "刷新授权" }] }) });
        const payload = await response.json();

        expect(response.status).toBe(400);
        expect(payload).toEqual({ error: { message: "invalid_grant" } });
        expect(mocks.updateAccount).toHaveBeenCalledWith("one", { status: "invalid" });
        expect(mocks.appendLog).toHaveBeenCalledWith(expect.objectContaining({ accountId: "one", accountEmail: "one@example.com", error: "invalid_grant" }));
    });

    it("forwards OpenAI image parts to Antigravity as Gemini inlineData", async () => {
        await geminiToolsRuntimeRequest(
            "/v1/chat/completions",
            {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    model: "gemini-2.5-pro",
                    messages: [
                        {
                            role: "user",
                            content: [
                                { type: "text", text: "描述图片" },
                                { type: "image_url", image_url: { url: "data:image/jpeg;base64,YWJj" } },
                            ],
                        },
                    ],
                }),
            },
            { protocol: "openai" },
        );

        const upstream = vi.mocked(fetch).mock.calls.at(-1);
        const body = JSON.parse(String(upstream?.[1]?.body)) as { request: { contents: Array<{ parts: Array<Record<string, unknown>> }> } };
        expect(body.request.contents[0].parts).toEqual([{ text: "描述图片" }, { inlineData: { mimeType: "image/jpeg", data: "YWJj" } }]);
    });

    it("advertises only implemented compatibility endpoints", async () => {
        expect(isGeminiToolsRuntimePath("/v1/models")).toBe(true);
        expect(isGeminiToolsRuntimePath("/v1/chat/completions")).toBe(true);
        expect(isGeminiToolsRuntimePath("/chat/completions")).toBe(true);
        expect(isGeminiToolsRuntimePath("/v1/messages")).toBe(true);
        expect(isGeminiToolsRuntimePath("/v1/responses")).toBe(false);
    });

    it("creates the provider-managed channel and synchronizes its logical text model", async () => {
        const result = await saveGeminiToolsModelSelection({ models: ["gemini-2.5-pro"] });

        expect(result.channel).toMatchObject({ id: "gemini-antigravity-tools", name: "Gemini Antigravity Tools", enabled: true, models: ["gemini-2.5-pro"] });
        expect(mocks.setAuthSettings).toHaveBeenCalledWith({
            systemChannels: [
                expect.objectContaining({
                    id: "gemini-antigravity-tools",
                    name: "Gemini Antigravity Tools",
                    baseUrl: "",
                    apiKey: "",
                    enabled: true,
                    models: ["gemini-2.5-pro"],
                    advancedConfig: expect.objectContaining({ protocol: "gemini-tools", authMode: "provider-managed", supportsReferenceImage: true, modelCapabilities: { "gemini-2.5-pro": "text" } }),
                }),
            ],
            logicalModels: [expect.objectContaining({ id: "gemini-2.5-pro", capability: "text", bindings: [expect.objectContaining({ channelId: "gemini-antigravity-tools", upstreamModel: "gemini-2.5-pro" })] })],
            defaultModels: { textModel: "", imageModel: "", videoModel: "", audioModel: "" },
        });
    });

    it("keeps dynamically returned model IDs and parses upstream deprecation metadata without a local allowlist", () => {
        const catalog = parseGeminiToolsModelCatalog({
            models: {
                "gemini-3.8-flash-high": { displayName: "Gemini 3.8 Flash High", quotaInfo: { remainingFraction: 0.42 }, supportsThinking: true },
                "provider-new-unknown-model": { supportsImages: true },
            },
            deprecatedModelIds: { "gemini-legacy": { newModelId: "gemini-3.8-flash-high" } },
        });

        expect(catalog.quotas).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ model: "gemini-3.8-flash-high", displayName: "Gemini 3.8 Flash High", remainingPercent: 42, supportsThinking: true }),
                expect.objectContaining({ model: "provider-new-unknown-model", displayName: "provider-new-unknown-model", supportsImages: true }),
            ]),
        );
        expect(catalog.deprecatedModelIds).toEqual({ "gemini-legacy": "gemini-3.8-flash-high" });
    });

    it("retries fetchAvailableModels without project after an upstream 403", async () => {
        mocks.getPrivateAccount.mockResolvedValue({
            id: "one",
            email: "one@example.com",
            name: "One",
            status: "active",
            proxyEnabled: true,
            priority: 0,
            quotas: [],
            requestCount: 0,
            totalTokens: 0,
            errorCount: 0,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            accessToken: "expired-token",
            refreshToken: "refresh-token",
            expiresAt: Date.now() + 3_600_000,
            projectId: "project-one",
        });
        vi.stubGlobal(
            "fetch",
            vi.fn(async (url: string | URL, init?: RequestInit) => {
                if (String(url) === "https://oauth2.googleapis.com/token") return new Response(JSON.stringify({ access_token: "fresh-token", expires_in: 3600 }), { status: 200 });
                const body = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
                if (body.project) return new Response(JSON.stringify({ error: { message: "project is not permitted" } }), { status: 403 });
                return new Response(JSON.stringify({ models: { "gemini-3.8-flash-high": { displayName: "Gemini 3.8 Flash High" } } }), { status: 200 });
            }),
        );

        await refreshGeminiToolsAccount("one");

        expect(mocks.safeFetch).toHaveBeenCalledWith("https://oauth2.googleapis.com/token", expect.objectContaining({ method: "POST" }), { allowProxyFakeIpSpace: true });
        const modelCalls = vi
            .mocked(fetch)
            .mock.calls.filter(([url]) => String(url).includes(":fetchAvailableModels"))
            .map(([, init]) => JSON.parse(String(init?.body || "{}")));
        expect(modelCalls).toEqual([{ project: "project-one" }, {}]);
        expect(mocks.updateCredentials).toHaveBeenLastCalledWith("one", expect.objectContaining({ quotas: [expect.objectContaining({ model: "gemini-3.8-flash-high" })], status: "active" }));
    });

    it("preserves the channel selection on catalog sync unless new models are explicitly enabled", async () => {
        let accounts = [
            {
                id: "one",
                email: "one@example.com",
                name: "One",
                status: "active" as const,
                proxyEnabled: true,
                priority: 0,
                quotas: [{ model: "gemini-3.7-flash", displayName: "Gemini 3.7 Flash" }],
                requestCount: 0,
                totalTokens: 0,
                errorCount: 0,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            },
        ];
        const settings = {
            systemChannels: [{ id: "gemini-antigravity-tools", name: "Gemini Antigravity Tools", baseUrl: "", apiKey: "", apiFormat: "openai" as const, enabled: true, models: ["gemini-3.7-flash"], advancedConfig: { protocol: "gemini-tools" as const } }],
            logicalModels: [],
            defaultModels: { textModel: "", imageModel: "", videoModel: "", audioModel: "" },
        };
        mocks.listAccounts.mockImplementation(async () => accounts);
        mocks.getAuthSettings.mockResolvedValue(settings);
        mocks.getPrivateAccount.mockResolvedValue({ ...accounts[0], accessToken: "expired-token", refreshToken: "refresh-token", expiresAt: Date.now() + 3_600_000, projectId: "project-one" });
        mocks.updateCredentials.mockImplementation(async (_id, patch) => {
            if (patch.quotas) accounts = [{ ...accounts[0], quotas: patch.quotas }];
        });
        vi.stubGlobal(
            "fetch",
            vi.fn(async (url: string | URL) => {
                if (String(url) === "https://oauth2.googleapis.com/token") return new Response(JSON.stringify({ access_token: "fresh-token", expires_in: 3600 }), { status: 200 });
                return new Response(JSON.stringify({ models: { "gemini-3.7-flash": { displayName: "Gemini 3.7 Flash" }, "gemini-3.8-flash-high": { displayName: "Gemini 3.8 Flash High" } } }), { status: 200 });
            }),
        );

        const result = await syncGeminiToolsModelCatalog();

        expect(result.newModels).toEqual([{ id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash High" }]);
        expect(result.enabledNewModelIds).toEqual([]);
        expect(result.overview.channel?.models).toEqual(["gemini-3.7-flash"]);
        expect(result.overview.models).toEqual(expect.arrayContaining([expect.objectContaining({ id: "gemini-3.8-flash-high", enabled: false, available: true })]));
        expect(mocks.setAuthSettings).not.toHaveBeenCalled();
    });

    it("adds only this sync's newly discovered models when explicitly requested", async () => {
        let accounts = [
            {
                id: "one",
                email: "one@example.com",
                name: "One",
                status: "active" as const,
                proxyEnabled: true,
                priority: 0,
                quotas: [{ model: "gemini-3.7-flash", displayName: "Gemini 3.7 Flash" }],
                requestCount: 0,
                totalTokens: 0,
                errorCount: 0,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            },
        ];
        let settings = {
            systemChannels: [{ id: "gemini-antigravity-tools", name: "Gemini Antigravity Tools", baseUrl: "", apiKey: "", apiFormat: "openai" as const, enabled: true, models: ["gemini-3.7-flash"], advancedConfig: { protocol: "gemini-tools" as const } }],
            logicalModels: [],
            defaultModels: { textModel: "", imageModel: "", videoModel: "", audioModel: "" },
        };
        mocks.listAccounts.mockImplementation(async () => accounts);
        mocks.getAuthSettings.mockImplementation(async () => settings);
        mocks.setAuthSettings.mockImplementation(async (next) => {
            settings = next;
        });
        mocks.getPrivateAccount.mockResolvedValue({ ...accounts[0], accessToken: "expired-token", refreshToken: "refresh-token", expiresAt: Date.now() + 3_600_000, projectId: "project-one" });
        mocks.updateCredentials.mockImplementation(async (_id, patch) => {
            if (patch.quotas) accounts = [{ ...accounts[0], quotas: patch.quotas }];
        });
        vi.stubGlobal(
            "fetch",
            vi.fn(async (url: string | URL) => {
                if (String(url) === "https://oauth2.googleapis.com/token") return new Response(JSON.stringify({ access_token: "fresh-token", expires_in: 3600 }), { status: 200 });
                return new Response(JSON.stringify({ models: { "gemini-3.7-flash": { displayName: "Gemini 3.7 Flash" }, "gemini-3.8-flash-high": { displayName: "Gemini 3.8 Flash High" } } }), { status: 200 });
            }),
        );

        const result = await syncGeminiToolsModelCatalog({ enableNewModels: true });

        expect(result.enabledNewModelIds).toEqual(["gemini-3.8-flash-high"]);
        expect(result.overview.channel?.models).toEqual(["gemini-3.7-flash", "gemini-3.8-flash-high"]);
        expect(mocks.setAuthSettings).toHaveBeenCalledWith(expect.objectContaining({ systemChannels: [expect.objectContaining({ models: ["gemini-3.7-flash", "gemini-3.8-flash-high"] })] }));
    });

    it("surfaces a saved model that the refreshed account catalog no longer returns", async () => {
        mocks.getAuthSettings.mockResolvedValue({
            systemChannels: [{ id: "gemini-antigravity-tools", name: "Gemini Antigravity Tools", baseUrl: "", apiKey: "", apiFormat: "openai", enabled: true, models: ["gemini-2.5-pro", "gemini-retired"], advancedConfig: { protocol: "gemini-tools" } }],
            logicalModels: [],
            defaultModels: { textModel: "", imageModel: "", videoModel: "", audioModel: "" },
        });

        const overview = await getGeminiToolsOverview();

        expect(overview.models).toEqual(expect.arrayContaining([expect.objectContaining({ id: "gemini-retired", enabled: true, available: false })]));
        await expect(saveGeminiToolsModelSelection({ models: ["gemini-retired"] })).resolves.toMatchObject({ channel: { models: ["gemini-retired"] }, models: [expect.objectContaining({ id: "gemini-retired", available: false })] });
    });

    it("does not advertise quota models from accounts that runtime routing will not select", async () => {
        mocks.listAccounts.mockResolvedValue([
            {
                id: "disabled-proxy",
                email: "disabled@example.com",
                name: "Disabled proxy",
                status: "active",
                proxyEnabled: false,
                priority: 0,
                quotas: [{ model: "hidden-model", displayName: "Hidden Model" }],
                requestCount: 0,
                totalTokens: 0,
                errorCount: 0,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            },
            {
                id: "invalid-account",
                email: "invalid@example.com",
                name: "Invalid account",
                status: "invalid",
                proxyEnabled: true,
                priority: 0,
                quotas: [{ model: "invalid-model", displayName: "Invalid Model" }],
                requestCount: 0,
                totalTokens: 0,
                errorCount: 0,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            },
            {
                id: "routable-account",
                email: "routable@example.com",
                name: "Routable account",
                status: "active",
                proxyEnabled: true,
                priority: 0,
                quotas: [{ model: "routable-model", displayName: "Routable Model" }],
                requestCount: 0,
                totalTokens: 0,
                errorCount: 0,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            },
        ]);

        const overview = await getGeminiToolsOverview();

        expect(overview.models.map((model) => model.id)).toEqual(["routable-model"]);
    });
});
