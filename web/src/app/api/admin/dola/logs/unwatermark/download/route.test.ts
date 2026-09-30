import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ requireAdmin: vi.fn(), getLinks: vi.fn(), fetchSafe: vi.fn() }));
vi.mock("@/lib/server/dola/admin", () => ({ requireDolaAdmin: mocks.requireAdmin }));
vi.mock("@/lib/server/dola/task-video-links", () => ({ getDolaTaskVideoLinks: mocks.getLinks }));
vi.mock("@/lib/server/safe-outbound-fetch", () => ({ fetchSafeOutbound: mocks.fetchSafe }));

import { GET } from "./route";

describe("admin Dola MP4 download", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.requireAdmin.mockResolvedValue({ user: { id: "admin" } });
        mocks.getLinks.mockResolvedValue({ downloadUrl: "https://v16-dola.dola.com/original.mp4" });
        mocks.fetchSafe.mockResolvedValue(new Response("video-bytes", { headers: { "content-type": "video/mp4" } }));
    });

    it("streams a freshly signed video under the task ID filename", async () => {
        const id = "dola-11111111-1111-4111-8111-111111111111";
        const response = await GET(new Request(`http://localhost/api/admin/dola/logs/unwatermark/download?taskId=${id}`));
        expect(response.status).toBe(200);
        expect(response.headers.get("content-disposition")).toBe(`attachment; filename="${id}.mp4"`);
        expect(await response.text()).toBe("video-bytes");
        expect(mocks.getLinks).toHaveBeenCalledWith(id);
    });

    it("rejects an invalid task ID before requesting a signed URL", async () => {
        const response = await GET(new Request("http://localhost/api/admin/dola/logs/unwatermark/download?taskId=../../secret"));
        expect(response.status).toBe(400);
        expect(mocks.getLinks).not.toHaveBeenCalled();
    });
});
