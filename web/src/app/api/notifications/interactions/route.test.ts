import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({ getCurrentUser: vi.fn(), getDatabaseProvider: vi.fn(), listUserNotifications: vi.fn() }));

vi.mock("@/lib/auth/session", () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock("@/lib/server/database", () => ({ getDatabaseProvider: mocks.getDatabaseProvider }));
vi.mock("@/lib/server/work-community-service", () => ({ listUserNotifications: mocks.listUserNotifications }));

import { GET } from "./route";

describe("GET /api/notifications/interactions", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getCurrentUser.mockResolvedValue({ id: "user-one" });
        mocks.getDatabaseProvider.mockReturnValue("file");
    });

    it("returns an empty notification list for the file Provider instead of a community-service conflict", async () => {
        const response = await GET(new NextRequest("http://localhost/api/notifications/interactions?limit=20"));

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ code: 0, data: { items: [], unreadCount: 0 }, msg: "互动通知未启用" });
        expect(mocks.listUserNotifications).not.toHaveBeenCalled();
    });

    it("uses the community service when PostgreSQL is enabled", async () => {
        mocks.getDatabaseProvider.mockReturnValue("postgres");
        mocks.listUserNotifications.mockResolvedValue({ items: [], unreadCount: 2 });

        const response = await GET(new NextRequest("http://localhost/api/notifications/interactions?limit=8&cursor=next"));

        expect(response.status).toBe(200);
        expect(mocks.listUserNotifications).toHaveBeenCalledWith("user-one", { limit: 8, cursor: "next" });
    });
});
