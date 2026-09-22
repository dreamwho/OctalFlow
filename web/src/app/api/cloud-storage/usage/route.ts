import { NextResponse } from "next/server";

import { getCloudStorageUserId } from "@/lib/server/cloud-storage-user";
import { CloudStorageError, getCloudStorageUsage } from "@/lib/server/cloud-storage-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
    const userId = await getCloudStorageUserId(request);
    if (!userId) return NextResponse.json({ code: 401, data: null, msg: "请先登录" }, { status: 401 });
    try {
        return NextResponse.json({ code: 0, data: await getCloudStorageUsage(userId), msg: "OK" }, { headers: { "Cache-Control": "private, no-store" } });
    } catch (error) {
        if (error instanceof CloudStorageError) return NextResponse.json({ code: error.status, data: null, msg: error.message }, { status: error.status });
        console.error("Cloud storage usage failed", error);
        return NextResponse.json({ code: 500, data: null, msg: "查询云存储空间失败" }, { status: 500 });
    }
}
