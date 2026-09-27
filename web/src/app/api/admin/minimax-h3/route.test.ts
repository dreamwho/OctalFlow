import { beforeEach, describe, expect, it, vi } from "vitest";

const testMocks = vi.hoisted(() => ({
    currentUser: {
        id: "admin-user",
        username: "admin",
        role: "admin",
        status: "active",
        adminPermissions: ["upstream.manage"],
    },
    authSettings: {
        systemChannels: [
            {
                id: "easyframe-minimax-h3",
                name: "easyframe MiniMaxH3",
                baseUrl: "https://minimax.api.easyframe.cn",
                apiKey: "sk-secret-token",
                apiFormat: "openai",
                models: ["minimax-h3-mini", "minimax-h3-fast"],
                enabled: true,
                advancedConfig: { protocol: "minimax-h3" },
            },
        ],
        logicalModels: [
            {
                id: "minimax-h3-mini",
                name: "minimax-h3-mini",
                capability: "video",
                enabled: true,
                bindings: [
                    {
                        id: "easyframe-minimax-h3:minimax-h3-mini",
                        channelId: "easyframe-minimax-h3",
                        upstreamModel: "minimax-h3-mini",
                        enabled: true,
                        priority: 0,
                    },
                ],
            },
        ],
    },
    generationLogs: {
        items: [
            {
                id: "log-1",
                userId: "user-1",
                username: "user1",
                displayName: "用户一",
                model: "minimax-h3-mini",
                prompt: "测试视频提示词",
                status: "success",
                resultUrl: "https://cdn.example.com/test.mp4",
                durationMs: 6500,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            },
        ],
        total: 1,
    },
    publicUsers: [
        {
            id: "user-1",
            username: "user1",
            displayName: "用户一",
            accountId: "0001",
        },
    ],
    safeOutboundResponse: new Response(
        JSON.stringify({
            data: [
                { id: "minimax-h3-mini" },
                { id: "minimax-h3-fast" },
                { id: "minimax-h3-base" },
                { id: "minimax-h3-pro" },
            ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
    ),
}));

vi.mock("@/lib/auth/session", () => ({
    getCurrentUser: vi.fn(async () => testMocks.currentUser),
}));

vi.mock("@/lib/auth/store", () => ({
    getFreshAuthSettings: vi.fn(async () => testMocks.authSettings),
    getPublicUsersByIds: vi.fn(async () => testMocks.publicUsers),
}));

vi.mock("@/lib/server/generation-log-store", () => ({
    listGenerationLogs: vi.fn(async () => testMocks.generationLogs),
}));

vi.mock("@/lib/server/safe-outbound-fetch", () => ({
    fetchSafeOutbound: vi.fn(async () => testMocks.safeOutboundResponse),
}));

import { GET, POST } from "./route";

describe("admin minimax-h3 route", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("returns channel configuration, logical models status, and video tasks", async () => {
        const req = new Request("http://localhost/api/admin/minimax-h3?page=1&pageSize=20");
        const res = await GET(req);
        expect(res.status).toBe(200);

        const data = (await res.json()) as {
            channel: { id: string; apiKey: string; hasApiKey: boolean };
            logicalModels: Array<{ id: string; resolvable: boolean }>;
            videoTasks: { items: Array<{ id: string; accountId: string }> };
            modelMetas: Array<{ id: string }>;
        };

        expect(data.channel).toMatchObject({
            id: "easyframe-minimax-h3",
            apiKey: "",
            hasApiKey: true,
        });
        expect(data.logicalModels.find((m) => m.id === "minimax-h3-mini")?.resolvable).toBe(true);
        expect(data.videoTasks.items[0]).toMatchObject({
            id: "log-1",
            accountId: "0001",
        });
        expect(data.modelMetas.length).toBe(4);
    });

    it("tests outbound connectivity via POST action=test", async () => {
        const req = new Request("http://localhost/api/admin/minimax-h3", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                action: "test",
                baseUrl: "https://minimax.api.easyframe.cn",
                apiKey: "sk-test",
            }),
        });

        const res = await POST(req);
        expect(res.status).toBe(200);

        const data = (await res.json()) as { ok: boolean; models: string[]; latencyMs: number };
        expect(data.ok).toBe(true);
        expect(data.models).toContain("minimax-h3-mini");
        expect(data.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it("rejects unsupported actions with 400", async () => {
        const req = new Request("http://localhost/api/admin/minimax-h3", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "unknown" }),
        });

        const res = await POST(req);
        expect(res.status).toBe(400);
    });
});
