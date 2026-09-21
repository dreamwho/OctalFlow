/** Dola 协议错误码识别与双语说明，外部网关与后台界面共用。 */

const DOLA_ERROR_HINTS: ReadonlyArray<readonly [RegExp, string]> = [
    [/rate[_ ]?limited|rate limit|too many requests/i, "上游账号触发生成频率/数量限制 (upstream account rate-limited)"],
    [/quota/i, "上游账号配额已耗尽 (upstream account quota exhausted)"],
    [/login|auth|cookie|credential/i, "账号登录态失效，请重新验证 Cookie (account session expired; re-verify the cookie)"],
    [/task[_ ]?not[_ ]?found/i, "任务不存在或已被 Provider 清理 (task not found; it may have been cleaned up)"],
    [/timeout|timed out/i, "上游处理超时 (upstream timeout)"],
    [/sensitive|risk|moderation|blocked/i, "内容被上游风控拦截 (content blocked by upstream risk control)"],
];

/** 识别上游账号级限流错误（Dola 协议约定错误码：rate_limited / too many requests） */
export function isDolaRateLimitError(text: string) {
    return /rate[_ ]?limited|rate limit|too many requests/i.test(text || "");
}

/**
 * 反代账号池协议共享的错误分类：判定一段上游错误文本是否属于"换号有意义"的账号/基础设施类错误。
 * 账号类错误（限流/配额/登录失效/风控验证/服务端 5xx/浏览器导航中断）消耗换号预算；
 * 内容风控与参数错误换任何账号结果都一样，必须立即失败、不消耗预算（fail-fast，避免连累多个账号）。
 */
export function isAccountClassGenerationError(text: string) {
    return /rate[_ ]?limited|rate limit|too many requests|429|quota|capacity|exhausted|login|auth|cookie|credential|unauthorized|401|403|internal server error|bad gateway|service unavailable|502|503|504|timeout|timed out|verification|risk control|temporary|ns_error_abort|page\.goto|net::err|navigation|browser|proxy|protocol[_ ]?validation|signed[_ ]?protocol|signing[_ ]?hook|page[_ ]?identity|signature[_ ]?rejected|submission[_ ]?transport/i.test(text || "");
}

/** 内容风控/参数错误：换号无意义，立即失败 */
export function isContentClassGenerationError(text: string) {
    return /sensitive|moderation|inappropriate|policy|content.*(blocked|violation|flagged)|invalid (request|parameter|prompt)|unsupported/i.test(text || "");
}

/** 反代账号池协议统一的失败判定：账号类错误且非内容类错误才允许换号重试 */
export function shouldRotateAccountForError(text: string) {
    const value = text || "";
    return isAccountClassGenerationError(value) && !isContentClassGenerationError(value);
}

/** 识别错误文本所属类别并返回双语说明；无法识别时返回 null */
export function dolaErrorHint(text: string) {
    return DOLA_ERROR_HINTS.find(([pattern]) => pattern.test(text || ""))?.[1] || null;
}

/** 网关错误说明：错误码 + 中英双语注释，便于第一时间定位问题 */
export function describeDolaFailure(code: string) {
    const raw = (code || "").trim() || "unknown";
    const hint = dolaErrorHint(raw);
    return hint ? `${raw}（${hint}）` : `${raw}（上游返回未知错误 unknown upstream error）`;
}
