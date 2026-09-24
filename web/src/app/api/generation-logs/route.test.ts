import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    DraftError: class GenerationLogDraftValidationError extends Error {},
    OwnershipError: class GenerationLogOwnershipError extends Error {},
    currentUser: vi.fn(),
    readJsonBody: vi.fn(),
    recordDraft: vi.fn(),
    rename: vi.fn(),
    deleteResults: vi.fn(),
    failDraftSlot: vi.fn(),
    taskByRequest: vi.fn(),
    taskRecord: vi.fn(),
    listLogs: vi.fn(),
    getSettings: vi.fn(),
}));

vi.mock("@/lib/auth/request", () => ({ readJsonBody: mocks.readJsonBody }));
vi.mock("@/lib/auth/session", () => ({ getCurrentUser: mocks.currentUser }));
vi.mock("@/lib/auth/store", () => ({ getAuthSettings: mocks.getSettings }));
vi.mock("@/lib/server/generation-log-store", () => ({
    deleteGenerationLogs: vi.fn(),
    listGenerationLogs: mocks.listLogs,
    listUserGenerationLogsForDelete: vi.fn(),
}));
vi.mock("@/lib/server/generation-log-task-service", () => ({
    GenerationLogDraftValidationError: mocks.DraftError,
    GenerationLogOwnershipError: mocks.OwnershipError,
    deleteGenerationLogResultsForUser: mocks.deleteResults,
    failGenerationLogDraftSlotForUser: mocks.failDraftSlot,
    recordGenerationLogDraft: mocks.recordDraft,
    renameGenerationLogForUser: mocks.rename,
}));
vi.mock("@/lib/server/generation-task-store", () => ({ getStoredGenerationTaskByRequest: mocks.taskByRequest, getStoredGenerationTaskRecord: mocks.taskRecord }));

import { GET, PATCH, POST } from "./route";

