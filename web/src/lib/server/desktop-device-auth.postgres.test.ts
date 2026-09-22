import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createPostgresRepositories, ensurePostgresSchema } from "@/lib/server/database";

import { approveDesktopDeviceAuthorization, exchangeDesktopDeviceCode, getDesktopDeviceSessionUserId, refreshDesktopDeviceSession, revokeDesktopDeviceSession, startDesktopDeviceAuthorization } from "./desktop-device-auth";

const postgresIt = process.env.DREAMYO_RUN_POSTGRES_INTEGRATION === "1" ? it : it.skip;

describe("desktop device authorization PostgreSQL round trip", () => {
    postgresIt("pairs once, rotates credentials and revokes the device", async () => {
        await ensurePostgresSchema();
        const repos = createPostgresRepositories();
        const settings = await repos.settings.getSettings();
        const planId = settings.settings?.defaultPlanId || settings.plans[0]?.id;
        if (!planId) throw new Error("No entitlement plan for desktop device test");
        const suffix = randomUUID();
        const userId = `device-test-${suffix}`;
        const now = new Date().toISOString();
        try {
            await repos.users.createWithNextAccountId({
                id: userId,
                username: `device_${suffix.replaceAll("-", "").slice(0, 16)}`,
                displayName: "设备登录测试",
                bio: "",
                role: "user",
                adminPermissions: [],
                status: "active",
                planId,
                pointsBalance: 0,
                passwordHash: "integration-test-only",
                createdAt: now,
                updatedAt: now,
            });
            const started = await startDesktopDeviceAuthorization("Dreamyo test device");
            expect(await exchangeDesktopDeviceCode(started.deviceCode)).toEqual({ status: "pending" });
            await approveDesktopDeviceAuthorization(started.userCode, userId);
            const result = await exchangeDesktopDeviceCode(started.deviceCode);
            expect(result.status).toBe("authorized");
            if (result.status !== "authorized") throw new Error("Device was not authorized");
            expect(await getDesktopDeviceSessionUserId(result.accessToken)).toBe(userId);
            await expect(exchangeDesktopDeviceCode(started.deviceCode)).rejects.toMatchObject({ status: 409 });
            const rotated = await refreshDesktopDeviceSession(result.refreshToken);
            await expect(getDesktopDeviceSessionUserId(result.accessToken)).rejects.toMatchObject({ status: 401 });
            expect(await getDesktopDeviceSessionUserId(rotated.accessToken)).toBe(userId);
            await revokeDesktopDeviceSession(rotated.refreshToken);
            await expect(getDesktopDeviceSessionUserId(rotated.accessToken)).rejects.toMatchObject({ status: 401 });
        } finally {
            await repos.users.delete(userId);
        }
    });
});
