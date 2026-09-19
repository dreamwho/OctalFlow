import { beforeEach, describe, expect, it, vi } from "vitest";

const user = { id: "admin-one", username: "admin", displayName: "管理员", role: "admin", status: "active", adminPermissions: ["upstream.manage"] };
const syncResult = {
    accountResults: [{ id: "account-one", ok: true }],
    discoveredModels: [{ id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash High" }],
    newModels: [{ id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash High" }],
    enabledNewModelIds: ["gemini-3.8-flash-high"],
    overview: { configured: true, healthy: true, accounts: [], apiKeys: [], gateway: { enabled: true, strategy: "round_robin" as const, sessionStickiness: false }, logs: { items: [], total: 0, page: 1, pageSize: 8 }, models: [] },
};
const mocks = vi.hoisted(() => ({
    requireAdmin: vi.fn(),
    auditAction: vi.fn(),
    routeError: vi.fn((error: Error) => new Response(JSON.stringify({ code: 500, data: null, msg: error.message }), { status: 500, headers: { "content-type": "application/json" } })),
    readJson: vi.fn(),
    syncCatalog: vi.fn(),
}));

vi.mock("@/lib/server/gemini-tools-admin", () => ({
    requireGeminiToolsAdmin: mocks.requireAdmin,
    auditGeminiToolsAction: mocks.auditAction,
    geminiToolsRouteError: mocks.routeError,
    readGeminiToolsAdminJson: mocks.readJson,
}));
vi.mock("@/lib/server/gemini-tools-service", () => ({ syncGeminiToolsModelCatalog: mocks.syncCatalog }));

import { POST } from "./sync/route";

describe("GeminiTools model catalog sync route", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.requireAdmin.mockResolvedValue({ user });
        mocks.readJson.mockResolvedValue({ enableNewModels: true });
        mocks.syncCatalog.mockResolvedValue(syncResult);
    });

    it("refreshes the dynamic account catalog and records its explicit enable choice", async () => {
        const response = (await POST(new Request("http://localhost/api/admin/gemini-tools/models/sync", { method: "POST", body: JSON.stringify({ enableNewModels: true }) })))!;

        expect(await response.json()).toEqual({ code: 0, data: syncResult, msg: "GeminiTools 最新模型目录已获取" });
        expect(mocks.syncCatalog).toHaveBeenCalledWith({ enableNewModels: true });
        expect(mocks.auditAction).toHaveBeenCalledWith(
            expect.any(Request),
            user,
            "admin.gemini_tools.models.sync",
            { type: "gemini_tools_model_catalog" },
            { accountCount: 1, refreshedAccountCount: 1, discoveredCount: 1, newModelCount: 1, enabledNewModelCount: 1 },
        );
    });
});
