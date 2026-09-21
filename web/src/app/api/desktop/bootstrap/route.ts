import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";

import { createFirstAdmin, createSession, listPublicUsersPage } from "@/lib/auth/store";
import { setSessionCookie } from "@/lib/auth/session";
import { getDesktopEdition, isTrustedDesktopRequest, safeDesktopNextPath } from "@/lib/server/desktop-runtime";
import { invalidateInstallStatusCache } from "@/lib/server/install-status";

export const runtime = "nodejs";

export async function GET(request: Request) {
    if (getDesktopEdition() !== "admin" || !isTrustedDesktopRequest(request)) {
        return NextResponse.json({ code: 403, data: null, msg: "桌面本地会话令牌无效" }, { status: 403 });
    }

    const admins = await listPublicUsersPage({ role: "admin", status: "active", page: 1, pageSize: 1 });
    let admin = admins.users[0];
    if (!admin) {
        const installToken = process.env.DREAMYO_INSTALL_TOKEN || "";
        admin = await createFirstAdmin({
            username: "desktop_admin",
            displayName: "本地管理员",
            password: process.env.DREAMYO_DESKTOP_ADMIN_PASSWORD || randomBytes(32).toString("base64url"),
            installToken,
        });
        invalidateInstallStatusCache();
    }

    const sessionValue = await createSession(admin.id);
    const next = safeDesktopNextPath(new URL(request.url).searchParams.get("next"));
    const response = NextResponse.redirect(new URL(next, process.env.DREAMYO_INTERNAL_ORIGIN || request.url), 303);
    setSessionCookie(response, sessionValue, request);
    return response;
}
