import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ requireAdmin: vi.fn(), test: vi.fn(), audit: vi.fn() }));
vi.mock("@/lib/server/dola/admin", () => ({ requireDolaAdmin: mocks.requireAdmin, auditDolaAdminAction: mocks.audit, auditDolaAdminFailure: vi.fn(), dolaRouteError: vi.fn() }));
vi.mock("@/lib/server/dola/service", () => ({ testDolaVideo: mocks.test }));
import { POST } from "./route";

beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({ user: { id: "fixture-admin" } });
    mocks.test.mockResolvedValue({ taskId: "fixture-task", status: "submitted" });
});
function request(model: string, references: unknown[]) {
    return new Request("http://localhost/api/admin/dola/test", { method: "POST", body: JSON.stringify({ model, prompt: "固定测试内容", duration: 5, ratio: "16:9", references }) });
}
it.each(["image", "video", "audio"])("preserves uploaded %s references and their actual type", async (type) => {
    const ref = { type, mime: `${type}/fixture`, dataUrl: `data:${type}/fixture;base64,ZmFrZQ==`, name: "fixture", role: "reference" };
    expect((await POST(request("dola-seedance-2-5", [ref])))!.status).toBe(200);
    expect(mocks.test).toHaveBeenCalledWith(expect.objectContaining({ references: [ref] }));
});
it("rejects media for other models and mismatched types before submission", async () => {
    const ref = { type: "audio", dataUrl: "data:audio/mpeg;base64,ZmFrZQ==" };
    expect((await POST(request("dola-seedance-2-0-fast", [ref])))!.status).toBe(400);
    expect((await POST(request("dola-seedance-2-5", [{ ...ref, type: "image" }])))!.status).toBe(400);
    expect(mocks.test).not.toHaveBeenCalled();
});
