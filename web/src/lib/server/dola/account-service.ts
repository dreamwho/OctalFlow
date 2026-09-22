import { createHash, randomUUID } from "node:crypto";

import { readJsonDataFile, withJsonDataFileLock, writeJsonDataFile } from "@/lib/server/data-adapter";
import { decryptSecretValue, encryptSecretValue } from "@/lib/server/secret-crypto";
import { parseDolaImportInputs } from "./account-import";
import { dolaModelProfile, type DolaAccount, type DolaAccountImportItem, type DolaAccountImportResult, type DolaAccountStatus, type DolaAccountValidation, type DolaQuotaSnapshot } from "./types";

const FILE_NAME = "dola/accounts.json";
type StoredDolaAccount = DolaAccount & { cookieCiphertext: string; cookieFingerprint: string };
type DolaDatabase = { accounts: StoredDolaAccount[] };
const EMPTY_DB: DolaDatabase = { accounts: [] };

export async function listDolaAccounts() {
    return (await readDatabase()).accounts.map(publicAccount);
}

export async function getDolaAccount(id: string) {
    const account = (await readDatabase()).accounts.find((item) => item.id === id);
    return account ? publicAccount(account) : null;
}

export async function getDolaAccountCookie(id: string) {
    const account = (await readDatabase()).accounts.find((item) => item.id === id);
    return account ? decryptSecretValue(account.cookieCiphertext) : null;
}

export async function importDolaAccounts(items: DolaAccountImportItem[]) {
    const parsed = parseDolaImportInputs(items);
    const results: DolaAccountImportResult[] = [];
    await withJsonDataFileLock(FILE_NAME, async () => {
        const db = await readDatabase();
        const byFingerprint = new Map(db.accounts.map((account) => [account.cookieFingerprint, account]));
        const batchFingerprints = new Set<string>();
        for (const [index, item] of parsed.entries()) {
            const itemId = `${item.sourceFileName || "input"}:${item.sourceOrdinal || index + 1}`;
            if (item.error || !item.cookie || !item.fingerprint) {
                results.push({ itemId, ...(item.sourceFileName ? { sourceFileName: item.sourceFileName } : {}), ...(item.sourceOrdinal ? { sourceOrdinal: item.sourceOrdinal } : {}), status: "invalid", message: item.error || "Cookie 无效" });
                continue;
            }
            if (batchFingerprints.has(item.fingerprint)) {
                results.push({ itemId, ...(item.sourceFileName ? { sourceFileName: item.sourceFileName } : {}), ...(item.sourceOrdinal ? { sourceOrdinal: item.sourceOrdinal } : {}), status: "duplicate", message: "本批次重复 Cookie" });
                continue;
            }
            batchFingerprints.add(item.fingerprint);
            const existing = byFingerprint.get(item.fingerprint);
            if (existing) {
                existing.updatedAt = new Date().toISOString();
                if (item.name) existing.name = item.name;
                if (item.email) existing.email = item.email;
                if (item.authType) existing.authType = item.authType;
                results.push({ itemId, ...(item.sourceFileName ? { sourceFileName: item.sourceFileName } : {}), ...(item.sourceOrdinal ? { sourceOrdinal: item.sourceOrdinal } : {}), status: "duplicate", account: publicAccount(existing) });
                continue;
            }
            const now = new Date().toISOString();
            const account: StoredDolaAccount = {
                id: `dola-${randomUUID()}`,
                name: item.name || `Dola 账号 ${db.accounts.length + results.filter((result) => result.status === "created").length + 1}`,
                ...(item.email ? { email: item.email } : {}),
                authType: item.authType || "cookie",
                status: "unverified",
                enabled: true,
                credentialVersion: 1,
                requestCount: 0,
                successCount: 0,
                errorCount: 0,
                activeAttempts: 0,
                createdAt: now,
                updatedAt: now,
                cookieCiphertext: encryptSecretValue(item.cookie),
                cookieFingerprint: item.fingerprint,
            };
            db.accounts.push(account);
            byFingerprint.set(account.cookieFingerprint, account);
            results.push({ itemId, ...(item.sourceFileName ? { sourceFileName: item.sourceFileName } : {}), ...(item.sourceOrdinal ? { sourceOrdinal: item.sourceOrdinal } : {}), status: "created", account: publicAccount(account) });
        }
        await writeJsonDataFile(FILE_NAME, db);
    });
    return { results, summary: summarizeImportResults(results) };
}

