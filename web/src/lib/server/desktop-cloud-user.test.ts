import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ edition: vi.fn(), createSession: vi.fn(), mutateAuthDb: vi.fn(), readAuthDb: vi.fn() }));
vi.mock("@/lib/auth/store", () => ({ createSession: mocks.createSession, DEFAULT_ENTITLEMENT_PLAN_ID: "free" }));
vi.mock("@/lib/auth/store-repository", () => ({ mutateAuthDb: mocks.mutateAuthDb, readAuthDb: mocks.readAuthDb }));
vi.mock("@/lib/server/desktop-runtime", () => ({ getDesktopEdition: mocks.edition }));

import { bindDesktopCloudUser, restoreDesktopCloudUser } from "./desktop-cloud-user";

describe("commercial desktop local identity binding", () => {
    beforeEach(() => {
        const db = { users: [] as Array<Record<string, unknown>>, nextUserAccountId: 1 };
        mocks.edition.mockReset().mockReturnValue("commercial");
        mocks.createSession.mockReset().mockResolvedValue("local-session");
        mocks.mutateAuthDb.mockReset().mockImplementation((mutate) => Promise.resolve(mutate(db)));
        mocks.readAuthDb.mockReset().mockResolvedValue(db);
    });

    it("restores only a previously bound local user for offline editing", async () => {
        const identity = { id: "cloud-user-1234567890", username: "dream", displayName: "Dream", status: "active" as const };
        await expect(restoreDesktopCloudUser(identity.id)).rejects.toThrow("尚未");
        const bound = await bindDesktopCloudUser(identity);
        expect(await restoreDesktopCloudUser(identity.id)).toMatchObject({ localUserId: bound.localUserId, sessionValue: "local-session" });
        await expect(restoreDesktopCloudUser("another-cloud-user-0001")).rejects.toThrow("尚未");
    });

    it("creates one local identity for the verified cloud user and reuses it", async () => {
        const identity = { id: "cloud-user-1234567890", username: "dream", displayName: "Dream", status: "active" as const };
        const first = await bindDesktopCloudUser(identity);
        const second = await bindDesktopCloudUser({ ...identity, displayName: "Dream Updated" });
        expect(first.cloudUserId).toBe(identity.id);
        expect(second.localUserId).toBe(first.localUserId);
        expect(mocks.createSession).toHaveBeenCalledTimes(2);
        expect(mocks.mutateAuthDb.mock.calls[0]).toHaveLength(1);
    });

    it("rejects disabled or untrusted runtime identities before writing", async () => {
        mocks.edition.mockReturnValue("admin");
        await expect(bindDesktopCloudUser({ id: "cloud-user-1234567890", username: "dream", displayName: "Dream", status: "active" })).rejects.toThrow();
        mocks.edition.mockReturnValue("commercial");
        await expect(bindDesktopCloudUser({ id: "bad", username: "dream", displayName: "Dream", status: "active" })).rejects.toThrow();
        expect(mocks.mutateAuthDb).not.toHaveBeenCalled();
    });
});
