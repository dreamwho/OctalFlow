import { NextResponse } from "next/server";

import { getCloudStorageUserId } from "@/lib/server/cloud-storage-user";
import { CloudStorageError, listCloudProjectBackups } from "@/lib/server/cloud-storage-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
    const userId = await getCloudStorageUserId(request);
    if (!userId) return NextResponse.json({ code: 401, data: null, msg: "请先登录" }, { status: 401 });
    try {
        const params = new URL(request.url).searchParams;
        const data = await listCloudProjectBackups(userId, Number(params.get("page") || 1), Number(params.get("pageSize") || 20));
        return NextResponse.json({ code: 0, data, msg: "OK" }, { headers: { "Cache-Control": "private, no-store" } });
    } catch (error) {
        if (error instanceof CloudStorageError) return NextResponse.json({ code: error.status, data: null, msg: error.message }, { status: error.status });
        console.error("Cloud backup listing failed", error);
        return NextResponse.json({ code: 500, data: null, msg: "读取云端备份失败" }, { status: 500 });
    }
}