export async function addOrUpdateGoogleDolaAccount(params: { cookie: string; email?: string; name?: string }) {
    const importResult = await importDolaAccounts([{
        cookie: params.cookie,
        email: params.email,
        name: params.name || (params.email ? `Google 账号 (${params.email})` : undefined),
        authType: "google",
    }]);
    const first = importResult.results[0];
    if (first?.account) {
        return first.account;
    }
    throw new Error(first?.message || "Google 授权账号保存失败");
}

export async function renameDolaAccount(id: string, name: unknown) {
    const value = typeof name === "string" ? name.trim().slice(0, 120) : "";
    if (!value) throw new Error("账号名称不能为空");
    return mutateAccount(id, (account) => ({ ...account, name: value }));
}

export async function setDolaAccountEnabled(id: string, enabled: boolean) {
    return mutateAccount(id, (account) => ({ ...account, enabled, status: enabled ? (["disabled", "restricted", "rate_limited"].includes(account.status) ? "unverified" : account.status) : "disabled" }));
}

export async function deleteDolaAccount(id: string) {
    let deleted = false;
    await withJsonDataFileLock(FILE_NAME, async () => {
        const db = await readDatabase();
        const account = db.accounts.find((item) => item.id === id);
        if (!account) return;
        if (account.activeAttempts > 0) throw new Error("账号仍有运行中的任务，暂不能删除");
        db.accounts = db.accounts.filter((item) => item.id !== id);
        await writeJsonDataFile(FILE_NAME, db);
        deleted = true;
    });
    return { id, deleted };
}

/** 批量删除：仍有运行中任务的账号跳过并计数，不中断其余账号的删除。 */
export async function deleteDolaAccounts(ids: string[]) {
    const wanted = new Set(ids.map((id) => String(id || "").trim()).filter(Boolean));
    if (!wanted.size) return { deleted: 0, skipped: 0 };
    let deleted = 0;
    let skipped = 0;
    await withJsonDataFileLock(FILE_NAME, async () => {
        const db = await readDatabase();
        const remaining = db.accounts.filter((account) => {
            if (!wanted.has(account.id)) return true;
            if (account.activeAttempts > 0) {
                skipped += 1;
                return true;
            }
            deleted += 1;
            return false;
        });
        if (deleted) {
            db.accounts = remaining;
            await writeJsonDataFile(FILE_NAME, db);
        }
    });
    return { deleted, skipped };
}

export async function updateDolaAccountQuota(id: string, quota: DolaQuotaSnapshot[]) {
    return mutateAccount(id, (account) => ({ ...account, quota: quota.slice(0, 32), lastVerifiedAt: new Date().toISOString() }));
}

export async function updateDolaAccountValidation(id: string, validation: DolaAccountValidation) {
    return mutateAccount(id, (account) => ({ ...account, validation, lastVerifiedAt: validation.checkedAt }));
}

export async function updateDolaAccountLoginState(id: string, state: "ready" | "needs_login" | "unknown", code?: number) {
    const checkedAt = new Date().toISOString();
    return mutateAccount(id, (account) => ({
        ...account,
        loginState: state,
        loginCheckedAt: checkedAt,
        ...(typeof code === "number" ? { loginProtocolCode: code } : {}),
        ...(state === "ready"
            ? { status: "ready" as DolaAccountStatus, restrictedReason: undefined }
            : state === "needs_login"
              ? { status: "needs_login" as DolaAccountStatus, quota: [] }
              : {}),
    }));
}

