import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Dola API admin section account tabs and rate limit recovery", () => {
    it("configures the dedicated account tabs: 全部, 正常, 失效, 可轮询, 触发频繁, 额度已用完", () => {
        const source = readFileSync(new URL("./admin-dola-api-section.tsx", import.meta.url), "utf8");

        expect(source).toContain('{ key: "all", label: `全部 ${accountTabCounts.all}` }');
        expect(source).toContain('{ key: "normal", label: `正常 ${accountTabCounts.normal}` }');
        expect(source).toContain('{ key: "invalid", label: `失效 ${accountTabCounts.invalid}` }');
        expect(source).toContain('{ key: "dispatchable", label: `可轮询 ${accountTabCounts.dispatchable}` }');
        expect(source).toContain('{ key: "rate_limited", label: `触发频繁 ${accountTabCounts.rate_limited}` }');
        expect(source).toContain('{ key: "quota_exhausted", label: `额度已用完 ${accountTabCounts.quota_exhausted}` }');
    });

    it("distinguishes account states correctly and provides manual unblocking for rate-limited and quota-exhausted accounts", () => {
        const source = readFileSync(new URL("./admin-dola-api-section.tsx", import.meta.url), "utf8");

        expect(source).toContain('isInvalidAccount');
        expect(source).toContain('isNormalAccount');
        expect(source).toContain('isDispatchableAccount');
        expect(source).toContain('isRateLimitedAccount');
        expect(source).toContain('isQuotaExhaustedAccount');

        // Status tags
        expect(source).toContain('<Tag color="error">登录失效</Tag>');
        expect(source).toContain('<Tag color="volcano" title={row.restrictedReason || "今日生成次数已达上限"}>额度已用完</Tag>');
        expect(source).toContain('<Tag color="warning">触发频繁</Tag>');
        expect(source).toContain('<Tag color="success">登录有效 · 可轮询</Tag>');

        // Unblock & reset quota buttons
        expect(source).toContain('row.status === "rate_limited"');
        expect(source).toContain('解除频繁');
        expect(source).toContain('row.status === "quota_exhausted"');
        expect(source).toContain('重置额度');
        expect(source).toContain('resetDolaAccountQuota(row.id)');
    });
});
