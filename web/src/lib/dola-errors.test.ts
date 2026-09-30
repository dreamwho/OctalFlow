import { describe, expect, it } from "vitest";

import { describeDolaFailure, dolaErrorHint, isDolaPreparingTask, isDolaQuotaExhaustedError, isDolaRateLimitError, shouldRotateAccountForError } from "./dola-errors";

describe("dola-errors", () => {
    it("识别额度用完错误与今日生成上限", () => {
        expect(isDolaQuotaExhaustedError("upstream_quota_exhausted")).toBe(true);
        expect(isDolaQuotaExhaustedError("今天的生成次数已经到达上限，明天再来免费生成吧")).toBe(true);
        expect(isDolaQuotaExhaustedError("今日生成次数已达上限")).toBe(true);
        expect(isDolaQuotaExhaustedError("免费生成次数已用完")).toBe(true);
        expect(isDolaQuotaExhaustedError("quota_exhausted")).toBe(true);
        expect(isDolaQuotaExhaustedError("rate_limited")).toBe(false);
    });

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
        expect(shouldRotateAccountForError("uploading_references: reference_2_of_9: imagex_upload_WriteTimeout")).toBe(false);
        expect(shouldRotateAccountForError("uploading_references: reference_1_of_9: imagex_apply_ConnectError")).toBe(false);
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

    it("区分 Provider 参考图准备与 Dola 会话生成", () => {
        expect(isDolaPreparingTask({ status: "queued" })).toBe(true);
        expect(isDolaPreparingTask({ status: "running", diagnostics: { submitStage: "uploading_references" } })).toBe(true);
        expect(isDolaPreparingTask({ status: "running", conversationId: "38418080062463249", diagnostics: { submitStage: "uploading_references" } })).toBe(false);
        expect(describeDolaFailure("uploading_references: reference_3_of_9: reference_fetch_ConnectError")).toContain("尚未向 Dola 提交");
        expect(describeDolaFailure("uploading_references: reference_3_of_9: imagex_apply_ConnectError")).toContain("上传服务连接失败");
        expect(describeDolaFailure("uploading_references: reference_2_of_9: imagex_upload_WriteTimeout")).toContain("尚未向 Dola 提交");
    });

    it("网关描述拼接错误码与注释，未知错误给兜底说明", () => {
        expect(describeDolaFailure("rate_limited")).toBe("rate_limited（上游账号触发生成频率/数量限制 (upstream account rate-limited)）");
        expect(describeDolaFailure("")).toBe("unknown（上游返回未知错误 unknown upstream error）");
        expect(describeDolaFailure("视频生成目前支持 4–15 秒。你要求的 30 秒无法直接生成")).toBe("视频生成目前支持 4–15 秒。你要求的 30 秒无法直接生成");
    });

    it("网关已翻译的文本可据 includes 判断去重，避免界面重复拼接", () => {
        const translated = describeDolaFailure("rate_limited");
        const hint = dolaErrorHint("rate_limited");
        expect(hint).toBeTruthy();
        expect(translated.includes(hint!)).toBe(true);
    });
});
