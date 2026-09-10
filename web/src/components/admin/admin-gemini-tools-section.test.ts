import { readFileSync } from "node:fs";
import { App } from "antd";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AdminGeminiToolsSection, visibleGeminiToolsQuotas } from "./admin-gemini-tools-section";

function renderGeminiToolsSection() {
    return renderToStaticMarkup(createElement(App, null, createElement(AdminGeminiToolsSection, { controller: { setSettings: () => undefined } as never })));
}

describe("visibleGeminiToolsQuotas", () => {
    it("keeps only three quotas and prioritizes recently active models", () => {
        const quotas = [
            { model: "model-a", displayName: "A", remainingPercent: 90 },
            { model: "model-b", displayName: "B", remainingPercent: 80 },
            { model: "model-c", displayName: "C", remainingPercent: 70 },
            { model: "model-d", displayName: "D", remainingPercent: 60 },
        ];
        expect(visibleGeminiToolsQuotas(quotas, ["model-d", "model-b"]).map((quota) => quota.model)).toEqual(["model-d", "model-b", "model-a"]);
    });

    it("renders persistent panels for the four responsive GeminiTools tabs", () => {
        const markup = renderGeminiToolsSection();

        expect(markup).toContain("账号与渠道");
        expect(markup).toContain("反代网关与 API 密钥");
        expect(markup).toContain("代理管理");
        expect(markup).toContain("请求日志");
        expect(markup).toContain("max-sm:[&amp;_.ant-tabs-nav-list]:w-full");
        expect(markup).toContain("max-sm:[&amp;_.ant-tabs-tab]:flex-1");
        expect(markup).toMatch(/<div(?=[^>]*data-gemini-tools-tab-panel="overview")(?=[^>]*class="space-y-4")/);
        expect(markup).toMatch(/<div(?=[^>]*data-gemini-tools-tab-panel="gateway")(?=[^>]*class="hidden")/);
        expect(markup).toMatch(/<div(?=[^>]*data-gemini-tools-tab-panel="magic-proxy")(?=[^>]*class="hidden")/);
        expect(markup).toMatch(/<div(?=[^>]*data-gemini-tools-tab-panel="logs")(?=[^>]*class="hidden")/);
        expect(markup.indexOf('data-gemini-tools-tab-panel="gateway"')).toBeLessThan(markup.indexOf(">反代与网关</h2>"));
        expect(markup.indexOf(">反代与网关</h2>")).toBeLessThan(markup.indexOf(">API 密钥</h2>"));
        expect(markup.indexOf('data-gemini-tools-tab-panel="magic-proxy"')).toBeLessThan(markup.indexOf(">GeminiTools · 代理管理</h2>"));
    });

    it("keeps request-log loading attached to its tab selection", () => {
        const source = readFileSync(new URL("./admin-gemini-tools-section.tsx", import.meta.url), "utf8");

        expect(source).toContain('if (next === "logs") void loadLogs()');
        expect(source).toContain('data-gemini-tools-tab-panel="logs"');
    });

    it("opens a detail drawer when a request log row is clicked", () => {
        const source = readFileSync(new URL("./admin-gemini-tools-section.tsx", import.meta.url), "utf8");

        expect(source).toContain("selectedLog");
        expect(source).toContain("onClick={() => setSelectedLog(log)}");
        expect(source).toContain('title="请求日志详情"');
        expect(source).toContain("requestPreview");
        expect(source).toContain("responsePreview");
    });

    it("offers explicit latest-model fetch and opt-in enable actions while marking unavailable saved choices", () => {
        const source = readFileSync(new URL("./admin-gemini-tools-section.tsx", import.meta.url), "utf8");

        expect(source).toContain("syncGeminiToolsModels");
        expect(source).toContain("获取最新模型");
        expect(source).toContain("获取并启用新模型");
        expect(source).toContain("当前渠道选择未改动");
        expect(source).toContain("上游当前未返回");
        expect(source).toContain("filter((model) => model.available)");
        expect(source).toContain("const availableModels = useMemo");
        expect(source).toContain("disabled={!availableModels.length}");
        expect(source).toContain("value={String(availableModels.length)}");
    });
});
