import { DEFAULT_SITE_TITLE, resolveSiteTitle } from "@/lib/site-brand";

/**
 * 全站页面标题设计（单一事实来源）。
 * 顺序敏感：长前缀优先于短前缀（如 /canvas/ 先于 /canvas、/admin/setup 先于 /admin）。
 */
const PAGE_TITLE_RULES: Array<{ prefix: string; title: string }> = [
    { prefix: "/login", title: "登录" },
    { prefix: "/register", title: "注册" },
    { prefix: "/forgot-password", title: "找回密码" },
    { prefix: "/install", title: "安装向导" },
    { prefix: "/announcements", title: "网站公告" },
    { prefix: "/gallery", title: "作品广场" },
    { prefix: "/community", title: "创意社区" },
    { prefix: "/privacy", title: "隐私政策" },
    { prefix: "/terms", title: "服务条款" },
    { prefix: "/share/", title: "作品分享" },
    { prefix: "/u/", title: "创作者主页" },
    { prefix: "/create", title: "创作工作台" },
    { prefix: "/assets", title: "素材库" },
    { prefix: "/canvas/", title: "无限画布" },
    { prefix: "/canvas", title: "我的项目" },
    { prefix: "/drama/", title: "短剧生产" },
    { prefix: "/drama", title: "短剧项目" },
    { prefix: "/help", title: "帮助中心" },
    { prefix: "/me", title: "我的账户" },
    { prefix: "/profile", title: "个人资料" },
    { prefix: "/prompts", title: "提示词库" },
    { prefix: "/my-prompts", title: "我的提示词" },
    { prefix: "/works", title: "我的作品" },
    { prefix: "/billing/checkout", title: "支付结算" },
    { prefix: "/billing/success", title: "支付完成" },
    { prefix: "/billing/cancel", title: "支付取消" },
    { prefix: "/billing", title: "账单中心" },
    { prefix: "/image", title: "图片生成" },
    { prefix: "/video", title: "视频生成" },
    { prefix: "/admin/setup", title: "后台初始化" },
    { prefix: "/admin/billing", title: "财务管理" },
    { prefix: "/admin/generation-operations", title: "生成运维" },
    { prefix: "/admin", title: "管理后台" },
];

export function pageTitleForPath(pathname: string, siteTitle: unknown = DEFAULT_SITE_TITLE) {
    const title = resolveSiteTitle(siteTitle);
    const path = pathname.replace(/\/$/, "") || "/";
    if (path === "/") return title;
    const matches = (prefix: string) => path === prefix || path.startsWith(prefix.endsWith("/") ? prefix : prefix + "/");
    // 最长前缀优先，保证 /canvas/ 不会先命中 /canvas
    const label = [...PAGE_TITLE_RULES].sort((left, right) => right.prefix.length - left.prefix.length).find((rule) => matches(rule.prefix))?.title;
    return label ? `${label} | ${title}` : `页面不存在 | ${title}`;
}