describe("generation log browser write boundary", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.currentUser.mockResolvedValue({ id: "user-one", username: "user", displayName: "User" });
        mocks.getSettings.mockResolvedValue({ generationDefaults: { imageMaxCount: 8 } });
    });

    it("rejects browser-submitted terminal status and result URLs", async () => {
        mocks.readJsonBody.mockResolvedValue({
            id: "video-workbench:log-one",
            kind: "video",
            source: "video-workbench",
            status: "success",
            assets: [{ type: "video", url: "https://attacker.example/result.mp4" }],
        });

        const response = await POST(new Request("http://localhost/api/generation-logs", { method: "POST" }));

        expect(response.status).toBe(403);
        expect(mocks.recordDraft).not.toHaveBeenCalled();
    });

    it("accepts only a pending workbench request slot", async () => {
        const body = {
            id: "image-workbench:log-one",
            kind: "image",
            source: "image-workbench",
            status: "pending",
            requestSnapshot: { version: 1, parameters: {}, references: [], slots: [{ id: "slot-one", index: 0, status: "pending", clientRequestId: "request-one" }] },
        };
        mocks.readJsonBody.mockResolvedValue(body);
        mocks.recordDraft.mockResolvedValue({ ...body, userId: "user-one", assets: [] });

        const response = await POST(new Request("http://localhost/api/generation-logs", { method: "POST" }));

        expect(response.status).toBe(200);
        expect(mocks.recordDraft).toHaveBeenCalledWith(expect.objectContaining({ ...body, userId: "user-one", username: "user", displayName: "User" }));
    });

    it("rejects an empty pending draft", async () => {
        mocks.readJsonBody.mockResolvedValue({ id: "image-workbench:empty", kind: "image", source: "image-workbench", status: "pending", requestSnapshot: { version: 1, parameters: {}, references: [], slots: [] } });
        mocks.recordDraft.mockRejectedValueOnce(new mocks.DraftError("生成记录必须包含待处理请求槽"));

        const response = await POST(new Request("http://localhost/api/generation-logs", { method: "POST" }));

        expect(response.status).toBe(400);
    });

    it("rejects image batches above the administrator limit", async () => {
        mocks.getSettings.mockResolvedValue({ generationDefaults: { imageMaxCount: 2 } });
        mocks.readJsonBody.mockResolvedValue({ id: "image-workbench:too-many", kind: "image", source: "image-workbench", status: "pending", count: 3, requestSnapshot: { slots: [{}, {}, {}] } });
        const response = await POST(new Request("http://localhost/api/generation-logs", { method: "POST" }));
        expect(response.status).toBe(400);
        expect(mocks.recordDraft).not.toHaveBeenCalled();
    });

    it("routes rename and result deletion through explicit owned actions", async () => {
        mocks.readJsonBody.mockResolvedValueOnce({ action: "rename", id: "image-workbench:log-one", title: "新标题" });
        mocks.rename.mockResolvedValue({ id: "image-workbench:log-one", title: "新标题" });
        const renamed = await PATCH(new Request("http://localhost/api/generation-logs", { method: "PATCH" }));

        mocks.readJsonBody.mockResolvedValueOnce({ action: "delete-results", id: "image-workbench:log-one", slotIds: ["slot-one"] });
        mocks.deleteResults.mockResolvedValue({ id: "image-workbench:log-one", assets: [] });
        const deleted = await PATCH(new Request("http://localhost/api/generation-logs", { method: "PATCH" }));

        mocks.readJsonBody.mockResolvedValueOnce({ action: "fail-draft-slot", id: "image-workbench:log-one", slotId: "slot-one", clientRequestId: "request-one", error: "渠道忙碌" });
        mocks.failDraftSlot.mockResolvedValue({ id: "image-workbench:log-one" });
        const failed = await PATCH(new Request("http://localhost/api/generation-logs", { method: "PATCH" }));

        expect(renamed.status).toBe(200);
        expect(deleted.status).toBe(200);
        expect(failed.status).toBe(200);
        expect(mocks.rename).toHaveBeenCalledWith("user-one", "image-workbench:log-one", "新标题");
        expect(mocks.deleteResults).toHaveBeenCalledWith("user-one", "image-workbench:log-one", ["slot-one"]);
        expect(mocks.failDraftSlot).toHaveBeenCalledWith("user-one", "image-workbench:log-one", "slot-one", "request-one", "渠道忙碌");
    });

    it("hides generation records owned by another user", async () => {
        mocks.readJsonBody.mockResolvedValueOnce({ action: "rename", id: "image-workbench:other-user", title: "新标题" });
        mocks.rename.mockRejectedValueOnce(new mocks.OwnershipError());

        const response = await PATCH(new Request("http://localhost/api/generation-logs", { method: "PATCH" }));

        expect(response.status).toBe(404);
        await expect(response.json()).resolves.toEqual({ error: "生成记录不存在" });
    });

    it("shows a pending result as requiring review when the persisted task has an uncertain submission", async () => {
        mocks.listLogs.mockResolvedValue({ items: [{ id: "image-workbench:one", kind: "image", requestSnapshot: { version: 1, parameters: {}, references: [], slots: [{ id: "slot-one", index: 0, status: "pending", clientRequestId: "request-one" }] } }] });
        mocks.taskByRequest.mockResolvedValue({ id: "task-one" });
        mocks.taskRecord.mockResolvedValue({ executionPhase: "needs_review", reviewReason: "响应已返回，结果未落盘" });

        const response = await GET(new Request("http://localhost/api/generation-logs?source=image-workbench"));
        const payload = await response.json();

        expect(payload.items[0].requestSnapshot.slots[0]).toMatchObject({ status: "pending", needsReview: true, reviewReason: "响应已返回，结果未落盘" });
        expect(mocks.taskByRequest).toHaveBeenCalledWith("image", "user-one", "request-one");
    });

    it.each([
        [null, null, "preparing"],
        [{ id: "task-one" }, { executionPhase: "created" }, "queued"],
        [{ id: "task-one" }, { executionPhase: "polling" }, "running"],
    ])("derives a public pending phase from task state %#", async (task, schedule, displayPhase) => {
        mocks.listLogs.mockResolvedValue({ items: [{ id: "video-workbench:one", kind: "video", requestSnapshot: { version: 1, parameters: {}, references: [], slots: [{ id: "slot-one", index: 0, status: "pending", clientRequestId: "request-one" }] } }] });
        mocks.taskByRequest.mockResolvedValue(task);
        mocks.taskRecord.mockResolvedValue(schedule);
        const response = await GET(new Request("http://localhost/api/generation-logs?source=video-workbench"));
        const payload = await response.json();
        expect(payload.items[0].requestSnapshot.slots[0].displayPhase).toBe(displayPhase);
    });
});
