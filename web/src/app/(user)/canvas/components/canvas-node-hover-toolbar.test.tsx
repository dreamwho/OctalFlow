import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";

import { useThemeStore } from "@/stores/use-theme-store";
import { CanvasNodeType, type CanvasNodeData } from "../types";
import { CanvasNodeHoverToolbar } from "./canvas-node-hover-toolbar";

const imageNode: CanvasNodeData = {
    id: "toolbar-image",
    type: CanvasNodeType.Image,
    title: "图片生成",
    position: { x: 120, y: 80 },
    width: 340,
    height: 240,
    metadata: { content: "/api/reference-assets/permanent/generated-image.png" },
};

const noop = () => undefined;

function renderToolbar(node = imageNode) {
    return renderToStaticMarkup(
        <CanvasNodeHoverToolbar
            node={node}
            viewport={{ x: 0, y: 0, k: 1 }}
            onKeep={noop}
            onLeave={noop}
            onInfo={noop}
            onRename={noop}
            onEditText={noop}
            onDecreaseFont={noop}
            onIncreaseFont={noop}
            onToggleDialog={noop}
            onGenerateImage={noop}
            onUpload={noop}
            onDownload={noop}
            onSaveAsset={noop}
            onMaskEdit={noop}
            onCrop={noop}
            onSplit={noop}
            onUpscale={noop}
            onSuperResolve={noop}
            onAngle={noop}
            onStoryboard={noop}
            onViewImage={noop}
            onReversePrompt={noop}
            onRetry={noop}
            onToggleFreeResize={noop}
            onDelete={noop}
        />,
    );
}

describe("CanvasNodeHoverToolbar", () => {
    beforeEach(() => useThemeStore.setState({ theme: "light" }));

    it("shows the node-name action as a stable image toolbar control", () => {
        const markup = renderToolbar();

        expect(markup).toContain("data-canvas-node-toolbar");
        expect(markup).toContain('aria-label="编辑节点名称"');
        expect(markup).not.toContain("data-canvas-hover-toolbar");
    });

    it("shows capture, depth, and analysis tools for a populated video node", () => {
        const markup = renderToolbar({ ...imageNode, id: "video", type: CanvasNodeType.Video, metadata: { content: "/api/reference-assets/video.mp4" } });

        expect(markup).toContain('aria-label="捕捉视频帧"');
        expect(markup).toContain('aria-label="提取深度视频"');
        expect(markup).toContain('aria-label="详细分析视频"');
    });

    it("exposes 分镜大师 only for an image node with content", () => {
        expect(renderToolbar()).toContain("data-canvas-storyboard-trigger");
        expect(renderToolbar({ ...imageNode, metadata: {} })).not.toContain("data-canvas-storyboard-trigger");
        expect(renderToolbar({ ...imageNode, id: "video", type: CanvasNodeType.Video, metadata: { content: "/api/reference-assets/video.mp4" } })).not.toContain("data-canvas-storyboard-trigger");
    });
});
