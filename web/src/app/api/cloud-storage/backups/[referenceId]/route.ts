import { NextResponse } from "next/server";

import { getCloudStorageUserId } from "@/lib/server/cloud-storage-user";
import { CloudStorageError, deleteCloudStorageReference, getCloudProjectBackup } from "@/lib/server/cloud-storage-service";
import { deleteObject, streamObjectBytes } from "@/lib/server/object-storage-client";
import { assertObjectStorageConfigured, getObjectStorageRuntimeConfig } from "@/lib/server/object-storage-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ referenceId: string }> };

export async function GET(request: Request, context: Context) {
    const userId = await getCloudStorageUserId(request);
    if (!userId) return NextResponse.json({ code: 401, data: null, msg: "请先登录" }, { status: 401 });
    try {
        const { referenceId } = await context.params;
        const backup = await getCloudProjectBackup(userId, referenceId);
        const config = await getObjectStorageRuntimeConfig();
        assertObjectStorageConfigured(config);
        const body = await streamObjectBytes(config, backup.objectKey);
        return new Response(body, { headers: { "Content-Type": "application/zip", "Cache-Control": "private, no-store", "X-Dreamyo-SHA256": backup.checksumSha256 } });
    } catch (error) {
        if (error instanceof CloudStorageError) return NextResponse.json({ code: error.status, data: null, msg: error.message }, { status: error.status });
        console.error("Cloud backup download failed", error);
        return NextResponse.json({ code: 502, data: null, msg: "下载云端备份失败" }, { status: 502 });
    }
}

export async function DELETE(request: Request, context: Context) {
    const userId = await getCloudStorageUserId(request);
    if (!userId) return NextResponse.json({ code: 401, data: null, msg: "请先登录" }, { status: 401 });
    try {
        const { referenceId } = await context.params;
        await getCloudProjectBackup(userId, referenceId);
        const config = await getObjectStorageRuntimeConfig();
        assertObjectStorageConfigured(config);
        const result = await deleteCloudStorageReference(userId, referenceId, (objectKey) => deleteObject(config, objectKey));
        return NextResponse.json({ code: 0, data: result, msg: "备份已删除" }, { headers: { "Cache-Control": "private, no-store" } });
    } catch (error) {
        if (error instanceof CloudStorageError) return NextResponse.json({ code: error.status, data: null, msg: error.message }, { status: error.status });
        console.error("Cloud backup deletion failed", error);
        return NextResponse.json({ code: 502, data: null, msg: "删除云端备份失败" }, { status: 502 });
    }
}
