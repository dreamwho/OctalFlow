import { NextResponse } from "next/server";

import { hasAnyAdminPermission } from "@/lib/admin-permissions";
import { getCurrentUser } from "@/lib/auth/session";
import { CloudStorageError, getCloudStorageUsage } from "@/lib/server/cloud-storage-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ userId: string }> }) {
    const admin = await getCurrentUser();
    if (!admin) return NextResponse.json({ code: 401, data: null, msg: "请先登录" }, { status: 401 });
    if (!hasAnyAdminPermission(admin, ["users.manage", "system.manage"])) {
        return NextResponse.json({ code: 403, data: null, msg: "没有查看用户云存储的权限" }, { status: 403 });
    }
    try {
        const { userId } = await context.params;
        return NextResponse.json({ code: 0, data: await getCloudStorageUsage(userId), msg: "OK" }, { headers: { "Cache-Control": "private, no-store" } });
    } catch (error) {
        if (error instanceof CloudStorageError) return NextResponse.json({ code: error.status, data: null, msg: error.message }, { status: error.status });
        console.error("Admin cloud storage usage failed", error);
        return NextResponse.json({ code: 500, data: null, msg: "用户云存储统计失败" }, { status: 500 });
    }
}
