const ROUTE_LOADING_LABELS: Array<[string, string]> = [
    ["/admin", "管理后台"],
    ["/canvas", "画布"],
    ["/create", "创作"],
    ["/drama", "短剧"],
    ["/image", "图片工作台"],
    ["/video", "视频工作台"],
    ["/gallery", "作品广场"],
    ["/community", "社区"],
    ["/profile", "个人中心"],
    ["/me", "个人中心"],
    ["/my-prompts", "我的提示词"],
    ["/prompts", "提示词库"],
    ["/assets", "素材库"],
    ["/works", "我的作品"],
    ["/billing", "账单"],
    ["/help", "帮助中心"],
    ["/login", "登录页"],
    ["/register", "注册页"],
];

export function resolveLoadingLabel(pathname: string | null | undefined, fallback: string) {
    if (pathname) {
        if (pathname === "/") return "首页";
        const hit = ROUTE_LOADING_LABELS.find(([prefix]) => pathname === prefix || pathname.startsWith(`${prefix}/`) || pathname.startsWith(`${prefix}?`));
        if (hit) return hit[1];
    }
    return fallback;
}
