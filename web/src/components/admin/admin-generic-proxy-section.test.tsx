import { App } from "antd";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AdminGenericProxySection } from "./admin-generic-proxy-section";

const fetchMock = vi.fn();

function renderSection() {
    return renderToStaticMarkup(createElement(App, null, createElement(AdminGenericProxySection)));
}

describe("AdminGenericProxySection", () => {
    beforeEach(() => {
        vi.stubGlobal("fetch", fetchMock);
        fetchMock.mockResolvedValue(new Response(JSON.stringify({ code: 0, data: { groups: [], default_reference: { mode: "direct" }, fallback_reference: null, effective_default: { label: "直接连接" }, effective_fallback: { label: "关闭回退" }, revision: "1" }, msg: "OK" }), { status: 200 }));
    });
    afterEach(() => {
        vi.unstubAllGlobals();
        fetchMock.mockReset();
    });

    it("renders the shared manager without per-surface defaults and links both tabs", () => {
        const markup = renderSection();
        expect(markup).toContain("通用代理是多表面共享的代理出口池");
        expect(markup).toContain("data-chatgpt-proxy-manager");
        expect(markup).toContain("代理管理");
        expect(markup).toContain("请求日志");
        expect(markup).not.toContain("data-chatgpt-proxy-runtime-control");
        expect(markup).not.toContain('aria-label="默认出口"');
    });
});
