import { getCurrentUser } from "@/lib/auth/session";
import { DesktopDeviceAuthError, getDesktopDeviceSessionUserId } from "@/lib/server/desktop-device-auth";

export async function getCloudStorageUserId(request: Request): Promise<string | null> {
    const authorization = request.headers.get("authorization");
    if (authorization !== null) {
        if (!authorization.startsWith("Bearer ")) return null;
        try { return await getDesktopDeviceSessionUserId(authorization.slice(7)); }
        catch (error) { if (error instanceof DesktopDeviceAuthError) return null; throw error; }
    }
    return (await getCurrentUser())?.id || null;
}
