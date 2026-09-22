import { ensurePostgresSchema, getDatabaseProvider, postgresQuery, withPostgresTransaction, type QueryExecutor } from "@/lib/server/database";

export type CloudStorageSource = "asset" | "project" | "backup" | "work";
export type CloudProjectBackup = { projectId: string; title: string };
export type CloudStorageUsage = {
    baseBytes: number;
    bonusBytes: number;
    grantedBytes: number;
    limitBytes: number;
    usedBytes: number;
    reservedBytes: number;
    availableBytes: number;
    overQuota: boolean;
    bySource: Record<CloudStorageSource, number>;
};

export class CloudStorageError extends Error {
    constructor(message: string, readonly status: number) { super(message); }
}

export async function getCloudStorageSettings() {
    await requireCloudDatabase();
    const result = await postgresQuery<{ default_bytes: string }>("SELECT default_bytes FROM cloud_storage_settings WHERE id = 'default'");
    if (!result.rows[0]) throw new CloudStorageError("云存储默认空间配置不存在", 500);
    return { defaultBytes: safeBytes(result.rows[0].default_bytes) };
}

export async function setDefaultCloudStorageBytes(value: unknown) {
    const defaultBytes = inputBytes(value, true);
    await requireCloudDatabase();
    await postgresQuery("UPDATE cloud_storage_settings SET default_bytes = $1, updated_at = now() WHERE id = 'default'", [defaultBytes]);
    return { defaultBytes };
}

export async function getCloudStorageUsage(userId: string): Promise<CloudStorageUsage> {
    await requireCloudDatabase();
    return withPostgresTransaction(async (db) => {
        const account = await lockAccount(db, userId);
        return calculateUsage(db, userId, account);
    });
}

