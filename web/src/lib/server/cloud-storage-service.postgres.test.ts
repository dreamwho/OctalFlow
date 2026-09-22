import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createPostgresRepositories, ensurePostgresSchema, postgresQuery } from "@/lib/server/database";

import { attachCloudStorageReference, CloudStorageError, completeCloudStorageReservation, deleteCloudStorageReference, getCloudProjectBackup, getCloudStorageObject, getCloudStorageUsage, listCloudProjectBackups, reserveCloudStorage } from "./cloud-storage-service";

const postgresIt = process.env.DREAMYO_RUN_POSTGRES_INTEGRATION === "1" ? it : it.skip;

describe("cloud storage PostgreSQL capacity", () => {
    postgresIt("serializes concurrent reservations and counts only committed OSS bytes", async () => {
        await ensurePostgresSchema();
        const repositories = createPostgresRepositories();
        const settings = await repositories.settings.getSettings();
        const planId = settings.settings?.defaultPlanId || settings.plans[0]?.id;
        if (!planId) throw new Error("No entitlement plan for cloud storage test");
        const suffix = randomUUID();
        const userId = `cloud-test-${suffix}`;
        const now = new Date().toISOString();
        const reservationIds = [randomUUID(), randomUUID()];
        const objectIds = [randomUUID(), randomUUID()];
        try {
            await repositories.users.createWithNextAccountId({
                id: userId,
                username: `cloud_${suffix.replaceAll("-", "").slice(0, 16)}`,
                displayName: "云存储并发测试",
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
            await postgresQuery("UPDATE cloud_storage_accounts SET base_bytes = 1000 WHERE user_id = $1", [userId]);
            const attempts = await Promise.allSettled(reservationIds.map((reservationId, index) => reserveCloudStorage({
                userId,
                reservationId,
                objectKey: `cloud/users/${userId}/${objectIds[index]}`,
                bytes: 700,
                checksumSha256: (index ? "b" : "a").repeat(64),
                source: "asset",
                expiresAt: new Date(Date.now() + 600_000),
            })));
            expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
            const failed = attempts.find((attempt) => attempt.status === "rejected");
            expect(failed?.status === "rejected" && failed.reason).toBeInstanceOf(CloudStorageError);
            expect(failed?.status === "rejected" && failed.reason.status).toBe(409);
            const winner = attempts.findIndex((attempt) => attempt.status === "fulfilled");
            expect(await getCloudStorageUsage(userId)).toMatchObject({ baseBytes: 1000, usedBytes: 0, reservedBytes: 700, availableBytes: 300 });
            const completed = await completeCloudStorageReservation({
                userId,
                reservationId: reservationIds[winner],
                verifiedBytes: 650,
                verifiedChecksumSha256: (winner ? "b" : "a").repeat(64),
            });
            expect(completed.bytes).toBe(650);
            expect(await getCloudStorageUsage(userId)).toMatchObject({ usedBytes: 650, reservedBytes: 0, availableBytes: 350 });
            expect(await getCloudStorageObject(userId, reservationIds[winner])).toMatchObject({ bytes: 650, source: "asset" });
            await expect(getCloudStorageObject("another-user", reservationIds[winner])).rejects.toMatchObject({ status: 404 });
            const duplicateId = randomUUID();
            const duplicate = await reserveCloudStorage({ userId, reservationId: duplicateId,
                objectKey: `cloud/users/${userId}/${randomUUID()}`, bytes: 650, checksumSha256: (winner ? "b" : "a").repeat(64),
                source: "backup", expiresAt: new Date(Date.now() + 600_000) });
            expect(duplicate.status).toBe("stored");
            if (duplicate.status !== "stored") throw new Error("Expected the uploaded object to be deduplicated");
            await attachCloudStorageReference({ userId, referenceId: duplicateId, objectKey: duplicate.objectKey,
                bytes: 650, checksumSha256: (winner ? "b" : "a").repeat(64), source: "backup", backup: { projectId: "canvas-one", title: "云端画布" } });
            expect(await listCloudProjectBackups(userId, 1, 20)).toMatchObject({ total: 1, items: [{ referenceId: duplicateId, projectId: "canvas-one", title: "云端画布" }] });
            expect(await getCloudProjectBackup(userId, duplicateId)).toMatchObject({ referenceId: duplicateId, projectId: "canvas-one" });
            await expect(getCloudProjectBackup("another-user", duplicateId)).rejects.toMatchObject({ status: 404 });
            expect(await getCloudStorageUsage(userId)).toMatchObject({ usedBytes: 650, reservedBytes: 0 });
            const deleted: string[] = [];
            const removeObject = async (key: string) => { deleted.push(key); };
            expect(await deleteCloudStorageReference(userId, reservationIds[winner], removeObject)).toMatchObject({ objectDeleted: false });
            expect(deleted).toHaveLength(0);
            expect(await getCloudStorageObject(userId, duplicateId)).toMatchObject({ source: "backup" });
            expect(await getCloudStorageUsage(userId)).toMatchObject({ usedBytes: 650, bySource: { backup: 650 } });
            expect(await deleteCloudStorageReference(userId, duplicateId, removeObject)).toMatchObject({ objectDeleted: true });
            expect(await listCloudProjectBackups(userId, 1, 20)).toMatchObject({ total: 0, items: [] });
            expect(deleted).toEqual([duplicate.objectKey]);
            expect(await getCloudStorageUsage(userId)).toMatchObject({ usedBytes: 0, availableBytes: 1000 });
        } finally {
            await repositories.users.delete(userId);
        }
    });
});
