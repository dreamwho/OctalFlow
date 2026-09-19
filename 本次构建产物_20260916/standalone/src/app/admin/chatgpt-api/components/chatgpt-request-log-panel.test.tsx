import { App } from "antd";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ChatGptRequestLogPanel } from "./chatgpt-request-log-panel";

function renderPanel() {
    return renderToStaticMarkup(createElement(App, null, createElement(ChatGptRequestLogPanel)));
}

describe("ChatGptRequestLogPanel", () => {
    it("replicates the existing request log model with filters, rows and pagination", () => {
        const markup = renderPanel();

        expect(markup).toContain(">请求日志</h2>");
        expect(markup).toContain("点击整行查看完整请求详情和过程日志");
        expect(markup).toContain("模型 / 账号 / 接口 / 错误");
        expect(markup).toContain("全部状态");
        expect(markup).toContain("查 询");
        expect(markup).toContain("暂无请求日志");
    });
});
