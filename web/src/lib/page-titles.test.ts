import { describe, expect, it } from "vitest";

import { pageTitleForPath } from "./page-titles";

describe("pageTitleForPath", () => {
    it.each([
        ["/", "dreamyo"],
        ["/create", "创作工作台 | dreamyo"],
        ["/assets", "资产库 | dreamyo"],
        ["/canvas/demo", "Canvas 画布 | dreamyo"],
        ["/drama/demo", "短剧生产 | dreamyo"],
        ["/admin", "管理后台 | dreamyo"],
        ["/login", "登录 | dreamyo"],
        ["/share/example", "作品分享 | dreamyo"],
    ])("maps %s to %s", (pathname, expected) => {
        expect(pageTitleForPath(pathname)).toBe(expected);
    });
});
