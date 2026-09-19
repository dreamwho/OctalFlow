import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    currentUser: vi.fn(),
    getTask: vi.fn(),
    getSchedule: vi.fn(),
    runtimeRequest: vi.fn(),
    releaseAttempt: vi.fn(),
    openLog: vi.fn(),
    markLog: vi.fn(),
    settleLog: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getCurrentUser: mocks.currentUser }));
vi.mock("@/lib/server/video-task-store", () => ({ getVideoTask: mocks.getTask }));
vi.mock("@/lib/server/generation-task-store", () => ({ getStoredGenerationTaskRecord: mocks.getSchedule }));
vi.mock("@/lib/server/dola/provider", () => ({ dolaRuntimeRequest: mocks.runtimeRequest }));
vi.mock("@/lib/server/dola/account-service", () => ({ releaseDolaAccountAttempt: mocks.releaseAttempt }));
vi.mock("@/lib/server/dola/log-store", () => ({ openDolaRequestLog: mocks.openLog, markDolaRequestLogRunning: mocks.markLog, settleDolaRequestLog: mocks.settleLog }));

import { POST } from "./route";

describe("Dola user verification route", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.currentUser.mockResolvedValue({ id: "user-1", role: "user" });
        mocks.getTask.mockResolvedValue({
            id: "video-task-1",
            userId: "user-1",
            config: { advancedConfig: { protocol: "dola" } },
            upstream: { id: "upstream-task-1", model: "dola-seedance-2-5", accountId: "account-1", proxyMode: "managed", proxyTarget: "node-1" },
        });
        mocks.getSchedule.mockResolvedValue({ resultPayload: { verificationId: "verification-1" } });
        mocks.openLog.mockResolvedValue("dola-log-1");
        mocks.runtimeRequest.mockResolvedValue(new Response(JSON.stringify({ status: "accepted", screenshotBase64: "secret-image" }), { status: 200, headers: { "content-type": "application/json" } }));
    });

    it("records each user verification action without persisting the lease token or screenshot", async () => {
        const request = new Request("http://localhost/api/video-tasks/video-task-1/verification/input", {
            method: "POST",
            headers: { "content-type": "application/json", "user-agent": "test-client/1.0" },
            body: JSON.stringify({ leaseToken: "super-secret-lease-token", action: "down", x: 123, y: 45 }),
        });
        const response = await POST(request, { params: Promise.resolve({ id: "video-task-1", action: "input" }) });

        expect(response.status).toBe(200);
        expect(mocks.openLog).toHaveBeenCalledWith(expect.objectContaining({ source: "runtime", method: "POST", path: "/v1/verifications/verification-1/input", model: "dola-seedance-2-5", accountId: "account-1", taskId: "upstream-task-1", verificationId: "verification-1", proxyEgress: { mode: "generic", nodeName: "node-1" } }));
        const preview = mocks.openLog.mock.calls[0]?.[0]?.requestPreview as string;
        expect(preview).toContain('"inputAction":"down"');
        expect(preview).not.toContain("super-secret-lease-token");
        expect(mocks.markLog).toHaveBeenCalledWith("dola-log-1", expect.objectContaining({ phase: "upstream" }));
        expect(mocks.settleLog).toHaveBeenCalledWith("dola-log-1", expect.objectContaining({ statusCode: 200, phase: "success", responseBytes: expect.any(Number) }));
        const responsePreview = mocks.settleLog.mock.calls[0]?.[1]?.responsePreview as string;
        expect(responsePreview).not.toContain("secret-image");
    });
});
