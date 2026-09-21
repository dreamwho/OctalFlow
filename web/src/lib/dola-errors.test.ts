import { describe, expect, it } from "vitest";

import { describeDolaFailure, dolaErrorHint, isDolaRateLimitError, shouldRotateAccountForError } from "./dola-errors";

describe("dola-errors", () => {
    it("识别限流错误", () => {
        expect(isDolaRateLimitError("rate_limited")).toBe(true);
        expect(isDolaRateLimitError("Too Many Requests")).toBe(true);
        expect(isDolaRateLimitError("task_not_found")).toBe(false);
    });

    it("账号类错误允许换号，内容/参数错误立即失败", () => {
        expect(shouldRotateAccountForError("rate_limited")).toBe(true);
        expect(shouldRotateAccountForError("quota exhausted")).toBe(true);
        expect(shouldRotateAccountForError("登录态失效，请重新验证 Cookie")).toBe(true);
        expect(shouldRotateAccountForError("HTTP 429")).toBe(true);
        expect(shouldRotateAccountForError("protocol_validation_failed:page_identity_unavailable")).toBe(true);
        expect(shouldRotateAccountForError("submission_transport_result_timeout")).toBe(true);
        expect(shouldRotateAccountForError("sensitive content blocked")).toBe(false);
        expect(shouldRotateAccountForError("invalid request: 缺少参数")).toBe(false);
        expect(shouldRotateAccountForError("")).toBe(false);
    });

    it("返回对应类别的双语说明", () => {
        expect(dolaErrorHint("rate_limited")).toContain("rate-limited");
        expect(dolaErrorHint("quota_exceeded")).toContain("quota");
        expect(dolaErrorHint("cookie_expired")).toContain("Cookie");
        expect(dolaErrorHint("content_blocked")).toContain("风控");
        expect(dolaErrorHint("timeout")).toContain("超时");
        expect(dolaErrorHint("mystery_error")).toBeNull();
    });

    it("网关描述拼接错误码与注释，未知错误给兜底说明", () => {
        expect(describeDolaFailure("rate_limited")).toBe("rate_limited（上游账号触发生成频率/数量限制 (upstream account rate-limited)）");
        expect(describeDolaFailure("")).toBe("unknown（上游返回未知错误 unknown upstream error）");
    });

    it("网关已翻译的文本可据 includes 判断去重，避免界面重复拼接", () => {
        const translated = describeDolaFailure("rate_limited");
        const hint = dolaErrorHint("rate_limited");
        expect(hint).toBeTruthy();
        expect(translated.includes(hint!)).toBe(true);
    });
});
