import { createHash, randomBytes, randomUUID } from "node:crypto";

import { sessionMaxAgeSeconds } from "@/lib/auth/store";
import { ensurePostgresSchema, getDatabaseProvider, postgresQuery, withPostgresTransaction, type QueryExecutor } from "@/lib/server/database";
import { getDesktopEdition } from "@/lib/server/desktop-runtime";

const REQUEST_LIFETIME_MS = 10 * 60_000;
const ACCESS_LIFETIME_MS = 15 * 60_000;

export class DesktopDeviceAuthError extends Error {
    constructor(message: string, readonly status: number) { super(message); }
}

export async function startDesktopDeviceAuthorization(deviceLabel: unknown) {
    await requireCloud();
    const label = normalizeDeviceLabel(deviceLabel);
    const deviceCode = randomBytes(32).toString("base64url");
    const userCode = randomBytes(8).toString("hex").toUpperCase();
    const expiresAt = new Date(Date.now() + REQUEST_LIFETIME_MS);
    await postgresQuery(
        `INSERT INTO desktop_device_requests (id, device_code_hash, user_code, device_label, expires_at)
         VALUES ($1,$2,$3,$4,$5)`,
        [randomUUID(), hashToken(deviceCode), userCode, label, expiresAt],
    );
    return { deviceCode, userCode, expiresAt: expiresAt.toISOString() };
}

export async function getDesktopDeviceAuthorization(userCode: unknown) {
    await requireCloud();
    const code = normalizeUserCode(userCode);
    const result = await postgresQuery<{ device_label: string; expires_at: Date; status: string }>(
        "SELECT device_label, expires_at, status FROM desktop_device_requests WHERE user_code = $1", [code],
    );
    const row = result.rows[0];
    if (!row || new Date(row.expires_at).getTime() <= Date.now() || row.status === "consumed") throw new DesktopDeviceAuthError("授权请求不存在或已过期", 404);
    return { userCode: code, deviceLabel: row.device_label, expiresAt: new Date(row.expires_at).toISOString(), status: row.status };
}

export async function approveDesktopDeviceAuthorization(userCode: unknown, userId: string) {
    await requireCloud();
    const code = normalizeUserCode(userCode);
    return withPostgresTransaction(async (db) => {
        const result = await db.query<{ id: string; status: string; expires_at: Date }>(
            "SELECT id, status, expires_at FROM desktop_device_requests WHERE user_code = $1 FOR UPDATE", [code],
        );
        const request = result.rows[0];
        if (!request || new Date(request.expires_at).getTime() <= Date.now()) throw new DesktopDeviceAuthError("授权请求不存在或已过期", 404);
        if (request.status !== "pending") throw new DesktopDeviceAuthError("此设备授权请求已经处理", 409);
        await requireActiveUser(db, userId);
        await db.query("UPDATE desktop_device_requests SET status = 'approved', approved_user_id = $2, approved_at = now() WHERE id = $1", [request.id, userId]);
        return { status: "approved" as const };
    });
}

export async function exchangeDesktopDeviceCode(deviceCode: unknown) {
    await requireCloud();
    const codeHash = hashDeviceCode(deviceCode);
    return withPostgresTransaction(async (db) => {
        const result = await db.query<{ id: string; status: string; approved_user_id: string | null; device_label: string; expires_at: Date }>(
            "SELECT id, status, approved_user_id, device_label, expires_at FROM desktop_device_requests WHERE device_code_hash = $1 FOR UPDATE", [codeHash],
        );
        const request = result.rows[0];
        if (!request || new Date(request.expires_at).getTime() <= Date.now()) throw new DesktopDeviceAuthError("设备授权请求已过期，请重新发起", 410);
        if (request.status === "pending") return { status: "pending" as const };
        if (request.status !== "approved" || !request.approved_user_id) throw new DesktopDeviceAuthError("设备授权请求已使用", 409);
        await requireActiveUser(db, request.approved_user_id);
        const credentials = await insertSession(db, request.approved_user_id, request.device_label);
        await db.query("UPDATE desktop_device_requests SET status = 'consumed', consumed_at = now() WHERE id = $1", [request.id]);
        return { status: "authorized" as const, userId: request.approved_user_id, ...credentials };
    });
}

