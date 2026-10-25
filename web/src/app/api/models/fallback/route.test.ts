import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ user: vi.fn(), settings: vi.fn(), offer: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getCurrentUser: mocks.user }));
vi.mock("@/lib/auth/store", () => ({ getFreshAuthSettings: mocks.settings }));
vi.mock("@/lib/server/model-fallback", () => ({ configuredModelFallback: mocks.offer }));
import { GET } from "./route";

describe("model fallback offer route", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.user.mockResolvedValue({ id: "user", role: "custom" });
        mocks.settings.mockResolvedValue({ version: "fresh" });
        mocks.offer.mockReturnValue({ id: "backup", name: "备用模型", sourceName: "主模型" });
    });

    it("uses the current role and fresh authoritative settings with no-store", async () => {
        const response = await GET(new Request("http://localhost/api/models/fallback?model=primary&capability=image"));
        expect(await response.json()).toEqual({ code: 0, data: { id: "backup", name: "备用模型", sourceName: "主模型" }, msg: "" });
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(mocks.offer).toHaveBeenCalledWith({ version: "fresh" }, "custom", "primary", "image");
        expect(mocks.settings).toHaveBeenCalledOnce();
    });

    it("does not expose configuration to unauthenticated callers", async () => {
        mocks.user.mockResolvedValue(null);
        expect((await GET(new Request("http://localhost/api/models/fallback?model=primary&capability=image"))).status).toBe(401);
        expect(mocks.settings).not.toHaveBeenCalled();
    });

    it("rejects unsupported capabilities and returns no target when unavailable", async () => {
        expect((await GET(new Request("http://localhost/api/models/fallback?model=primary&capability=text"))).status).toBe(400);
        mocks.offer.mockReturnValue(null);
        const response = await GET(new Request("http://localhost/api/models/fallback?model=primary&capability=video"));
        expect(await response.json()).toEqual({ code: 0, data: null, msg: "" });
    });
});
