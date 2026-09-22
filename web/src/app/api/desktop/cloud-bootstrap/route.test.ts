import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ edition: vi.fn(), trusted: vi.fn(), bind: vi.fn(), setCookie: vi.fn() }));
vi.mock("@/lib/server/desktop-runtime", () => ({ getDesktopEdition: mocks.edition, isTrustedDesktopMainRequest: mocks.trusted }));
vi.mock("@/lib/server/desktop-cloud-user", () => ({ bindDesktopCloudUser: mocks.bind }));
vi.mock("@/lib/auth/session", () => ({ setSessionCookie: mocks.setCookie }));

import { POST } from "./route";

const accessToken = "a".repeat(43);
const makeRequest = () => new Request("http://127.0.0.1:3333/api/desktop/cloud-bootstrap", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accessToken }) });

describe("commercial desktop cloud bootstrap", () => {
    afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
    beforeEach(() => {
        vi.stubEnv("DREAMYO_DESKTOP_CLOUD_ORIGIN", "https://dreamyo.example");
        vi.stubEnv("DREAMYO_DESKTOP_PACKAGED", "1");
        mocks.edition.mockReset().mockReturnValue("commercial");
        mocks.trusted.mockReset().mockReturnValue(true);
        mocks.bind.mockReset().mockResolvedValue({ localUserId: "local-1", cloudUserId: "cloud-1", sessionValue: "local-session" });
        mocks.setCookie.mockReset();
    });

    it("rejects requests outside the trusted commercial loopback runtime", async () => {
        mocks.trusted.mockReturnValue(false);
        expect((await POST(makeRequest())).status).toBe(403);
        expect(mocks.bind).not.toHaveBeenCalled();
    });

    it("binds only a user confirmed by the cloud device token", async () => {
        const fetchMock = vi.fn().mockResolvedValue(Response.json({ code: 0, data: { user: { id: "cloud-1", username: "dream", displayName: "Dream", status: "active" } } }));
        vi.stubGlobal("fetch", fetchMock);
        const response = await POST(makeRequest());
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ data: { cloudUserId: "cloud-1", localUserId: "local-1" } });
        expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ headers: { Authorization: `Bearer ${accessToken}` }, redirect: "error", cache: "no-store" });
        expect(mocks.bind).toHaveBeenCalledWith(expect.objectContaining({ id: "cloud-1", status: "active" }));
        expect(mocks.setCookie).toHaveBeenCalledWith(response, "local-session", expect.any(Request));
    });

    it("does not create a local identity when cloud validation fails", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ code: 401, data: null }, { status: 401 })));
        expect((await POST(makeRequest())).status).toBe(401);
        expect(mocks.bind).not.toHaveBeenCalled();
    });
});
