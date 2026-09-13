import { DEFAULT_SITE_TITLE, resolveSiteTitle } from "@/lib/site-brand";

export function pageTitleForPath(pathname: string, siteTitle: unknown = DEFAULT_SITE_TITLE) {
    const title = resolveSiteTitle(siteTitle);
    const path = pathname.replace(/\/$/, "") || "/";
    const label =
        path === "/" ? "" :
        path === "/login" ? "登录" :
        path === "/register" ? "注册" :
        path === "/forgot-password" ? "找回密码" :
        path === "/install" ? "安装向导" :
        path === "/announcements" ? "网站公告" :
        path === "/gallery" || path === "/community" ? "作品广场" :
        path === "/privacy" ? "隐私政策" :
        path === "/terms" ? "服务条款" :
        path.startsWith("/share/") ? "作品分享" :
        path.startsWith("/u/") ? "创作者主页" :
        path === "/create" ? "创作工作台" :
        path === "/assets" ? "资产库" :
        path === "/canvas" ? "Canvas 项目" :
        path.startsWith("/canvas/") ? "Canvas 画布" :
        path === "/drama" ? "短剧项目" :
        path.startsWith("/drama/") ? "短剧生产" :
        path === "/help" ? "帮助中心" :
        path === "/me" ? "我的账户" :
        path === "/profile" ? "个人资料" :
        path === "/prompts" ? "提示词库" :
        path === "/my-prompts" ? "我的提示词" :
        path === "/works" ? "我的作品" :
        path === "/billing" ? "账单中心" :
        path === "/billing/checkout" ? "支付结算" :
        path === "/billing/success" ? "支付完成" :
        path === "/billing/cancel" ? "支付取消" :
        path === "/image" ? "图片生成" :
        path === "/video" ? "视频生成" :
        path === "/admin/setup" ? "后台初始化" :
        path === "/admin/billing" ? "财务管理" :
        path === "/admin/generation-operations" ? "生成运维" :
        path.startsWith("/admin") ? "管理后台" :
        title;
    return label ? `${label} | ${title}` : title;
}
