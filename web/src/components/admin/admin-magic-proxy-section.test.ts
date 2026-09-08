import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { formatMagicProxyDate } from "./admin-magic-proxy-section";

describe("magic proxy admin section", () => {
    it("formats an absent or invalid update time without exposing a secret", () => {
        expect(formatMagicProxyDate()).toBe("暂无");
        expect(formatMagicProxyDate("not-a-date")).toBe("not-a-date");
    });

    it("keeps subscription management separate from provider binding controls", () => {
        const source = readFileSync(new URL("./admin-magic-proxy-section.tsx", import.meta.url), "utf8");

        expect(source).toContain("importMagicProxySubscription");
        expect(source).toContain("refreshMagicProxySubscription");
        expect(source).toContain("<Input.Password");
        expect(source).toContain('autoComplete="new-password"');
        expect(source).toContain("导入/替换订阅");
        expect(source).toContain("YAML / 文本文件导入");
        expect(source).toContain('type="file"');
        expect(source).toContain("导入文件");
        expect(source).toContain("更新订阅地址");
        expect(source).toContain("runtimeAvailable");
        expect(source).toContain("state.groups.map");
        expect(source).toContain("state.nodes.map");
        expect(source).toContain("不展示订阅密钥或服务端信息");
        expect(source).not.toContain("MagicProxyBindingCard");
        expect(source).not.toContain("updateMagicProxyBinding");
    });
});