/** Call only from the server upload coordinator, before writing an OSS object. */
export async function reserveCloudStorage(input: {
    userId: string;
    reservationId: string;
    objectKey: string;
    bytes: number;
    checksumSha256: string;
    source: CloudStorageSource;
    expiresAt: Date;
}) {
    const userId = input.userId.trim();
    const bytes = inputBytes(input.bytes, false);
    const checksum = validChecksum(input.checksumSha256);
    const source = validSource(input.source);
    const objectKey = validObjectKey(userId, input.objectKey);
    const reservationId = validReservationId(input.reservationId);
    if (!Number.isFinite(input.expiresAt.getTime()) || input.expiresAt.getTime() <= Date.now()) throw new CloudStorageError("上传预留有效期无效", 400);
    await requireCloudDatabase();
    return withPostgresTransaction(async (db) => {
        const account = await lockAccount(db, userId);
        await db.query("DELETE FROM cloud_storage_reservations WHERE user_id = $1 AND expires_at <= now()", [userId]);
        const referenced = await db.query<{ object_key: string; bytes: string; checksum_sha256: string; source: CloudStorageSource }>(
            `SELECT r.object_key, o.bytes, o.checksum_sha256, r.source
             FROM cloud_storage_object_refs r JOIN cloud_storage_objects o ON o.object_key = r.object_key
             WHERE r.user_id = $1 AND r.id = $2`, [userId, reservationId],
        );
        if (referenced.rows[0]) {
            const row = referenced.rows[0];
            if (safeBytes(row.bytes) !== bytes || row.checksum_sha256 !== checksum || row.source !== source) throw new CloudStorageError("上传请求身份已用于其他文件", 409);
            return { status: "stored" as const, objectKey: row.object_key, referenceId: reservationId, bytes };
        }
        const stored = await db.query<{ object_key: string; bytes: string }>("SELECT object_key, bytes FROM cloud_storage_objects WHERE user_id = $1 AND checksum_sha256 = $2 ORDER BY created_at ASC LIMIT 1", [userId, checksum]);
        if (stored.rows[0]) {
            if (safeBytes(stored.rows[0].bytes) !== bytes) throw new CloudStorageError("文件摘要与已存文件大小不一致", 409);
            return { status: "stored" as const, objectKey: stored.rows[0].object_key, referenceId: reservationId, bytes };
        }
        const existing = await db.query<{ id: string; object_key: string; bytes: string; checksum_sha256: string; source: string }>(
            "SELECT id, object_key, bytes, checksum_sha256, source FROM cloud_storage_reservations WHERE user_id = $1 AND (id = $2 OR checksum_sha256 = $3) LIMIT 1",
            [userId, reservationId, checksum],
        );
        if (existing.rows[0]) {
            const row = existing.rows[0];
            if (row.id === reservationId && (row.object_key !== objectKey || safeBytes(row.bytes) !== bytes || row.checksum_sha256 !== checksum || row.source !== source)) throw new CloudStorageError("预留请求身份已用于其他文件", 409);
            if (row.id !== reservationId) throw new CloudStorageError("相同文件正在上传，请稍后重试", 409);
            return { status: "reserved" as const, reservationId: row.id, objectKey: row.object_key };
        }
        const usage = await calculateUsage(db, userId, account);
        if (bytes > usage.availableBytes) throw new CloudStorageError("云存储空间不足，请清理文件或购买容量", 409);
        await db.query(
            `INSERT INTO cloud_storage_reservations (id, user_id, object_key, bytes, checksum_sha256, source, expires_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [reservationId, userId, objectKey, bytes, checksum, source, input.expiresAt],
        );
        return { status: "reserved" as const, reservationId, objectKey };
    });
}

/** Attach only after the coordinator confirms the existing OSS object still exists. */
export async function attachCloudStorageReference(input: {
    userId: string; referenceId: string; objectKey: string; bytes: number; checksumSha256: string; source: CloudStorageSource; backup?: CloudProjectBackup;
}) {
    const userId = input.userId.trim();
    const referenceId = validReservationId(input.referenceId);
    const objectKey = validObjectKey(userId, input.objectKey);
    const bytes = inputBytes(input.bytes, false);
    const checksum = validChecksum(input.checksumSha256);
    const source = validSource(input.source);
    const backup = validBackup(source, input.backup);
    await requireCloudDatabase();
    return withPostgresTransaction(async (db) => {
        await lockAccount(db, userId);
        const object = await db.query<{ bytes: string; checksum_sha256: string }>(
            "SELECT bytes, checksum_sha256 FROM cloud_storage_objects WHERE user_id = $1 AND object_key = $2", [userId, objectKey],
        );
        if (!object.rows[0] || safeBytes(object.rows[0].bytes) !== bytes || object.rows[0].checksum_sha256 !== checksum) throw new CloudStorageError("云端文件索引已变化，请重新上传", 409);
        const existing = await db.query<{ object_key: string; source: CloudStorageSource }>(
            "SELECT object_key, source FROM cloud_storage_object_refs WHERE user_id = $1 AND id = $2", [userId, referenceId],
        );
        if (existing.rows[0]) {
            if (existing.rows[0].object_key !== objectKey || existing.rows[0].source !== source) throw new CloudStorageError("上传请求身份已用于其他文件", 409);
            return { referenceId };
        }
        await db.query("INSERT INTO cloud_storage_object_refs (id, user_id, object_key, source) VALUES ($1,$2,$3,$4)", [referenceId, userId, objectKey, source]);
        if (backup) await insertProjectBackup(db, userId, referenceId, backup);
        return { referenceId };
    });
}

/** The caller must verify the stored OSS object's actual size and digest first. */
export async function completeCloudStorageReservation(input: { userId: string; reservationId: string; verifiedBytes: number; verifiedChecksumSha256: string; backup?: CloudProjectBackup }) {
    const userId = input.userId.trim();
    const verifiedBytes = inputBytes(input.verifiedBytes, true);
    const verifiedChecksum = validChecksum(input.verifiedChecksumSha256);
    const reservationId = validReservationId(input.reservationId);
    await requireCloudDatabase();
    return withPostgresTransaction(async (db) => {
        const account = await lockAccount(db, userId);
        const result = await db.query<{ object_key: string; bytes: string; checksum_sha256: string; source: CloudStorageSource; expires_at: Date }>(
            "SELECT object_key, bytes, checksum_sha256, source, expires_at FROM cloud_storage_reservations WHERE user_id = $1 AND id = $2 FOR UPDATE",
            [userId, reservationId],
        );
        const reservation = result.rows[0];
        if (!reservation) throw new CloudStorageError("上传预留不存在或已过期", 404);
        const backup = validBackup(reservation.source, input.backup);
        if (new Date(reservation.expires_at).getTime() <= Date.now()) throw new CloudStorageError("上传预留已过期", 409);
        if (verifiedBytes > safeBytes(reservation.bytes) || verifiedChecksum !== reservation.checksum_sha256) throw new CloudStorageError("OSS 文件大小或摘要与预留不一致", 409);
        const usage = await calculateUsage(db, userId, account);
        if (usage.usedBytes + usage.reservedBytes - safeBytes(reservation.bytes) + verifiedBytes > usage.limitBytes) throw new CloudStorageError("当前有效云存储额度不足", 409);
        await db.query(
            `INSERT INTO cloud_storage_objects (object_key, user_id, bytes, checksum_sha256, source)
             VALUES ($1,$2,$3,$4,$5)`,
            [reservation.object_key, userId, verifiedBytes, verifiedChecksum, reservation.source],
        );
        await db.query("INSERT INTO cloud_storage_object_refs (id, user_id, object_key, source) VALUES ($1,$2,$3,$4)", [reservationId, userId, reservation.object_key, reservation.source]);
        if (backup) await insertProjectBackup(db, userId, reservationId, backup);
        await db.query("DELETE FROM cloud_storage_reservations WHERE user_id = $1 AND id = $2", [userId, reservationId]);
        return { objectKey: reservation.object_key, referenceId: reservationId, bytes: verifiedBytes };
    });
}

export async function releaseCloudStorageReservation(userId: string, reservationId: string) {
    await requireCloudDatabase();
    await postgresQuery("DELETE FROM cloud_storage_reservations WHERE user_id = $1 AND id = $2", [userId, validReservationId(reservationId)]);
}

export async function getCloudStorageObject(userId: string, referenceId: string) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(referenceId)) throw new CloudStorageError("云存储文件身份无效", 400);
    await requireCloudDatabase();
    const result = await postgresQuery<{ object_key: string; bytes: string; checksum_sha256: string; source: CloudStorageSource }>(
        `SELECT o.object_key, o.bytes, o.checksum_sha256, r.source FROM cloud_storage_object_refs r
         JOIN cloud_storage_objects o ON o.object_key = r.object_key
         WHERE r.user_id = $1 AND r.id = $2`,
        [userId, referenceId],
    );
    if (!result.rows[0]) throw new CloudStorageError("云存储文件不存在", 404);
    return { referenceId, objectKey: result.rows[0].object_key, bytes: safeBytes(result.rows[0].bytes), checksumSha256: result.rows[0].checksum_sha256, source: result.rows[0].source };
}

export async function listCloudProjectBackups(userId: string, page: number, pageSize: number) {
    if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new CloudStorageError("备份分页参数无效", 400);
    await requireCloudDatabase();
    const offset = (page - 1) * pageSize;
    if (!Number.isSafeInteger(offset)) throw new CloudStorageError("备份分页参数无效", 400);
    const [items, total] = await Promise.all([
        postgresQuery<{ reference_id: string; project_id: string; title: string; created_at: Date; bytes: string; checksum_sha256: string }>(
            `SELECT b.reference_id, b.project_id, b.title, b.created_at, o.bytes, o.checksum_sha256
             FROM cloud_storage_project_backups b
             JOIN cloud_storage_object_refs r ON r.id = b.reference_id AND r.user_id = b.user_id
             JOIN cloud_storage_objects o ON o.object_key = r.object_key AND o.user_id = b.user_id
             WHERE b.user_id = $1 ORDER BY b.created_at DESC, b.reference_id DESC LIMIT $2 OFFSET $3`,
            [userId, pageSize, offset],
        ),
        postgresQuery<{ total: string }>("SELECT count(*)::text AS total FROM cloud_storage_project_backups WHERE user_id = $1", [userId]),
    ]);
    return { items: items.rows.map((row) => ({ referenceId: row.reference_id, projectId: row.project_id, title: row.title,
        createdAt: new Date(row.created_at).toISOString(), bytes: safeBytes(row.bytes), checksumSha256: row.checksum_sha256 })),
        total: safeBytes(total.rows[0]?.total), page, pageSize };
}

export async function getCloudProjectBackup(userId: string, referenceId: string) {
    const object = await getCloudStorageObject(userId, referenceId);
    if (object.source !== "backup") throw new CloudStorageError("云端项目备份不存在", 404);
    await requireCloudDatabase();
    const result = await postgresQuery<{ project_id: string; title: string }>(
        "SELECT project_id, title FROM cloud_storage_project_backups WHERE user_id = $1 AND reference_id = $2", [userId, referenceId],
    );
    if (!result.rows[0]) throw new CloudStorageError("云端项目备份不存在", 404);
    return { ...object, projectId: result.rows[0].project_id, title: result.rows[0].title };
}

export async function deleteCloudStorageReference(userId: string, referenceId: string, removeObject: (objectKey: string) => Promise<void>) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(referenceId)) throw new CloudStorageError("云存储文件身份无效", 400);
    await requireCloudDatabase();
    return withPostgresTransaction(async (db) => {
        const account = await lockAccount(db, userId);
        const result = await db.query<{ object_key: string }>(
            "SELECT object_key FROM cloud_storage_object_refs WHERE user_id = $1 AND id = $2 FOR UPDATE", [userId, referenceId],
        );
        const objectKey = result.rows[0]?.object_key;
        if (!objectKey) throw new CloudStorageError("云存储文件不存在", 404);
        const remaining = await db.query<{ source: CloudStorageSource }>(
            "SELECT source FROM cloud_storage_object_refs WHERE user_id = $1 AND object_key = $2 AND id <> $3 ORDER BY created_at ASC, id ASC LIMIT 1",
            [userId, objectKey, referenceId],
        );
        if (!remaining.rows[0]) await removeObject(objectKey);
        await db.query("DELETE FROM cloud_storage_object_refs WHERE user_id = $1 AND id = $2", [userId, referenceId]);
        if (remaining.rows[0]) await db.query("UPDATE cloud_storage_objects SET source = $2 WHERE object_key = $1 AND user_id = $3", [objectKey, remaining.rows[0].source, userId]);
        else await db.query("DELETE FROM cloud_storage_objects WHERE object_key = $1 AND user_id = $2", [objectKey, userId]);
        return { objectDeleted: !remaining.rows[0], usage: await calculateUsage(db, userId, account) };
    });
}

async function requireCloudDatabase() {
    if (getDatabaseProvider() !== "postgres") throw new CloudStorageError("云存储只能在云端使用", 403);
    await ensurePostgresSchema();
}

async function lockAccount(db: QueryExecutor, userId: string) {
    if (!userId) throw new CloudStorageError("用户身份无效", 400);
    const result = await db.query<{ base_bytes: string; bonus_bytes: string }>("SELECT base_bytes, bonus_bytes FROM cloud_storage_accounts WHERE user_id = $1 FOR UPDATE", [userId]);
    if (!result.rows[0]) throw new CloudStorageError("用户云存储账户不存在", 404);
    return result.rows[0];
}

async function calculateUsage(db: QueryExecutor, userId: string, account: { base_bytes: string; bonus_bytes: string }): Promise<CloudStorageUsage> {
    const [objects, reservations, grants] = await Promise.all([
        db.query<{ source: CloudStorageSource; bytes: string }>("SELECT source, coalesce(sum(bytes),0) AS bytes FROM cloud_storage_objects WHERE user_id = $1 GROUP BY source", [userId]),
        db.query<{ bytes: string }>("SELECT coalesce(sum(bytes),0) AS bytes FROM cloud_storage_reservations WHERE user_id = $1 AND expires_at > now()", [userId]),
        db.query<{ bytes: string }>("SELECT coalesce(sum(bytes),0) AS bytes FROM cloud_storage_grants WHERE user_id = $1 AND starts_at <= now() AND (ends_at IS NULL OR ends_at > now()) AND revoked_at IS NULL", [userId]),
    ]);
    const bySource: CloudStorageUsage["bySource"] = { asset: 0, project: 0, backup: 0, work: 0 };
    for (const row of objects.rows) bySource[row.source] = safeBytes(row.bytes);
    const baseBytes = safeBytes(account.base_bytes);
    const bonusBytes = safeBytes(account.bonus_bytes);
    const grantedBytes = safeBytes(grants.rows[0]?.bytes);
    const limitBytes = safeTotal(baseBytes, bonusBytes, grantedBytes);
    const usedBytes = safeTotal(...Object.values(bySource));
    const reservedBytes = safeBytes(reservations.rows[0]?.bytes);
    return { baseBytes, bonusBytes, grantedBytes, limitBytes, usedBytes, reservedBytes,
        availableBytes: Math.max(0, limitBytes - safeTotal(usedBytes, reservedBytes)), overQuota: safeTotal(usedBytes, reservedBytes) > limitBytes, bySource };
}

function inputBytes(value: unknown, allowZero: boolean) {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) throw new CloudStorageError("存储大小必须是有效字节数", 400);
    return value;
}
function safeBytes(value: unknown) {
    const number = Number(value || 0);
    if (!Number.isSafeInteger(number) || number < 0) throw new CloudStorageError("云存储用量超出可表示范围", 500);
    return number;
}
function safeTotal(...values: number[]) {
    return safeBytes(values.reduce((total, value) => total + value, 0));
}
function validChecksum(value: string) {
    const checksum = value.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(checksum)) throw new CloudStorageError("文件摘要无效", 400);
    return checksum;
}
function validSource(value: CloudStorageSource) {
    if (!["asset", "project", "backup", "work"].includes(value)) throw new CloudStorageError("云存储文件来源无效", 400);
    return value;
}
function validBackup(source: CloudStorageSource, value: CloudProjectBackup | undefined) {
    if (!value) return undefined;
    if (source !== "backup") throw new CloudStorageError("只有备份文件可登记项目备份", 400);
    const projectId = typeof value.projectId === "string" ? value.projectId.trim() : "";
    const title = typeof value.title === "string" ? value.title.trim() : "";
    if (!projectId || projectId.length > 160 || !title || title.length > 200) throw new CloudStorageError("项目备份信息无效", 400);
    return { projectId, title };
}
function insertProjectBackup(db: QueryExecutor, userId: string, referenceId: string, backup: CloudProjectBackup) {
    return db.query("INSERT INTO cloud_storage_project_backups (reference_id, user_id, project_id, title) VALUES ($1,$2,$3,$4)",
        [referenceId, userId, backup.projectId, backup.title]);
}
function validReservationId(value: string) {
    if (!/^[a-zA-Z0-9_-]{16,128}$/.test(value)) throw new CloudStorageError("上传请求身份无效", 400);
    return value;
}
function validObjectKey(userId: string, value: string) {
    const prefix = `cloud/users/${userId}/`;
    if (!/^[a-zA-Z0-9_-]+$/.test(userId) || !value.startsWith(prefix) || value.includes("..") || value.includes("\\") || value.length > 1000) throw new CloudStorageError("云存储对象路径无效", 400);
    return value;
}
