import { describe, expect, it } from "vitest";

import { pageTitleForPath } from "./page-titles";

describe("pageTitleForPath", () => {
    it.each([
        ["/", "dreamyo"],
        ["/create", "创作工作台 | dreamyo"],
        ["/assets", "素材库 | dreamyo"],
        ["/canvas", "我的项目 | dreamyo"],
        ["/canvas/demo", "无限画布 | dreamyo"],
        ["/drama", "短剧项目 | dreamyo"],
        ["/drama/demo", "短剧生产 | dreamyo"],
        ["/admin", "管理后台 | dreamyo"],
        ["/admin/setup", "后台初始化 | dreamyo"],
        ["/admin/billing", "财务管理 | dreamyo"],
        ["/admin/generation-operations", "生成运维 | dreamyo"],
        ["/login", "登录 | dreamyo"],
        ["/register", "注册 | dreamyo"],
        ["/forgot-password", "找回密码 | dreamyo"],
        ["/install", "安装向导 | dreamyo"],
        ["/announcements", "网站公告 | dreamyo"],
        ["/gallery", "作品广场 | dreamyo"],
        ["/community", "创意社区 | dreamyo"],
        ["/privacy", "隐私政策 | dreamyo"],
        ["/terms", "服务条款 | dreamyo"],
        ["/share/example", "作品分享 | dreamyo"],
        ["/u/example", "创作者主页 | dreamyo"],
        ["/image", "图片生成 | dreamyo"],
        ["/video", "视频生成 | dreamyo"],
        ["/billing", "账单中心 | dreamyo"],
        ["/billing/checkout", "支付结算 | dreamyo"],
        ["/billing/success", "支付完成 | dreamyo"],
        ["/billing/cancel", "支付取消 | dreamyo"],
        ["/help", "帮助中心 | dreamyo"],
        ["/me", "我的账户 | dreamyo"],
        ["/profile", "个人资料 | dreamyo"],
        ["/prompts", "提示词库 | dreamyo"],
        ["/my-prompts", "我的提示词 | dreamyo"],
        ["/works", "我的作品 | dreamyo"],
    ])("maps %s to %s", (pathname, expected) => {
        expect(pageTitleForPath(pathname)).toBe(expected);
    });

    it("keeps not-found titles visible after client navigation", () => {
        expect(pageTitleForPath("/unknown-route")).toBe("页面不存在 | dreamyo");
    });
});
