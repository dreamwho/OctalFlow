import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { availableForModel, getDolaAccount, importDolaAccounts, markDolaAccountReady, observeDolaTaskQuota, reserveDolaAccount } from "./account-service";
import { dolaRuntimeRequest } from "./provider";
import { readDolaQuotaReply } from "./quota-observation";

const model = "dola-seedance-2-5";
const reply = (remaining: number) => `本次使用 Dreamina Seedance 2.5 生成，将消耗 2 个视频生成额度，预计等待 30 分钟。视频生成好后，我会主动发送给你，今日剩余 ${remaining} 个视频生成额度。`;
describe("Dola semantic quota observations", () => {
    let directory: string;
    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), "dola-quota-"));
        vi.stubEnv("DREAMYO_DATA_DIR", directory);
        vi.stubEnv("DREAMYO_DATABASE_PROVIDER", "file");
        vi.stubEnv("DREAMYO_ENCRYPTION_KEY", "a".repeat(64));
    });
    afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });

    it("normalizes an accepted HTTP200 refusal, persists exhaustion, and reserves the next account", async () => {
        await importDolaAccounts([{ cookie: "sid=one" }, { cookie: "sid=two" }]);
        const first = await reserveDolaAccount(model);
        await observeDolaTaskQuota(first!.id, { id: "earlier-priced-task", conversationReply: reply(2) }, model);
        vi.stubEnv("DREAMYO_DOLA_PROVIDER_URL", "https://fixture.example.test");
        vi.stubEnv("DREAMYO_DOLA_PROVIDER_KEY", "fixture");
        vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json({ id: "quota-task", status: "accepted", model, conversationId: "conversation", conversationReply: "今天的生成次数已经达到上限，明天再来免费生成吧" }));
        const response = await dolaRuntimeRequest("/v1/videos", { method: "POST", body: JSON.stringify({ model, accountId: first!.id }) });
        expect(response.status).toBe(200);
        const result = await response.json();
        expect(result).toMatchObject({ status: "failed", error: "upstream_quota_exhausted", quota: [expect.objectContaining({ remaining: 0 })] });
        expect(result.quota[0]).not.toHaveProperty("observations");
        expect(result.quota[0]).not.toHaveProperty("taskCost");
        await markDolaAccountReady(first!.id);
        expect(await getDolaAccount(first!.id)).toMatchObject({ status: "quota_exhausted" });
        expect((await reserveDolaAccount(model))?.id).not.toBe(first!.id);
    });

    it("records task charges once, excludes insufficient balances and resets dispatch on the next day", async () => {
        await importDolaAccounts([{ cookie: "sid=quota" }]);
        const account = await reserveDolaAccount(model);
        const first = { id: "one", status: "accepted", conversationReply: reply(2) };
        await observeDolaTaskQuota(account!.id, first, model);
        await observeDolaTaskQuota(account!.id, first, model);
        await markDolaAccountReady(account!.id, [{ bucket: "video-credit", unit: "credit", remaining: null, limit: null, source: "unknown", version: 1, observedAt: new Date().toISOString() }]);
        expect((await getDolaAccount(account!.id))?.quota?.[0]).toMatchObject({ remaining: 2, consumed: 2, taskCost: 2, observedTotal: 4, limit: null });
        await observeDolaTaskQuota(account!.id, { id: "two", conversationReply: reply(1) }, model);
        const stored = await getDolaAccount(account!.id);
        expect(stored?.quota?.[0]).toMatchObject({ remaining: 1, consumed: 4, observedTotal: 5 });
        expect(availableForModel({ ...stored!, cookieCiphertext: "", cookieFingerprint: "" }, model)).toBe(false);
        expect(availableForModel({ ...stored!, cookieCiphertext: "", cookieFingerprint: "" }, "dola-seedream-4-5")).toBe(true);
        vi.useFakeTimers();
        try {
            vi.setSystemTime(Date.now() + 86400000);
            expect(availableForModel({ ...stored!, cookieCiphertext: "", cookieFingerprint: "" }, model)).toBe(true);
            await observeDolaTaskQuota(account!.id, first, model);
            expect((await getDolaAccount(account!.id))?.quota?.[0].consumed).toBe(4);
        }
        finally { vi.useRealTimers(); }
    });

    it("uses diagnostics text and does not turn a delivered result into quota failure", () => {
        expect(readDolaQuotaReply({ diagnostics: { upstreamResponseText: reply(0) } })).toMatchObject({ consumed: 2, remaining: 0, exhausted: false });
        expect(readDolaQuotaReply({ videoUrl: "https://fixture.test/result.mp4", conversationReply: "明天再来免费生成" })).toBeNull();
    });
});
