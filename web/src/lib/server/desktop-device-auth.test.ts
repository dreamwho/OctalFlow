import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn(), postgresQuery: vi.fn(), ensureSchema: vi.fn(), edition: vi.fn() }));
vi.mock("@/lib/auth/store", () => ({ sessionMaxAgeSeconds: () => 86_400 }));
vi.mock("@/lib/server/database", () => ({
    ensurePostgresSchema: mocks.ensureSchema,
    getDatabaseProvider: () => "postgres",
    postgresQuery: mocks.postgresQuery,
    withPostgresTransaction: (handler: (db: { query: typeof mocks.query }) => Promise<unknown>) => handler({ query: mocks.query }),
}));
vi.mock("@/lib/server/desktop-runtime", () => ({ getDesktopEdition: mocks.edition }));

import { approveDesktopDeviceAuthorization, DesktopDeviceAuthError, exchangeDesktopDeviceCode, refreshDesktopDeviceSession, startDesktopDeviceAuthorization } from "./desktop-device-auth";

const future = new Date(Date.now() + 600_000);

describe("desktop device authorization", () => {
    beforeEach(() => {
        mocks.query.mockReset().mockResolvedValue({ rows: [], rowCount: 1 });
        mocks.postgresQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 1 });
        mocks.ensureSchema.mockReset().mockResolvedValue(undefined);
        mocks.edition.mockReset().mockReturnValue(null);
    });

    it("stores only the device-code hash and rejects authorization in a desktop runtime", async () => {
        const started = await startDesktopDeviceAuthorization("Dreamyo Mac");
        expect(started.deviceCode).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(started.userCode).toMatch(/^[0-9A-F]{16}$/);
        const parameters = mocks.postgresQuery.mock.calls[0][1];
        expect(parameters[1]).toMatch(/^[a-f0-9]{64}$/);
        expect(parameters).not.toContain(started.deviceCode);
        mocks.edition.mockReturnValue("commercial");
        await expect(startDesktopDeviceAuthorization("Dreamyo Mac")).rejects.toMatchObject({ status: 403 });
    });

    it("requires an active cloud user and consumes an approved code once", async () => {
        mocks.query
            .mockResolvedValueOnce({ rows: [{ id: "request-1", status: "pending", expires_at: future }] })
            .mockResolvedValueOnce({ rows: [{ id: "user-1" }] });
        await expect(approveDesktopDeviceAuthorization("ABCDEF0123456789", "user-1")).resolves.toEqual({ status: "approved" });
        expect(mocks.query.mock.calls.at(-1)?.[0]).toContain("SET status = 'approved'");

        mocks.query.mockReset().mockResolvedValue({ rows: [] });
        mocks.query
            .mockResolvedValueOnce({ rows: [{ id: "request-1", status: "approved", approved_user_id: "user-1", device_label: "Dreamyo Mac", expires_at: future }] })
            .mockResolvedValueOnce({ rows: [{ id: "user-1" }] });
        const exchanged = await exchangeDesktopDeviceCode("d".repeat(43));
        expect(exchanged.status).toBe("authorized");
        if (exchanged.status !== "authorized") throw new Error("expected authorization");
        expect(exchanged.refreshToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(mocks.query.mock.calls[2]?.[1]).not.toContain(exchanged.refreshToken);
        expect(mocks.query.mock.calls.at(-1)?.[0]).toContain("SET status = 'consumed'");

        mocks.query.mockReset().mockResolvedValueOnce({ rows: [{ id: "request-1", status: "consumed", approved_user_id: "user-1", device_label: "Dreamyo Mac", expires_at: future }] });
        await expect(exchangeDesktopDeviceCode("d".repeat(43))).rejects.toMatchObject({ status: 409 });
    });

    it("rotates refresh tokens and rejects disabled users", async () => {
        mocks.query
            .mockResolvedValueOnce({ rows: [{ id: "session-1", user_id: "user-1", refresh_expires_at: future }] })
            .mockResolvedValueOnce({ rows: [{ id: "user-1" }] });
        const rotated = await refreshDesktopDeviceSession("r".repeat(43));
        expect(rotated.userId).toBe("user-1");
        expect(rotated.refreshToken).not.toBe("r".repeat(43));
        expect(mocks.query.mock.calls[2]?.[1]).not.toContain(rotated.refreshToken);

        mocks.query.mockReset().mockResolvedValueOnce({ rows: [{ id: "session-1", user_id: "user-1", refresh_expires_at: future }] }).mockResolvedValueOnce({ rows: [] });
        await expect(refreshDesktopDeviceSession("r".repeat(43))).rejects.toBeInstanceOf(DesktopDeviceAuthError);
    });
});
