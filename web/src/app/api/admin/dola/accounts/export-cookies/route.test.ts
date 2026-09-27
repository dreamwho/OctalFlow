import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ requireAdmin: vi.fn(), audit: vi.fn(), auditFailure: vi.fn(), routeError: vi.fn(), exportCookies: vi.fn() }));
vi.mock("@/lib/server/dola/admin", () => ({ requireDolaAdmin: mocks.requireAdmin, auditDolaAdminAction: mocks.audit, auditDolaAdminFailure: mocks.auditFailure, dolaRouteError: mocks.routeError }));
vi.mock("@/lib/server/dola/account-service", () => ({ exportDolaGoogleAccountCookies: mocks.exportCookies }));

import { POST } from "./route";

describe("Dola Google Cookie TXT export", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.requireAdmin.mockResolvedValue({ user: { id: "admin-one" } });
        mocks.exportCookies.mockResolvedValue(["session=one; uid=1", "session=two; uid=2"]);
    });

    it("requires administrator access before reading credentials", async () => {
        mocks.requireAdmin.mockResolvedValue({ error: new Response("forbidden", { status: 403 }) });
        const response = (await POST(new Request("http://localhost/api/admin/dola/accounts/export-cookies", { method: "POST", body: "{}" })))!;
        expect(response.status).toBe(403);
        expect(mocks.exportCookies).not.toHaveBeenCalled();
    });

    it("returns importable one-cookie-per-line UTF-8 text without caching or auditing secrets", async () => {
        const request = new Request("http://localhost/api/admin/dola/accounts/export-cookies", { method: "POST", body: JSON.stringify({ accountIds: ["google-one", "google-two"] }) });
        const response = (await POST(request))!;
        expect(response.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
        expect(response.headers.get("Cache-Control")).toContain("no-store");
        expect(response.headers.get("Content-Disposition")).toMatch(/\.txt"$/);
        expect(await response.text()).toBe("session=one; uid=1\nsession=two; uid=2\n");
        expect(mocks.exportCookies).toHaveBeenCalledWith(["google-one", "google-two"]);
        expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain("session=one");
    });
});
