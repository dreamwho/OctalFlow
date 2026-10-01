import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ access: vi.fn(), runtime: vi.fn() }));
vi.mock("@/lib/server/dola/admin", () => ({ requireDolaAdmin: mocks.access, dolaRouteError: (error: Error) => Response.json({ code: 1, msg: error.message }, { status: 400 }) }));
vi.mock("@/lib/server/dola/provider", () => ({ dolaRuntimeRequest: mocks.runtime }));
import { GET } from "./route";
describe("Dola traffic range", () => {
    beforeEach(() => { vi.resetAllMocks(); mocks.access.mockResolvedValue({ user: { id: "admin" } }); });
    it("requires admin access before contacting provider", async () => {
        mocks.access.mockResolvedValue({ error: new Response(null, { status: 403 }) });
        expect((await GET(new Request("http://localhost/api/admin/dola/traffic"))).status).toBe(403);
        expect(mocks.runtime).not.toHaveBeenCalled();
    });
    it.each(["start=bad&end=bad", "start=2026-10-02T00:00:00Z&end=2026-10-01T00:00:00Z", "start=2026-10-01T00:00:00&end=2026-10-02T00:00:00", "start=2026-10-01T00:00:00Z&end=2026-10-02T00:00:00Z&port=-1"])("rejects invalid filters: %s", async (query) => {
        expect((await GET(new Request(`http://localhost/api/admin/dola/traffic?${query}`))).status).toBe(400);
        expect(mocks.runtime).not.toHaveBeenCalled();
    });
    it("passes range and port without loading request logs", async () => {
        mocks.runtime.mockResolvedValue(Response.json({ totalBytes: 123, items: [] }));
        const response = await GET(new Request("http://localhost/api/admin/dola/traffic?start=2026-10-01T00:00:00Z&end=2026-10-02T00:00:00Z&port=17894"));
        expect((await response.json()).data.totalBytes).toBe(123);
        const params = new URL(mocks.runtime.mock.calls[0][0], "http://localhost").searchParams;
        expect(params.get("port")).toBe("17894");
        expect(params.get("start")).toBe("2026-10-01T00:00:00Z");
    });
});
