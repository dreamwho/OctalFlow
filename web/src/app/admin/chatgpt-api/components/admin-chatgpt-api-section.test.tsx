import { App } from "antd";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AdminChatGptApiSection } from "./admin-chatgpt-api-section";

function renderSection() {
    return renderToStaticMarkup(createElement(App, null, createElement(AdminChatGptApiSection, { controller: { setSettings: () => undefined } as never })));
}

describe("AdminChatGptApiSection", () => {
    it("renders six accessible tabs and reuses the shared request log panel", () => {
        const markup = renderSection();

        expect(markup).toContain('aria-label="账号与渠道"');
        expect(markup).toContain('aria-label="反代网关与 API 密钥"');
        expect(markup).toContain('aria-label="魔法代理"');
        expect(markup).toContain('aria-label="请求日志"');
        expect(markup).toContain('aria-label="统计报表"');
        expect(markup).toContain('aria-label="代理管理"');
        expect(markup).toContain("data-chatgpt-proxy-runtime-master");
        expect(markup).toContain('aria-label="使用代理"');
        expect(markup).toContain("max-sm:[&amp;_.ant-tabs-nav-list]:w-full");
        expect(markup).toContain("max-sm:[&amp;_.ant-tabs-tab]:flex-1");
        expect(markup).toMatch(/<div(?=[^>]*data-chatgpt-api-tab-panel="overview")(?=[^>]*class="space-y-4")/);
        expect(markup).toMatch(/<div(?=[^>]*data-chatgpt-api-tab-panel="gateway")(?=[^>]*class="hidden")/);
        expect(markup.indexOf('data-chatgpt-api-tab-panel="gateway"')).toBeLessThan(markup.indexOf(">反代网关</h2>"));
        expect(markup.indexOf(">反代网关</h2>")).toBeLessThan(markup.indexOf(">API 密钥</h2>"));
        expect(markup).not.toContain('data-chatgpt-api-tab-panel="proxy"');
        expect(markup).not.toContain('data-chatgpt-api-tab-panel="proxy-management"');
        expect(markup).not.toContain('data-chatgpt-api-tab-panel="ipwo"');
        expect(markup).not.toContain('aria-label="IPWO 配置"');
        expect(markup).not.toContain("ChatGPTAPI · 魔法代理");
    });
});
