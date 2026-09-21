import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    createFirstAdmin: vi.fn(),
    createSession: vi.fn(),
    listPublicUsersPage: vi.fn(),
    setSessionCookie: vi.fn(),
    invalidateInstallStatusCache: vi.fn(),
}));

vi.mock("@/lib/auth/store", () => ({
    createFirstAdmin: mocks.createFirstAdmin,
    createSession: mocks.createSession,
    listPublicUsersPage: mocks.listPublicUsersPage,
}));
vi.mock("@/lib/auth/session", () => ({ setSessionCookie: mocks.setSessionCookie }));
vi.mock("@/lib/server/install-status", () => ({ invalidateInstallStatusCache: mocks.invalidateInstallStatusCache }));

import { GET } from "./route";

const token = "a".repeat(64);

describe("desktop administrator bootstrap", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubEnv("DREAMYO_DESKTOP_EDITION", "admin");
        vi.stubEnv("DREAMYO_DESKTOP_SESSION_TOKEN", token);
        vi.stubEnv("DREAMYO_INSTALL_TOKEN", "i".repeat(64));
        vi.stubEnv("DREAMYO_DESKTOP_ADMIN_PASSWORD", "p".repeat(64));
        vi.stubEnv("DREAMYO_INTERNAL_ORIGIN", "http://127.0.0.1:3333");
        mocks.createSession.mockResolvedValue("session-token");
    });

    it("reuses an active local administrator and redirects with a normal session", async () => {
        mocks.listPublicUsersPage.mockResolvedValue({ users: [{ id: "admin-one", role: "admin", status: "active" }] });
        const request = new Request("http://127.0.0.1:3333/api/desktop/bootstrap?next=/admin", { headers: { "x-dreamyo-desktop-token": token } });

        const response = await GET(request);

        expect(response.status).toBe(303);
        expect(response.headers.get("location")).toBe("http://127.0.0.1:3333/admin");
        expect(mocks.createFirstAdmin).not.toHaveBeenCalled();
        expect(mocks.createSession).toHaveBeenCalledWith("admin-one");
        expect(mocks.setSessionCookie).toHaveBeenCalledWith(response, "session-token", request);
    });

    it("creates the first local administrator only inside the trusted admin runtime", async () => {
        mocks.listPublicUsersPage.mockResolvedValue({ users: [] });
        mocks.createFirstAdmin.mockResolvedValue({ id: "admin-new", role: "admin", status: "active" });

        const response = await GET(new Request("http://localhost:3333/api/desktop/bootstrap", { headers: { "x-dreamyo-desktop-token": token } }));

        expect(response.status).toBe(303);
        expect(mocks.createFirstAdmin).toHaveBeenCalledWith(expect.objectContaining({ username: "desktop_admin", installToken: "i".repeat(64) }));
        expect(mocks.invalidateInstallStatusCache).toHaveBeenCalledTimes(1);
    });

    it("rejects web and invalid-token requests", async () => {
        const response = await GET(new Request("http://127.0.0.1:3333/api/desktop/bootstrap", { headers: { "x-dreamyo-desktop-token": "b".repeat(64) } }));
        expect(response.status).toBe(403);
        expect(mocks.listPublicUsersPage).not.toHaveBeenCalled();
    });
});
