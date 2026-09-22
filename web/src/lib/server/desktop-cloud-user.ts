import { randomBytes, randomUUID } from "node:crypto";

import { formatAccountId } from "@/lib/account-id";
import { createSession, DEFAULT_ENTITLEMENT_PLAN_ID, type StoredUser } from "@/lib/auth/store";
import { mutateAuthDb, readAuthDb } from "@/lib/auth/store-repository";
import { getDesktopEdition } from "@/lib/server/desktop-runtime";

export type DesktopCloudIdentity = { id: string; username: string; displayName: string; email?: string; status: "active" };

export async function bindDesktopCloudUser(identity: DesktopCloudIdentity) {
    if (getDesktopEdition() !== "commercial") throw new Error("云端身份绑定仅供商用桌面版使用");
    if (!/^[a-zA-Z0-9_-]{16,128}$/.test(identity.id) || identity.status !== "active") throw new Error("云端用户身份无效");
    const localUser = await mutateAuthDb((db) => {
        const existing = db.users.find((item) => item.cloudUserId === identity.id);
        if (existing) {
            existing.displayName = identity.displayName || identity.username;
            existing.email = identity.email;
            existing.status = "active";
            existing.updatedAt = new Date().toISOString();
            return existing;
        }
        const now = new Date().toISOString();
        const user: StoredUser = {
            id: randomUUID(),
            cloudUserId: identity.id,
            accountId: formatAccountId(db.nextUserAccountId++),
            username: `cloud_${identity.id.replaceAll("-", "").slice(0, 24)}`,
            email: identity.email,
            displayName: identity.displayName || identity.username,
            bio: "",
            role: "user",
            adminPermissions: [],
            status: "active",
            planId: DEFAULT_ENTITLEMENT_PLAN_ID,
            pointsBalance: 0,
            passwordHash: `desktop-cloud-only:${randomBytes(32).toString("hex")}`,
            createdAt: now,
            updatedAt: now,
        };
        db.users.push(user);
        return user;
    });
    return { localUserId: localUser.id, cloudUserId: identity.id, sessionValue: await createSession(localUser.id) };
}

export async function restoreDesktopCloudUser(cloudUserId: string) {
    if (getDesktopEdition() !== "commercial" || !/^[a-zA-Z0-9_-]{16,128}$/.test(cloudUserId)) throw new Error("离线身份无效");
    const localUser = (await readAuthDb()).users.find((item) => item.cloudUserId === cloudUserId && item.status === "active");
    if (!localUser) throw new Error("此云端账号尚未在本机完成过在线登录");
    return { localUserId: localUser.id, cloudUserId, sessionValue: await createSession(localUser.id) };
}