export async function refreshDesktopDeviceSession(refreshToken: unknown) {
    await requireCloud();
    const refreshHash = hashSecret(refreshToken);
    return withPostgresTransaction(async (db) => {
        const result = await db.query<{ id: string; user_id: string; refresh_expires_at: Date }>(
            "SELECT id, user_id, refresh_expires_at FROM desktop_device_sessions WHERE refresh_hash = $1 AND revoked_at IS NULL FOR UPDATE", [refreshHash],
        );
        const session = result.rows[0];
        if (!session || new Date(session.refresh_expires_at).getTime() <= Date.now()) throw new DesktopDeviceAuthError("设备登录已过期，请重新授权", 401);
        await requireActiveUser(db, session.user_id);
        const credentials = newCredentials();
        await db.query(
            `UPDATE desktop_device_sessions SET access_hash = $2, refresh_hash = $3, access_expires_at = $4,
             refresh_expires_at = $5, updated_at = now() WHERE id = $1`,
            [session.id, hashToken(credentials.accessToken), hashToken(credentials.refreshToken), credentials.accessExpiresAt, credentials.refreshExpiresAt],
        );
        return { userId: session.user_id, ...credentials };
    });
}

export async function getDesktopDeviceSessionUserId(accessToken: unknown) {
    await requireCloud();
    const accessHash = hashSecret(accessToken);
    const result = await postgresQuery<{ user_id: string }>(
        `SELECT s.user_id FROM desktop_device_sessions s JOIN users u ON u.id = s.user_id
         WHERE s.access_hash = $1 AND s.revoked_at IS NULL AND s.access_expires_at > now() AND u.status = 'active'`,
        [accessHash],
    );
    if (!result.rows[0]) throw new DesktopDeviceAuthError("设备访问凭据无效或已过期", 401);
    return result.rows[0].user_id;
}

export async function revokeDesktopDeviceSession(refreshToken: unknown) {
    await requireCloud();
    const refreshHash = hashSecret(refreshToken);
    await postgresQuery("UPDATE desktop_device_sessions SET revoked_at = now(), updated_at = now() WHERE refresh_hash = $1 AND revoked_at IS NULL", [refreshHash]);
}

async function insertSession(db: QueryExecutor, userId: string, deviceLabel: string) {
    const credentials = newCredentials();
    await db.query(
        `INSERT INTO desktop_device_sessions (id, user_id, device_label, access_hash, refresh_hash, access_expires_at, refresh_expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [randomUUID(), userId, deviceLabel, hashToken(credentials.accessToken), hashToken(credentials.refreshToken), credentials.accessExpiresAt, credentials.refreshExpiresAt],
    );
    return credentials;
}

async function requireActiveUser(db: QueryExecutor, userId: string) {
    const result = await db.query<{ id: string }>("SELECT id FROM users WHERE id = $1 AND status = 'active'", [userId]);
    if (!result.rows[0]) throw new DesktopDeviceAuthError("云端账号已停用", 403);
}

async function requireCloud() {
    if (getDesktopEdition() || getDatabaseProvider() !== "postgres") throw new DesktopDeviceAuthError("设备授权只能在云端使用", 403);
    await ensurePostgresSchema();
}

function newCredentials() {
    return {
        accessToken: randomBytes(32).toString("base64url"),
        refreshToken: randomBytes(32).toString("base64url"),
        accessExpiresAt: new Date(Date.now() + ACCESS_LIFETIME_MS).toISOString(),
        refreshExpiresAt: new Date(Date.now() + sessionMaxAgeSeconds() * 1000).toISOString(),
    };
}

function hashDeviceCode(value: unknown) {
    if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) throw new DesktopDeviceAuthError("设备授权凭据无效", 400);
    return hashToken(value);
}

function hashSecret(value: unknown) {
    if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) throw new DesktopDeviceAuthError("设备凭据无效", 401);
    return hashToken(value);
}

function hashToken(value: string) { return createHash("sha256").update(value).digest("hex"); }
function normalizeDeviceLabel(value: unknown) {
    if (typeof value !== "string" || !value.trim() || value.trim().length > 80) throw new DesktopDeviceAuthError("设备名称无效", 400);
    return value.trim();
}
function normalizeUserCode(value: unknown) {
    if (typeof value !== "string" || !/^[0-9A-F]{16}$/.test(value.trim().toUpperCase())) throw new DesktopDeviceAuthError("授权码无效", 400);
    return value.trim().toUpperCase();
}
