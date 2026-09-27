import { App } from "antd";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AdminMinimaxH3Section } from "./admin-minimax-h3-section";
import type { AdminDashboardController } from "./use-admin-dashboard-controller";

const fetchMock = vi.fn();

function createFakeController(): AdminDashboardController {
    return {
        settings: {
            systemChannels: [
                {
                    id: "easyframe-minimax-h3",
                    name: "easyframe MiniMaxH3",
                    baseUrl: "https://minimax.api.easyframe.cn",
                    apiKey: "",
                    apiFormat: "openai",
                    models: ["minimax-h3-mini", "minimax-h3-fast", "minimax-h3-base", "minimax-h3-pro"],
                    enabled: true,
                },
            ],
            logicalModels: [],
        } as never,
        setSettings: vi.fn(),
        saveSettings: vi.fn(async () => true),
        settingsLoading: false,
    } as unknown as AdminDashboardController;
}

function renderSection(controller = createFakeController()) {
    return renderToStaticMarkup(createElement(App, null, createElement(AdminMinimaxH3Section, { controller })));
}

describe("AdminMinimaxH3Section", () => {
    beforeEach(() => {
        vi.stubGlobal("fetch", fetchMock);
        fetchMock.mockResolvedValue(
            new Response(
                JSON.stringify({
                    channel: {
                        id: "easyframe-minimax-h3",
                        name: "easyframe MiniMaxH3",
                        baseUrl: "https://minimax.api.easyframe.cn",
                        apiKey: "",
                        hasApiKey: true,
                        models: ["minimax-h3-mini", "minimax-h3-fast", "minimax-h3-base", "minimax-h3-pro"],
                        enabled: true,
                    },
                    defaultBaseUrl: "https://minimax.api.easyframe.cn",
                    logicalModels: [
                        {
                            id: "minimax-h3-mini",
                            name: "minimax-h3-mini",
                            capability: "video",
                            enabled: true,
                            resolvable: true,
                            resolvedChannel: { id: "easyframe-minimax-h3", name: "easyframe MiniMaxH3" },
                            isBoundToChannel: true,
                            bindingsCount: 1,
                        },
                    ],
                    modelMetas: [
                        {
                            id: "minimax-h3-mini",
                            label: "minimax-h3-mini",
                            tier: "极速档",
                            description: "轻量极速模型",
                            suggestedUse: "分镜试拍",
                            resolutions: ["480p", "720p"],
                            duration: "5-15 秒",
                            supportedModes: ["文生视频 (t2va)"],
                        },
                    ],
                    videoTasks: {
                        items: [],
                        total: 0,
                        page: 1,
                        pageSize: 20,
                    },
                }),
                { status: 200, headers: { "content-type": "application/json" } },
            ),
        );
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        fetchMock.mockReset();
    });

    it("renders the MiniMax H3 dedicated admin panel with credentials, model switches and tabs", () => {
        const markup = renderSection();
        expect(markup).toContain("easyframe MiniMax H3 视频控制台");
        expect(markup).toContain("测试连通性");
        expect(markup).toContain("启用 easyframe MiniMaxH3 渠道");
        expect(markup).toContain("模型可用性开关");
        expect(markup).toContain("minimax-h3-mini");
        expect(markup).toContain("minimax-h3-fast");
        expect(markup).toContain("minimax-h3-base");
        expect(markup).toContain("minimax-h3-pro");
        expect(markup).toContain("模型与参数规格");
        expect(markup).toContain("视频任务历史");
        expect(markup).toContain("MiniMax H3 素材输入规范契约");
    });
});
