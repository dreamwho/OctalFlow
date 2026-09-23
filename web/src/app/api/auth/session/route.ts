import { NextResponse } from "next/server";

import { DEFAULT_SITE_SETTINGS, getAuthSettings } from "@/lib/auth/store";
import { getCurrentUser, serializeCurrentUser, serializePublicSettings } from "@/lib/auth/session";
import { getInstallStatus } from "@/lib/server/install-status";
import { getDesktopRuntimeInfo } from "@/lib/server/desktop-runtime";

export const runtime = "nodejs";

export async function GET() {
    let user = null;
    try {
        user = await getCurrentUser();
    } catch {
        user = null;
    }

    if (user) {
        try {
            const settings = await getAuthSettings();
            return NextResponse.json({
                user: serializeCurrentUser(user),
                desktop: getDesktopRuntimeInfo(),
                settings: serializePublicSettings(settings, user),
                install: { ready: true, firstAdminRequired: false, database: { healthy: true, schemaReady: true } },
            });
        } catch {
            user = null;
        }
    }

    const install = await getInstallStatus();
    if (!install.database.healthy || !install.database.schemaReady) {
        return NextResponse.json({ user: null, desktop: getDesktopRuntimeInfo(), settings: { site: DEFAULT_SITE_SETTINGS }, install });
    }

    const settings = await getAuthSettings();
    return NextResponse.json({
        user: null,
        desktop: getDesktopRuntimeInfo(),
        settings: serializePublicSettings(settings),
        install,
    });
}
