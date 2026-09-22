import { createHash, randomUUID } from "node:crypto";
import { open, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { attachCloudStorageReference, CloudStorageError, completeCloudStorageReservation, releaseCloudStorageReservation, reserveCloudStorage, type CloudProjectBackup, type CloudStorageSource } from "@/lib/server/cloud-storage-service";
import { deleteObject, getObjectDigest, objectExists, putObjectFile } from "@/lib/server/object-storage-client";
import { assertObjectStorageConfigured, getObjectStorageRuntimeConfig } from "@/lib/server/object-storage-config";

export async function uploadCloudStorageObject(input: {
    userId: string;
    source: CloudStorageSource;
    bytes: number;
    checksumSha256: string;
    contentType: string;
    body: ReadableStream<Uint8Array>;
    backup?: CloudProjectBackup;
}) {
    const config = await getObjectStorageRuntimeConfig();
    if (!config.enabled) throw new CloudStorageError("云端 OSS 尚未启用", 503);
    assertObjectStorageConfigured(config);
    if (!input.body) throw new CloudStorageError("上传文件为空", 400);
    if (!Number.isSafeInteger(input.bytes) || input.bytes < 1) throw new CloudStorageError("文件大小无效", 400);
    const contentType = input.contentType.trim().slice(0, 255) || "application/octet-stream";
    const objectKey = `cloud/users/${input.userId}/${randomUUID()}`;
    const reservationId = randomUUID();
    const reservation = await reserveCloudStorage({
        userId: input.userId, reservationId, objectKey, bytes: input.bytes,
        checksumSha256: input.checksumSha256, source: input.source,
        expiresAt: new Date(Date.now() + 60 * 60_000),
    });
    if (reservation.status === "stored") {
        if (!await objectExists(config, reservation.objectKey)) throw new CloudStorageError("云端文件索引与 OSS 不一致，请联系管理员修复", 409);
        await attachCloudStorageReference({ userId: input.userId, referenceId: reservation.referenceId, objectKey: reservation.objectKey,
            bytes: input.bytes, checksumSha256: input.checksumSha256, source: input.source, backup: input.backup });
        return { referenceId: reservation.referenceId, bytes: input.bytes, deduplicated: true, downloadPath: downloadPath(reservation.referenceId) };
    }

    let directory: string;
    try { directory = await mkdtemp(join(tmpdir(), "dreamyo-cloud-")); }
    catch (error) {
        await releaseCloudStorageReservation(input.userId, reservation.reservationId).catch(() => undefined);
        throw error;
    }
    const filePath = join(directory, "upload");
    let uploaded = false;
    try {
        const file = await open(filePath, "wx", 0o600);
        let actualBytes = 0;
        const digest = createHash("sha256");
        try {
            const reader = input.body.getReader();
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                actualBytes += value.byteLength;
                if (actualBytes > input.bytes) {
                    await reader.cancel();
                    throw new CloudStorageError("上传内容超过声明大小", 400);
                }
                digest.update(value);
                await file.writeFile(value);
            }
        } finally { await file.close(); }
        if (actualBytes !== input.bytes || digest.digest("hex") !== input.checksumSha256.toLowerCase()) throw new CloudStorageError("上传文件大小或 SHA-256 与声明不一致", 400);
        uploaded = true;
        await putObjectFile(config, { key: reservation.objectKey, filePath, bytes: actualBytes, contentType });
        const verified = await getObjectDigest(config, reservation.objectKey);
        const completed = await completeCloudStorageReservation({
            userId: input.userId, reservationId: reservation.reservationId,
            verifiedBytes: verified.bytes, verifiedChecksumSha256: verified.checksumSha256,
            backup: input.backup,
        });
        return { referenceId: completed.referenceId, bytes: verified.bytes, deduplicated: false, downloadPath: downloadPath(completed.referenceId) };
    } catch (error) {
        if (uploaded) await deleteObject(config, reservation.objectKey).catch(() => undefined);
        await releaseCloudStorageReservation(input.userId, reservation.reservationId).catch(() => undefined);
        throw error;
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

function downloadPath(referenceId: string) {
    return `/api/cloud-storage/objects/${referenceId}`;
}
