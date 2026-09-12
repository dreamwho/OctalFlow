import { readFileSync } from "node:fs";
import { App } from "antd";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AdminGeminiAiSection } from "./admin-geminiai-section";

function renderGeminiAiSection() {
    return renderToStaticMarkup(createElement(App, null, createElement(AdminGeminiAiSection)));
}

describe("AdminGeminiAiSection", () => {
    it("renders persistent panels for the four responsive GeminiAIStudio tabs", () => {
        const markup = renderGeminiAiSection();

        expect(markup).toContain("账号与渠道");
        expect(markup).toContain("反代网关与 API 密钥");
        expect(markup).toContain("代理管理");
        expect(markup).toContain("请求日志");
        expect(markup).toContain("max-sm:[&amp;_.ant-tabs-nav-list]:w-full");
        expect(markup).toMatch(/<div(?=[^>]*data-geminiai-tab-panel="gateway")(?=[^>]*class="hidden")/);
        expect(markup.indexOf('data-geminiai-tab-panel="gateway"')).toBeLessThan(markup.indexOf(">反代网关</h2>"));
        expect(markup.indexOf(">反代网关</h2>")).toBeLessThan(markup.indexOf(">API 密钥</h2>"));
    });

    it("exposes the external OpenAI-compatible gateway base URL and endpoint summary", () => {
        const markup = renderGeminiAiSection();

        expect(markup).toContain("/api/geminiai/v1");
        expect(markup).toContain("chat/completions");
        expect(markup).toContain("images/generations · images/edits");
        expect(markup).toContain("启用网关");
        expect(markup).toContain("尚未创建 API 密钥");
    });

    it("labels request-log sources so external submissions are distinguishable", () => {
        const source = readFileSync(new URL("./admin-geminiai-section.tsx", import.meta.url), "utf8");

        expect(source).toContain('"外部 API"');
        expect(source).toContain('"站内调用"');
        expect(source).toContain('"后台实测"');
        expect(source).toContain('{ value: "external", label: "外部 API" }');
    });
});
