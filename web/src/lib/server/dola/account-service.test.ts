import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { addOrUpdateGoogleDolaAccount, availableForModel, exportDolaGoogleAccountCookies, getDolaAccount, importDolaAccounts, isDateBeforeToday, isNormalDolaAccount, listDolaAccounts, markDolaAccountUsed, normalizeDolaAccountStatus, reserveDolaAccount } from "./account-service";
import type { StoredDolaAccount } from "./account-service";

function createMockAccount(overrides: Partial<StoredDolaAccount> = {}): StoredDolaAccount {
    return {
        id: "dola-acc-test-1",
        name: "Test Account",
        authType: "cookie",
        status: "ready",
        enabled: true,
        loginState: "ready",
        cookieCiphertext: "enc:test",
        cookieFingerprint: "fp:test",
        credentialVersion: 1,
        activeAttempts: 0,
        requestCount: 0,
        successCount: 0,
        errorCount: 0,
        group: "Batch A",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        ...overrides,
    };
}

describe("Dola Google account persistence", () => {
    it("stores the authorized account in its own group and reads it back", async () => {
        const directory = await mkdtemp(join(tmpdir(), "dreamyo-dola-google-"));
        vi.stubEnv("DREAMYO_DATA_DIR", directory);
        vi.stubEnv("DREAMYO_ENCRYPTION_KEY", "a".repeat(64));
        try {
            await importDolaAccounts([{ cookie: "sid=authorized-session", name: "原 Cookie 账号" }]);
            const account = await addOrUpdateGoogleDolaAccount({ cookie: "sid=authorized-session", name: "Google 测试账号" });
            expect(account.authType).toBe("google");
            expect(account.group).toBe("Google 授权");
            expect(await getDolaAccount(account.id)).toMatchObject({ id: account.id, name: "Google 测试账号", group: "Google 授权" });
            expect(await listDolaAccounts()).toHaveLength(1);
            const second = await addOrUpdateGoogleDolaAccount({ cookie: "sid=another-session", name: "第二个 Google 账号" });
            expect(await exportDolaGoogleAccountCookies()).toEqual(["sid=authorized-session", "sid=another-session"]);
            expect(await exportDolaGoogleAccountCookies([second.id])).toEqual(["sid=another-session"]);
            await expect(exportDolaGoogleAccountCookies(["missing-account"])).rejects.toThrow("不存在或非 Google");
        } finally {
            vi.unstubAllEnvs();
            await rm(directory, { recursive: true, force: true });
        }
    });
});

