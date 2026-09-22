import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import { CloudStorageError, deleteCloudStorageReference, getCloudStorageObject } from "@/lib/server/cloud-storage-service";
import { deleteObject, signObjectRead } from "@/lib/server/object-storage-client";
import { assertObjectStorageConfigured, getObjectStorageRuntimeConfig } from "@/lib/server/object-storage-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ objectId: string }> }) {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ code: 401, data: null, msg: "请先登录" }, { status: 401 });
    try {
        const { objectId } = await context.params;
        const object = await getCloudStorageObject(user.id, objectId);
        const config = await getObjectStorageRuntimeConfig();
        assertObjectStorageConfigured(config);
        const url = await signObjectRead(config, { key: object.objectKey, contentDisposition: `attachment; filename="${objectId}"` });
        return NextResponse.json({ code: 0, data: { referenceId: object.referenceId, bytes: object.bytes,
            checksumSha256: object.checksumSha256, source: object.source, url }, msg: "OK" }, { headers: { "Cache-Control": "private, no-store" } });
    } catch (error) {
        if (error instanceof CloudStorageError) return NextResponse.json({ code: error.status, data: null, msg: error.message }, { status: error.status });
        console.error("Cloud storage download failed", error);
        return NextResponse.json({ code: 502, data: null, msg: "云端文件读取失败" }, { status: 502 });
    }
}

export async function DELETE(_request: Request, context: { params: Promise<{ objectId: string }> }) {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ code: 401, data: null, msg: "请先登录" }, { status: 401 });
    try {
        const config = await getObjectStorageRuntimeConfig();
        assertObjectStorageConfigured(config);
        const { objectId } = await context.params;
        const result = await deleteCloudStorageReference(user.id, objectId, (objectKey) => deleteObject(config, objectKey));
        return NextResponse.json({ code: 0, data: result, msg: "已删除" }, { headers: { "Cache-Control": "private, no-store" } });
    } catch (error) {
        if (error instanceof CloudStorageError) return NextResponse.json({ code: error.status, data: null, msg: error.message }, { status: error.status });
        console.error("Cloud storage deletion failed", error);
        return NextResponse.json({ code: 502, data: null, msg: "云端文件删除失败，空间未释放" }, { status: 502 });
    }
}
