import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ edition: vi.fn(), trustedMain: vi.fn(), restore: vi.fn(), setCookie: vi.fn() }));
vi.mock("@/lib/server/desktop-runtime", () => ({ getDesktopEdition: mocks.edition, isTrustedDesktopMainRequest: mocks.trustedMain }));
vi.mock("@/lib/server/desktop-cloud-user", () => ({ restoreDesktopCloudUser: mocks.restore }));
vi.mock("@/lib/auth/session", () => ({ setSessionCookie: mocks.setCookie }));

import { POST } from "./route";

const request = () => new Request("http://127.0.0.1:3333/api/desktop/cloud-offline-bootstrap", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cloudUserId: "cloud-user-1234567890" }) });

describe("commercial offline local project restore", () => {
    beforeEach(() => {
        mocks.edition.mockReset().mockReturnValue("commercial");
        mocks.trustedMain.mockReset().mockReturnValue(true);
        mocks.restore.mockReset().mockResolvedValue({ localUserId: "local-1", cloudUserId: "cloud-user-1234567890", sessionValue: "session" });
        mocks.setCookie.mockReset();
    });

    it("requires the Main-only token before reading a local identity", async () => {
        mocks.trustedMain.mockReturnValue(false);
        expect((await POST(request())).status).toBe(403);
        expect(mocks.restore).not.toHaveBeenCalled();
    });

    it("issues only a local session for a previously verified identity", async () => {
        const response = await POST(request());
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ data: { offline: true, localUserId: "local-1" } });
        expect(mocks.setCookie).toHaveBeenCalledWith(response, "session", expect.any(Request));
    });

    it("refuses an identity with no local binding", async () => {
        mocks.restore.mockRejectedValue(new Error("此云端账号尚未在本机完成过在线登录"));
        expect((await POST(request())).status).toBe(403);
        expect(mocks.setCookie).not.toHaveBeenCalled();
    });
});
