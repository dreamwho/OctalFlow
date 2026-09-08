import { beforeEach, describe, expect, it, vi } from "vitest";

const user = { id: "admin-one", username: "admin", displayName: "管理员", role: "admin", status: "active", adminPermissions: ["upstream.manage"] };
const models = [
    { id: "gemini-2.5-pro", name: "gemini-2.5-pro", capabilities: ["text", "search"], enabled: false, source: "geminiai" },
    { id: "gemini-2.5-flash-image", name: "gemini-2.5-flash-image", capabilities: ["image"], enabled: false, source: "geminiai" },
];
const mocks = vi.hoisted(() => ({
    requireAdmin: vi.fn(),
    auditAction: vi.fn(),
    auditFailure: vi.fn(),
    routeError: vi.fn((error: Error) => new Response(JSON.stringify({ code: 500, data: null, msg: error.message }), { status: 500, headers: { "content-type": "application/json" } })),
    listCatalog: vi.fn(),
    saveSelection: vi.fn(),
}));

vi.mock("@/lib/server/geminiai-admin", () => ({
    requireGeminiAiAdmin: mocks.requireAdmin,
    auditGeminiAiAdminAction: mocks.auditAction,
    auditGeminiAiAdminFailure: mocks.auditFailure,
    geminiAiRouteError: mocks.routeError,
}));
vi.mock("@/lib/server/geminiai-service", () => ({ listGeminiAiCatalog: mocks.listCatalog, saveGeminiAiModelSelection: mocks.saveSelection }));

import { PUT } from "./route";
import { POST as syncModels } from "./sync/route";

function request(body: unknown) {
    return new Request("http://localhost/api/admin/geminiai/models", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

describe("GeminiAI model synchronization and selection routes", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.requireAdmin.mockResolvedValue({ user });
        mocks.listCatalog.mockResolvedValue(models);
        mocks.saveSelection.mockResolvedValue({ channel: { id: "geminiai", name: "Gemini AI Studio", enabled: true, models: models.map((model) => model.id) }, models: models.map((model) => ({ ...model, enabled: true })) });
    });

    it("returns the synchronized catalog without implicitly saving it", async () => {
        const response = (await syncModels(new Request("http://localhost/api/admin/geminiai/models/sync", { method: "POST" })))!;

        expect(await response.json()).toEqual({ code: 0, data: { models }, msg: "GeminiAI 模型目录已同步" });
        expect(mocks.saveSelection).not.toHaveBeenCalled();
        expect(mocks.auditAction).toHaveBeenCalledWith(expect.any(Request), user, "admin.geminiai.models.sync", { type: "geminiai_model_catalog" }, { discoveredCount: 2 });
    });

    it("saves only the explicit multi-select list through PUT", async () => {
        const selected = ["gemini-2.5-pro", "gemini-2.5-flash-image"];
        const response = (await PUT(request({ models: selected })))!;

        const payload = await response.json();
        expect(payload).toMatchObject({ code: 0, data: { channel: { id: "geminiai", models: selected } } });
        expect(payload.data.models).toEqual(expect.arrayContaining([expect.objectContaining({ id: "gemini-2.5-pro", enabled: true })]));
        expect(mocks.saveSelection).toHaveBeenCalledWith({ models: selected });
        expect(mocks.auditAction).toHaveBeenCalledWith(expect.any(Request), user, "admin.geminiai.models.update", { type: "system_model_channel", id: "geminiai", label: "Gemini AI Studio" }, { modelCount: 2 });
    });
});
