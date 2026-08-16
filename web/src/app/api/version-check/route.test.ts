import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = { fetchSafeOutbound: vi.fn() };

vi.mock("@/lib/server/safe-outbound-fetch", () => ({ fetchSafeOutbound: mocks.fetchSafeOutbound }));

const loadRoute = async () => import("./route");

describe("version check route", () => {
    beforeEach(() => {
        vi.resetModules();
        mocks.fetchSafeOutbound.mockReset();
    });

    it("returns the upstream version and changelog when available", async () => {
        mocks.fetchSafeOutbound.mockImplementation(async (url: string) => new Response(url.endsWith("/VERSION") ? " 0.0.7 \n" : "# Changelog", { status: 200 }));

        const response = await (await loadRoute()).GET();
        const payload = await response.json();

        expect(payload.code).toBe(0);
        expect(payload.data).toEqual({ available: true, version: "0.0.7", changelog: "# Changelog" });
    });

    it("degrades to unavailable without failing when the repository rejects anonymous reads", async () => {
        mocks.fetchSafeOutbound.mockResolvedValue(new Response("Not Found", { status: 404 }));

        const response = await (await loadRoute()).GET();
        const payload = await response.json();

        expect(response.status).toBe(200);
        expect(payload.code).toBe(0);
        expect(payload.data).toEqual({ available: false });
    });

    it("degrades to unavailable when the outbound fetch throws", async () => {
        mocks.fetchSafeOutbound.mockRejectedValue(new Error("出站地址不允许访问"));

        const response = await (await loadRoute()).GET();
        const payload = await response.json();

        expect(response.status).toBe(200);
        expect(payload.data).toEqual({ available: false });
    });
});