describe("Dola account grouping & dispatch filtering", () => {
    it("rotates new submissions while retaining the selected account for task polls", async () => {
        const directory = await mkdtemp(join(tmpdir(), "dreamyo-dola-rotation-"));
        vi.stubEnv("DREAMYO_DATA_DIR", directory);
        vi.stubEnv("DREAMYO_ENCRYPTION_KEY", "a".repeat(64));
        try {
            await importDolaAccounts([{ cookie: "sid=rotation-one", name: "轮询账号一" }, { cookie: "sid=rotation-two", name: "轮询账号二" }]);
            const first = await reserveDolaAccount("dola-seedance-2-5");
            await markDolaAccountUsed(first!.id, true);
            const second = await reserveDolaAccount("dola-seedance-2-5");
            expect(first?.id).toBeTruthy();
            expect(second?.id).toBeTruthy();
            expect(second?.id).not.toBe(first?.id);
            expect((await getDolaAccount(first!.id))?.activeAttempts).toBe(0);
            expect((await getDolaAccount(first!.id))?.requestCount).toBe(1);
        } finally {
            vi.unstubAllEnvs();
            await rm(directory, { recursive: true, force: true });
        }
    });
    it("filters accounts by dispatchGroups whitelist in availableForModel", () => {
        const accInBatchA = createMockAccount({ id: "acc-1", group: "Batch A" });
        const accInBatchB = createMockAccount({ id: "acc-2", group: "Batch B" });
        const accNoGroup = createMockAccount({ id: "acc-3", group: undefined });

        // No dispatchGroups configured: all ready & enabled accounts pass
        expect(availableForModel(accInBatchA, "dola-seedance-2-5", [])).toBe(true);
        expect(availableForModel(accInBatchB, "dola-seedance-2-5", [])).toBe(true);
        expect(availableForModel(accNoGroup, "dola-seedance-2-5", [])).toBe(true);

        // dispatchGroups set to ["Batch A"]
        expect(availableForModel(accInBatchA, "dola-seedance-2-5", ["Batch A"])).toBe(true);
        expect(availableForModel(accInBatchB, "dola-seedance-2-5", ["Batch A"])).toBe(false);
        expect(availableForModel(accNoGroup, "dola-seedance-2-5", ["Batch A"])).toBe(false);

        // Multiple dispatchGroups
        expect(availableForModel(accInBatchB, "dola-seedance-2-5", ["Batch A", "Batch B"])).toBe(true);
    });

    it("excludes rate_limited accounts from model dispatch", () => {
        const rateLimitedAcc = createMockAccount({ id: "acc-rate-limited", status: "rate_limited", group: "Batch A" });
        expect(availableForModel(rateLimitedAcc, "dola-seedance-2-5", [])).toBe(false);
        expect(availableForModel(rateLimitedAcc, "dola-seedance-2-5", ["Batch A"])).toBe(false);
    });

    it("excludes quota_exhausted accounts from model dispatch when exhausted today", () => {
        const today = new Date().toISOString();
        const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

        const exhaustedToday = createMockAccount({ id: "acc-quota-today", status: "quota_exhausted", quotaExhaustedAt: today, group: "Batch A" });
        expect(availableForModel(exhaustedToday, "dola-seedance-2-5", ["Batch A"])).toBe(false);

        const exhaustedYesterday = createMockAccount({ id: "acc-quota-yesterday", status: "quota_exhausted", quotaExhaustedAt: yesterday, group: "Batch A" });
        expect(availableForModel(exhaustedYesterday, "dola-seedance-2-5", ["Batch A"])).toBe(true);
    });

    it("respects status and enabled checks alongside dispatchGroups", () => {
        const disabledAcc = createMockAccount({ id: "acc-disabled", enabled: false, group: "Batch A" });
        const needsLoginAcc = createMockAccount({ id: "acc-login", status: "needs_login", group: "Batch A" });

        expect(availableForModel(disabledAcc, "dola-seedance-2-5", ["Batch A"])).toBe(false);
        expect(availableForModel(needsLoginAcc, "dola-seedance-2-5", ["Batch A"])).toBe(false);
    });

    it("allows unverified normal accounts in dispatchGroups to be dispatched", () => {
        const unverifiedAcc = createMockAccount({ id: "acc-unverified", status: "unverified", loginState: undefined, group: "咸鱼千寻寄售" });
        expect(availableForModel(unverifiedAcc, "dola-seedance-2-5", ["咸鱼千寻寄售"])).toBe(true);
        expect(availableForModel(unverifiedAcc, "dola-seedance-2-5", ["Other Group"])).toBe(false);
    });

    it("isDateBeforeToday returns true for previous dates and false for today or future", () => {
        expect(isDateBeforeToday()).toBe(true);
        expect(isDateBeforeToday(undefined)).toBe(true);
        expect(isDateBeforeToday("invalid-date")).toBe(true);

        const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        expect(isDateBeforeToday(yesterday)).toBe(true);

        const today = new Date().toISOString();
        expect(isDateBeforeToday(today)).toBe(false);

        const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
        expect(isDateBeforeToday(tomorrow)).toBe(false);
    });

    it("normalizeDolaAccountStatus properly validates quota_exhausted status", () => {
        expect(normalizeDolaAccountStatus("quota_exhausted")).toBe("quota_exhausted");
        expect(normalizeDolaAccountStatus("ready")).toBe("ready");
        expect(normalizeDolaAccountStatus("rate_limited")).toBe("rate_limited");
        expect(normalizeDolaAccountStatus("needs_login")).toBe("needs_login");
        expect(normalizeDolaAccountStatus("unknown_status")).toBe("unverified");
    });
});
