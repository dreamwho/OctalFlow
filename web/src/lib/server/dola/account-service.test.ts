import { describe, expect, it } from "vitest";
import { availableForModel, isDateBeforeToday, isNormalDolaAccount, normalizeDolaAccountStatus } from "./account-service";
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

describe("Dola account grouping & dispatch filtering", () => {
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
