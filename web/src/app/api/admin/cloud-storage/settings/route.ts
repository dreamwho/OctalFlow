import { NextResponse } from "next/server";

import { hasAdminPermission } from "@/lib/admin-permissions";
import { readJsonBodyResult } from "@/lib/auth/request";
import { getCurrentUser } from "@/lib/auth/session";
import { auditActorFromRequest, safeRecordAuditLog } from "@/lib/server/audit-log-store";
import { CloudStorageError, getCloudStorageSettings, setDefaultCloudStorageBytes } from "@/lib/server/cloud-storage-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
    const denied = await requireAdmin();
    if (denied) return denied;
    try {
        return NextResponse.json({ code: 0, data: await getCloudStorageSettings(), msg: "OK" }, { headers: { "Cache-Control": "private, no-store" } });
    } catch (error) { return storageError(error); }
}

export async function PATCH(request: Request) {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ code: 401, data: null, msg: "请先登录" }, { status: 401 });
    if (!hasAdminPermission(user, "system.manage")) return NextResponse.json({ code: 403, data: null, msg: "没有管理云存储的权限" }, { status: 403 });
    const parsed = await readJsonBodyResult<{ defaultBytes?: unknown }>(request);
    if (!parsed.ok) return NextResponse.json({ code: parsed.status, data: null, msg: parsed.message }, { status: parsed.status });
    try {
        const settings = await setDefaultCloudStorageBytes(parsed.data.defaultBytes);
        await safeRecordAuditLog({ action: "admin.cloud-storage.settings.update", actor: auditActorFromRequest(request, user), target: { type: "cloud_storage_settings", id: "default" }, metadata: settings });
        return NextResponse.json({ code: 0, data: settings, msg: "新用户默认空间已更新" }, { headers: { "Cache-Control": "private, no-store" } });
    } catch (error) { return storageError(error); }
}

async function requireAdmin() {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ code: 401, data: null, msg: "请先登录" }, { status: 401 });
    return hasAdminPermission(user, "system.manage") ? null : NextResponse.json({ code: 403, data: null, msg: "没有管理云存储的权限" }, { status: 403 });
}

function storageError(error: unknown) {
    if (error instanceof CloudStorageError) return NextResponse.json({ code: error.status, data: null, msg: error.message }, { status: error.status });
    console.error("Cloud storage settings failed", error);
    return NextResponse.json({ code: 500, data: null, msg: "云存储设置操作失败" }, { status: 500 });
}