export async function updateDolaAccountGenerationValidation(id: string, generation: NonNullable<DolaAccountValidation["generation"]>) {
    return mutateAccount(id, (account) => ({
        ...account,
        validation: account.validation
            ? { ...account.validation, generation }
            : { checkedAt: generation.checkedAt, ready: false, login: false, signerReady: false, requestObserved: false, signed: false, httpStatus: 0, proxyMode: "direct", generation },
    }));
}

export async function updateDolaAccountCredentials(id: string, cookie: string) {
    const fingerprint = createHash("sha256").update(cookie).digest("hex");
    const cookieCiphertext = encryptSecretValue(cookie);
    return mutateAccount(id, (account) => ({
        ...account,
        cookieCiphertext,
        cookieFingerprint: fingerprint,
        credentialVersion: (account.credentialVersion || 1) + 1,
        status: "ready",
        lastVerifiedAt: new Date().toISOString(),
        restrictedReason: undefined,
    }));
}

export async function refreshDolaAccountCookieIfVersion(id: string, cookie: string, credentialVersion: number) {
    let changed = false;
    await mutateAccount(id, (account) => {
        if (account.credentialVersion !== credentialVersion) throw new Error("cookie_version_conflict");
        changed = decryptSecretValue(account.cookieCiphertext) !== cookie;
        const now = new Date().toISOString();
        return {
            ...account,
            ...(changed ? { cookieCiphertext: encryptSecretValue(cookie), cookieFingerprint: createHash("sha256").update(cookie).digest("hex"), credentialVersion: credentialVersion + 1 } : {}),
            status: "ready", loginState: "ready", loginCheckedAt: now, lastVerifiedAt: now, restrictedReason: undefined,
        };
    });
    return { changed };
}

export async function markDolaAccountReady(id: string, quota?: DolaQuotaSnapshot[]) {
    return mutateAccount(id, (account) => ({
        ...account,
        status: "ready",
        ...(quota ? { quota: quota.slice(0, 32) } : {}),
        lastVerifiedAt: new Date().toISOString(),
        restrictedReason: undefined,
    }));
}

export async function setDolaAccountStatus(id: string, status: DolaAccountStatus) {
    return mutateAccount(id, (account) => ({ ...account, status, lastVerifiedAt: new Date().toISOString() }));
}

/** 上游判定账号登录失效或需要验证：更新状态并清空已过期的额度快照，避免误导调度与展示 */
export async function markDolaAccountUnusable(id: string, status: Extract<DolaAccountStatus, "needs_login" | "verification_required">) {
    const now = new Date().toISOString();
    return mutateAccount(id, (account) => ({ ...account, status, quota: [], lastVerifiedAt: now, ...(status === "needs_login" ? { loginState: "needs_login" as const, loginCheckedAt: now } : {}) }));
}

/** 上游判定账号触发频率限制：标记 restricted 进入风控分类，调度器与换号候选永久剔除，需管理员停用后重新启用才会恢复 */
export async function markDolaAccountRestricted(id: string, reason?: string) {
    return mutateAccount(id, (account) => ({ ...account, status: "restricted" as DolaAccountStatus, rateLimitedAt: new Date().toISOString(), lastUsedAt: new Date().toISOString(), restrictedReason: (reason || account.restrictedReason || "").trim().slice(0, 300) || account.restrictedReason }));
}

/** 频率限制是临时状态，冷却到期后账号自动重新参与调度。 */
export async function markDolaAccountRateLimited(id: string, reason?: string) {
    return mutateAccount(id, (account) => ({
        ...account,
        status: account.loginState === "needs_login" ? "needs_login" as DolaAccountStatus : "ready" as DolaAccountStatus,
        rateLimitedAt: new Date().toISOString(),
        lastUsedAt: new Date().toISOString(),
        restrictedReason: (reason || "").trim().slice(0, 300) || undefined,
    }));
}

export async function markDolaAccountUsed(id: string, success: boolean, releaseAttempt = true) {
    return mutateAccount(id, (account) => ({ ...account, activeAttempts: releaseAttempt ? Math.max(0, account.activeAttempts - 1) : account.activeAttempts, requestCount: account.requestCount + 1, successCount: account.successCount + (success ? 1 : 0), errorCount: account.errorCount + (success ? 0 : 1), lastUsedAt: new Date().toISOString() }));
}

