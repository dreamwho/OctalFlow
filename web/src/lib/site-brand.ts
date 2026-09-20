export const DEFAULT_SITE_TITLE = "dreamyo";

export function resolveSiteTitle(value: unknown) {
    return typeof value === "string" && value.trim() ? value.trim() : DEFAULT_SITE_TITLE;
}

/** 「登录 …」等品牌语境只取主品牌名：去掉「- / ｜」后的副标题，超长视为标语回退默认品牌。 */
export function resolveSiteBrandName(value: unknown) {
    const title = resolveSiteTitle(value);
    const name = (title.split(/[|｜·—–-]/)[0] || "").trim() || title;
    return name.length <= 20 ? name : DEFAULT_SITE_TITLE;
}
