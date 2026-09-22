import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ admin: vi.fn(), request: vi.fn(), openLog: vi.fn(), settleLog: vi.fn(), ready: vi.fn(), refreshCookie: vi.fn() }));
vi.mock("@/lib/server/dola/admin", () => ({ requireDolaAdmin: mocks.admin, dolaRouteError: () => new Response("failure", { status: 502 }) }));
vi.mock("@/lib/server/dola/provider", () => ({ dolaRuntimeRequest: mocks.request }));
vi.mock("@/lib/server/dola/log-store", () => ({ openDolaRequestLog: mocks.openLog, settleDolaRequestLog: mocks.settleLog }));
vi.mock("@/lib/server/dola/account-service", () => ({ markDolaAccountReady: mocks.ready, refreshDolaAccountCookieIfVersion: mocks.refreshCookie, updateDolaAccountCredentials: vi.fn(), updateDolaAccountQuota: vi.fn() }));

import { POST } from "./route";

beforeEach(() => {
    vi.clearAllMocks();
    mocks.admin.mockResolvedValue({ user: { id: "admin" } });
    mocks.openLog.mockResolvedValue("fixture-log");
    mocks.request.mockResolvedValue(new Response(JSON.stringify({ status: "needs_review", screenshotBase64: "png" }), { status: 200, headers: { "content-type": "application/json" } }));
});

it("saves only an authenticated browser Cookie and closes after the account update", async () => {
    const cookie = "sid=refreshed";
    const leaseToken = "private-lease-token-value";
    mocks.request.mockReset()
        .mockResolvedValueOnce(new Response(JSON.stringify({ status: "ready", accountId: "fixture-account", credentialVersion: 2, cookie }), { status: 200, headers: { "content-type": "application/json" } }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ status: "closed" }), { status: 200 }));
    mocks.refreshCookie.mockResolvedValue({ changed: true });
    const response = await POST(new Request("http://localhost/api/admin/dola/verifications/fixture/finalize", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ leaseToken }) }), { params: Promise.resolve({ verificationId: "fixture", action: "finalize" }) });
    expect(await response?.json()).toMatchObject({ code: 0, data: { status: "saved", changed: true, windowClosed: true } });
    expect(mocks.refreshCookie).toHaveBeenCalledWith("fixture-account", cookie, 2);
    expect(mocks.request.mock.calls[1][0]).toMatch(/\/close$/);
    expect(mocks.openLog.mock.calls[0][0].requestPreview).not.toContain(leaseToken);
    expect(mocks.settleLog.mock.calls[0][1].responsePreview).not.toContain(cookie);
});

it("keeps the browser open and the stored Cookie untouched when login is invalid", async () => {
    mocks.request.mockResolvedValue(new Response(JSON.stringify({ status: "needs_login" }), { status: 200 }));
    const response = await POST(new Request("http://localhost/api/admin/dola/verifications/fixture/finalize", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ leaseToken: "private-lease-token-value" }) }), { params: Promise.resolve({ verificationId: "fixture", action: "finalize" }) });
    expect(await response?.json()).toMatchObject({ code: 0, data: { status: "needs_login" } });
    expect(mocks.refreshCookie).not.toHaveBeenCalled();
    expect(mocks.request).toHaveBeenCalledTimes(1);
});

it("forwards typed text to the browser without persisting text or lease in request logs", async () => {
    const leaseToken = "private-lease-token-value";
    const text = "private manual entry";
    const request = new Request("http://localhost/api/admin/dola/verifications/fixture/keyboard", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ leaseToken, text }) });
    const response = await POST(request, { params: Promise.resolve({ verificationId: "fixture", action: "keyboard" }) });
    expect(response?.status).toBe(200);
    expect(JSON.parse(mocks.request.mock.calls[0][1].body)).toEqual({ leaseToken, text });
    const log = mocks.openLog.mock.calls[0][0];
    expect(log.requestPreview).not.toContain(leaseToken);
    expect(log.requestPreview).not.toContain(text);
    expect(mocks.settleLog.mock.calls[0][1].responsePreview).not.toContain("png");
});