export async function releaseDolaAccountAttempt(id: string) {
    return mutateAccount(id, (account) => ({ ...account, activeAttempts: Math.max(0, account.activeAttempts - 1) }));
}

/** Atomically choose and reserve an account for one upstream submission. */
export async function reserveDolaAccount(_model?: string): Promise<StoredDolaAccount | null> {
    let selected: StoredDolaAccount | null = null;
    await withJsonDataFileLock(FILE_NAME, async () => {
        const db = await readDatabase();
        const candidates = db.accounts
            .filter((account) => availableForModel(account, _model))
            .sort((left, right) => (left.lastUsedAt || "").localeCompare(right.lastUsedAt || "") || left.activeAttempts - right.activeAttempts || left.createdAt.localeCompare(right.createdAt));
        const account = candidates[0];
        if (!account) return;
        account.activeAttempts += 1;
        account.updatedAt = new Date().toISOString();
        selected = structuredClone(account);
        await writeJsonDataFile(FILE_NAME, db);
    });
    return selected;
}

export async function selectDolaAccount(_model?: string) {
    const accounts = (await readDatabase()).accounts.filter((account) => availableForModel(account, _model));
    return accounts.sort((left, right) => (left.lastUsedAt || "").localeCompare(right.lastUsedAt || "") || left.activeAttempts - right.activeAttempts || left.createdAt.localeCompare(right.createdAt)).find(Boolean) || null;
}

export function publicDolaAccountSnapshot(account: StoredDolaAccount) {
    return publicAccount(account);
}

function publicAccount(account: StoredDolaAccount): DolaAccount {
    const { cookieCiphertext: _cookie, cookieFingerprint: _fingerprint, ...publicValue } = account;
    return structuredClone(publicValue);
}

async function mutateAccount(id: string, patch: (account: StoredDolaAccount) => StoredDolaAccount) {
    let result: DolaAccount | null = null;
    await withJsonDataFileLock(FILE_NAME, async () => {
        const db = await readDatabase();
        const index = db.accounts.findIndex((item) => item.id === id);
        if (index < 0) throw new Error("Dola 账号不存在");
        db.accounts[index] = { ...patch(db.accounts[index]), updatedAt: new Date().toISOString() };
        result = publicAccount(db.accounts[index]);
        await writeJsonDataFile(FILE_NAME, db);
    });
    return result;
}

async function readDatabase() {
    const stored = await readJsonDataFile<Partial<DolaDatabase>>(FILE_NAME, EMPTY_DB);
    return { accounts: Array.isArray(stored.accounts) ? structuredClone(stored.accounts) : [] };
}

function summarizeImportResults(results: DolaAccountImportResult[]) {
    return results.reduce<Record<string, number>>((summary, item) => {
        summary[item.status] = (summary[item.status] || 0) + 1;
        return summary;
    }, {});
}

function availableForModel(account: StoredDolaAccount, model?: string) {
    if (!account.enabled || account.status !== "ready" || account.loginState === "needs_login") return false;
    const requested = (model || "").trim().toLowerCase();
    if (!requested || !account.quota?.length) return true;
    const profile = dolaModelProfile(requested);
    const modelIds = new Set([requested, profile?.id, profile?.upstreamModelId].filter((value): value is string => Boolean(value)).map((value) => value.toLowerCase()));
    const modelQuotas = account.quota.filter((item) => {
        const quotaModel = item.model?.trim().toLowerCase();
        return !quotaModel || [...modelIds].some((candidate) => candidate === quotaModel || candidate.includes(quotaModel) || quotaModel.includes(candidate));
    });
    return !modelQuotas.length || modelQuotas.some((item) => item.remaining === null || item.remaining > 0);
}

export function normalizeDolaAccountStatus(value: unknown): DolaAccountStatus {
    return value === "ready" || value === "needs_login" || value === "verification_required" || value === "quota_exhausted" || value === "rate_limited" || value === "restricted" || value === "disabled" ? value : "unverified";
}
