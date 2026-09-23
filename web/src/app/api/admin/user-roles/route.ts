import { NextResponse } from "next/server";

import { getFreshAuthSettings, isAuthInputError, listPublicUsersPage, setAuthSettings } from "@/lib/auth/store";
import { readJsonBody } from "@/lib/auth/request";
import { getCurrentUser } from "@/lib/auth/session";
import { hasAdminPermission } from "@/lib/admin-permissions";
import { normalizeUserRoleDefinitions, userRoleDefinitionsValidationError } from "@/lib/user-roles";
import { auditActorFromRequest, safeRecordAuditLog } from "@/lib/server/audit-log-store";

export const runtime = "nodejs";

export async function PUT(request: Request) {
    const currentUser = await getCurrentUser();
    if (!currentUser) return NextResponse.json({ error: "请先登录" }, { status: 401 });
    if (!hasAdminPermission(currentUser, "users.manage")) return NextResponse.json({ error: "当前管理员没有管理用户角色的职责权限" }, { status: 403 });

    try {
        const body = await readJsonBody<{ roles?: unknown }>(request);
        const validationError = userRoleDefinitionsValidationError(body.roles);
        if (validationError) return NextResponse.json({ error: validationError }, { status: 400 });
        const currentSettings = await getFreshAuthSettings();
        const roles = normalizeUserRoleDefinitions(body.roles);
        const nextIds = new Set(roles.map((role) => role.id));
        const removedRoles = currentSettings.userRoles.filter((role) => role.id !== "user" && !nextIds.has(role.id));
        for (const role of removedRoles) {
            const assigned = await listPublicUsersPage({ role: role.id, page: 1, pageSize: 1 });
            if (assigned.total) return NextResponse.json({ error: `角色“${role.name}”仍分配给 ${assigned.total} 个用户，请先调整这些用户的角色` }, { status: 409 });
        }
        const settings = await setAuthSettings({ userRoles: roles });
        await safeRecordAuditLog({
            action: "admin.user-roles.update",
            actor: auditActorFromRequest(request, currentUser),
            target: { type: "settings", id: "user-roles" },
            metadata: { roleIds: roles.map((role) => role.id), removedRoleIds: removedRoles.map((role) => role.id) },
        });
        return NextResponse.json({ roles: settings.userRoles });
    } catch (error) {
        await safeRecordAuditLog({
            action: "admin.user-roles.update",
            status: "failure",
            actor: auditActorFromRequest(request, currentUser),
            target: { type: "settings", id: "user-roles" },
            metadata: { error: error instanceof Error ? error.message : "unknown" },
        });
        if (isAuthInputError(error)) return NextResponse.json({ error: error.message }, { status: error.status });
        console.error("Admin user-role update failed", error);
        return NextResponse.json({ error: "保存用户角色失败" }, { status: 500 });
    }
}
