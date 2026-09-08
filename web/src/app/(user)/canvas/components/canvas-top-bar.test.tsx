import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useThemeStore } from "@/stores/use-theme-store";
import { CanvasTopBar } from "./canvas-top-bar";

vi.mock("@/components/layout/user-status-actions", () => ({ UserStatusActions: () => null }));

const noop = () => undefined;

function renderTopBar() {
    return renderToStaticMarkup(
        <CanvasTopBar
            title="画布 1"
            projectId="canvas-1"
            projectSummaries={[{ id: "canvas-1", title: "画布 1", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", nodeCount: 0, connectionCount: 0 }]}
            titleDraft="画布 1"
            isTitleEditing={false}
            onTitleDraftChange={noop}
            onStartTitleEditing={noop}
            onFinishTitleEditing={noop}
            onCancelTitleEditing={noop}
            onSwitchProject={noop}
            canUndo={false}
            canRedo={false}
            onWorkbench={noop}
            onDeleteProject={noop}
            onImportImage={noop}
            onUndo={noop}
            onRedo={noop}
            assetsOpen={false}
            onToggleAssets={noop}
            agentOpen={false}
            onToggleAgent={noop}
        />,
    );
}

describe("CanvasTopBar", () => {
    beforeEach(() => useThemeStore.setState({ theme: "light" }));

    it("renders compact named controls instead of static brand and asset navigation", () => {
        const markup = renderTopBar();

        expect(markup).toContain('class="canvas-topbar pointer-events-none absolute inset-x-0 top-0 z-50 flex items-start');
        expect(markup).not.toContain("backdrop-blur-xl");
        expect(markup).not.toContain("border-b");
        expect(markup).toContain('aria-label="打开画布菜单"');
        expect(markup).toContain('aria-label="修改画布名称：画布 1"');
        expect(markup).toContain('aria-label="切换画布"');
        expect(markup).toContain('aria-expanded="false"');
        expect(markup).toContain('aria-label="打开资产面板"');
        expect(markup).toContain('aria-pressed="false"');
        expect(markup).not.toContain('aria-label="OctalFlow"');
        expect(markup).not.toContain(">资产<");
    });
});
