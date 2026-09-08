import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";

import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { CanvasNodeType, type CanvasNodeData } from "../types";
import { CanvasNode, resolveNodeMetaScale, resolveNodeResolutionOpacity, resolvePromptPanelLayout } from "./canvas-node";
import { NodeContent } from "./canvas-node-content";

const imageNode: CanvasNodeData = {
    id: "generated-image",
    type: CanvasNodeType.Image,
    title: "生成图片",
    position: { x: 120, y: 80 },
    width: 320,
    height: 320,
    metadata: { content: "/api/reference-assets/permanent/generated-image.png" },
};

const noop = () => undefined;

function renderImageNode(overrides: Partial<React.ComponentProps<typeof CanvasNode>> = {}) {
    return renderToStaticMarkup(
        <CanvasNode
            data={imageNode}
            scale={1}
            isSelected={false}
            isRelated={false}
            isFocusRelated={false}
            isConnectionTarget={false}
            isConnecting={false}
            showPanel={false}
            showImageInfo={false}
            onMouseDown={noop}
            onHoverStart={noop}
            onHoverEnd={noop}
            onConnectStart={noop}
            onResize={noop}
            onContentChange={noop}
            onTitleChange={noop}
            onContextMenu={noop}
            {...overrides}
        />,
    );
}

function renderContent(node: CanvasNodeData, theme: (typeof canvasThemes)[keyof typeof canvasThemes], isEditingContent = false) {
    return renderToStaticMarkup(
        <NodeContent
            node={node}
            theme={theme}
            isEditingContent={isEditingContent}
            textareaRef={{ current: null }}
            isBatchRoot={false}
            batchCount={0}
            batchExpanded={false}
            batchOpening={false}
            batchRecovering={false}
            onContentChange={noop}
            onStopEditing={noop}
            mentionReferences={[]}
        />,
    );
}

describe("CanvasNode image border", () => {
    beforeEach(() => useThemeStore.setState({ theme: "light" }));

    it("uses the themed card border for an idle generated image", () => {
        const markup = renderImageNode();

        expect(markup).toContain(`border-color:${canvasThemes.light.node.stroke}`);
        expect(markup).toContain("rounded-md border");
        expect(markup).toContain("overflow-hidden rounded-[inherit]");
        expect(markup).toContain("/api/reference-assets/permanent/generated-image.png?format=webp&amp;width=1920");
    });

    it("uses the cyan-to-violet flow border when the image is selected", () => {
        const markup = renderImageNode({ isSelected: true });

        expect(markup).toContain("data-canvas-node-selection-flow");
        expect(markup).toContain("border-color:transparent");
        expect(markup).not.toContain("0 0 0 1px rgba(103,232,249,.45)");
        expect(markup).toContain("#67e8f9");
        expect(markup).toContain("#818cf8");
        expect(markup).toContain("#c084fc");
        expect(markup).toContain('x="0.8" y="0.8" width="98.4" height="98.4"');
    });

    it("progressively reduces node title metadata after the canvas is zoomed out", () => {
        const markup = renderImageNode({ scale: 0.25 });

        expect(markup).toContain("data-canvas-node-title");
        expect(resolveNodeMetaScale(1)).toBe(1);
        expect(resolveNodeMetaScale(2)).toBe(1);
        expect(resolveNodeMetaScale(0.39)).toBeLessThan(resolveNodeMetaScale(0.7));
        expect(resolveNodeMetaScale(0.05)).toBe(0.38);
        expect(markup).not.toContain("font-size:72px");
        expect(markup).not.toContain("width:80px;height:80px");
    });

    it("keeps every node title in a compact line above its node", () => {
        for (const type of Object.values(CanvasNodeType)) {
            const markup = renderImageNode({ data: { ...imageNode, id: `title-${type}`, type, title: `${type}节点`, metadata: {} }, scale: 0.5 });

            expect(markup, type).toContain("data-canvas-node-title");
            expect(markup, type).toContain("data-canvas-node-title");
            expect(markup, type).not.toContain("line-height:40px");
        }
    });

    it("makes node titles keyboard-reachable inline edit controls", () => {
        const markup = renderImageNode();

        expect(markup).toContain("data-canvas-node-title");
        expect(markup).toContain("data-canvas-no-drag");
        expect(markup).toContain('aria-label="编辑节点标题：生成图片"');
        expect(markup).toContain('title="点击修改节点标题"');
    });

    it("shows image and video resolution only once the node has enough screen width", () => {
        const imageMarkup = renderImageNode({ data: { ...imageNode, metadata: { ...imageNode.metadata, naturalWidth: 3072, naturalHeight: 4096 } } });
        const videoMarkup = renderImageNode({ data: { ...imageNode, type: CanvasNodeType.Video, metadata: { content: "/api/reference-assets/permanent/video.mp4", naturalWidth: 1920, naturalHeight: 1080 } } });
        const compactMarkup = renderImageNode({ data: { ...imageNode, metadata: { ...imageNode.metadata, naturalWidth: 3072, naturalHeight: 4096 } }, scale: 0.5 });

        expect(imageMarkup).toContain("data-canvas-node-resolution");
        expect(imageMarkup).toContain("3072 × 4096");
        expect(imageMarkup).not.toContain("background:#fbfbfdaa");
        expect(videoMarkup).toContain("1920 × 1080");
        expect(compactMarkup).not.toContain("data-canvas-node-resolution");
        expect(resolveNodeResolutionOpacity(340, 0.5)).toBe(0);
        expect(resolveNodeResolutionOpacity(340, 1)).toBe(1);
    });

    it("opens a fixed-size prompt panel without drawing a connector line", () => {
        const markup = renderImageNode({ showPanel: true, renderPanel: () => <div>生成提示词</div> });

        expect(markup).toContain('data-canvas-prompt-connection="true"');
        expect(markup).toContain('data-canvas-prompt-placement="below"');
        expect(markup).not.toContain("canvas-panel-bridge");
        expect(markup).toContain("生成提示词");
    });

    it("keeps an opened prompt panel inside the viewport and flips it above a low node", () => {
        const panel = { left: 680, right: 1500, top: 620, bottom: 950, width: 820, height: 330 } as DOMRect;
        const node = { left: 900, right: 1220, top: 560, bottom: 800, width: 320, height: 240 } as DOMRect;

        expect(resolvePromptPanelLayout(panel, node, 970, 608)).toEqual({ horizontalCorrection: -546, verticalCorrection: 0, placement: "above" });
    });

    it("keeps the prompt panel reachable when neither side of the node has enough room", () => {
        const panel = { left: 58, right: 878, top: -133, bottom: 194, width: 820, height: 327 } as DOMRect;
        const node = { left: 410, right: 830, top: 222, bottom: 458, width: 420, height: 236 } as DOMRect;

        expect(resolvePromptPanelLayout(panel, node, 970, 608)).toEqual({ horizontalCorrection: 0, verticalCorrection: 177, placement: "above" });
    });

    it("keeps the muted highlight for a related image", () => {
        expect(renderImageNode({ isRelated: true })).toContain(`border-color:${canvasThemes.light.node.muted}`);
    });

    it("does not apply the related highlight to a batch child", () => {
        const batchChild = { ...imageNode, metadata: { ...imageNode.metadata, batchRootId: "batch-root" } };

        const markup = renderImageNode({ data: batchChild, isRelated: true });

        expect(markup).toContain(`class="relative h-full w-full overflow-visible rounded-md border" style="background:transparent;border-color:${canvasThemes.light.node.stroke}"`);
    });

    it("keeps resize hit areas safe for fast pointer drags", () => {
        const markup = renderImageNode();

        expect(markup).toContain('data-canvas-resize-corner="bottom-right"');
        expect(markup).toContain('style="touch-action:none;user-select:none"');
    });
});

describe("Canvas text node controls", () => {
    it("keeps complete text visible and exposes copy, menu, and expanded editing actions", () => {
        const textNode = { ...imageNode, id: "text-node", type: CanvasNodeType.Text, title: "视频分析", metadata: { content: "第一段\n第二段完整内容" } } satisfies CanvasNodeData;
        const markup = renderImageNode({ data: textNode });
        const editorMarkup = renderContent(textNode, canvasThemes.light, true);

        expect(markup).toContain("第一段\n第二段完整内容");
        expect(markup).toContain('aria-label="文本操作菜单"');
        expect(markup).toContain('aria-label="一键复制全文"');
        expect(markup).toContain('aria-label="展开文本"');
        expect(markup).toContain(`background:${canvasThemes.light.toolbar.panel}`);
        expect(editorMarkup).toContain('class="relative min-h-0 min-w-0 flex-1 w-full"');
        expect(markup).toContain('class="thin-scrollbar block min-h-0 min-w-0 flex-1 w-full overflow-y-auto');
    });
});

describe("CanvasNode task content", () => {
    it("uses theme-owned surfaces and borders for all nine node types", () => {
        const theme = canvasThemes.light;

        for (const type of Object.values(CanvasNodeType)) {
            const markup = renderImageNode({ data: { ...imageNode, id: `theme-${type}`, type, metadata: {} } });
            const expectedBackground = type === CanvasNodeType.Config ? theme.node.panel : theme.node.fill;

            expect(markup, type).toContain(`background:${expectedBackground}`);
            expect(markup, type).toContain(`border-color:${theme.node.stroke}`);
        }
    });

    it.each(["light", "dark"] as const)("passes explicit %s theme colors into all nine node renderers", (themeName) => {
        const theme = canvasThemes[themeName];

        for (const type of Object.values(CanvasNodeType)) {
            const markup = renderContent({ ...imageNode, id: `content-theme-${type}`, type, metadata: {} }, theme);
            const expectedColor =
                type === CanvasNodeType.Image || type === CanvasNodeType.Config ? theme.node.subtleText : type === CanvasNodeType.Panorama || type === CanvasNodeType.Video || type === CanvasNodeType.Audio ? theme.node.placeholder : theme.node.text;

            expect(markup, type).toContain(`color:${expectedColor}`);
        }
    });

    it("keeps long task text scrollable while preserving the footer", () => {
        const taskNode: CanvasNodeData = {
            ...imageNode,
            id: "task",
            type: CanvasNodeType.Task,
            title: "Agent 任务",
            height: 210,
            metadata: { agentTaskStatus: "completed", prompt: "很长的任务说明".repeat(30), agentTaskAttempts: 1 },
        };

        const markup = renderImageNode({ data: taskNode });

        expect(markup).toContain("thin-scrollbar min-h-0 flex-1 overflow-y-auto");
        expect(markup).toContain("mt-3 flex shrink-0");
    });

    it("keeps the player draggable via a transparent capture layer above the video", () => {
        const videoNode: CanvasNodeData = {
            ...imageNode,
            id: "video",
            type: CanvasNodeType.Video,
            title: "视频2",
            metadata: { content: "/api/reference-assets/permanent/generated-video.mp4" },
        };

        const markup = renderContent(videoNode, canvasThemes.light);

        expect(markup).toContain("<video");
        expect(markup).toContain("controls");
        expect(markup).toContain("cursor-grab");
    });

    it.each(["light", "dark"] as const)("keeps task states and supporting node chips readable in %s mode", (themeName) => {
        const theme = canvasThemes[themeName];
        const taskNode: CanvasNodeData = {
            ...imageNode,
            id: "task-theme",
            type: CanvasNodeType.Task,
            title: "Agent 任务",
            metadata: { agentTaskStatus: "running", prompt: "生成主题回归" },
        };
        const briefNode: CanvasNodeData = {
            ...imageNode,
            id: "brief-theme",
            type: CanvasNodeType.Brief,
            title: "创作简报",
            metadata: { agentBrief: { objective: "主题回归", deliverables: [{ type: "image", title: "主视觉", count: 1 }] } },
        };
        const brandNode: CanvasNodeData = {
            ...imageNode,
            id: "brand-theme",
            type: CanvasNodeType.BrandKit,
            title: "视觉方向",
            metadata: { brandKit: { summary: "主题回归", keywords: ["电影感"] } },
        };

        const taskMarkup = renderContent(taskNode, theme);
        const supportingMarkup = `${renderContent(briefNode, theme)}${renderContent(brandNode, theme)}`;

        expect(taskMarkup).toContain(`background:${theme.node.infoSurface}`);
        expect(taskMarkup).toContain(`border-color:${theme.node.infoBorder}`);
        expect(taskMarkup).toContain(`color:${theme.node.infoText}`);
        expect(supportingMarkup).toContain(`background:${theme.node.subtleSurface}`);
        expect(supportingMarkup).toContain(`color:${theme.node.subtleText}`);
        expect(taskMarkup).not.toContain(`background:${theme.toolbar.activeBg};color:${theme.node.text}`);
    });
});

describe("CanvasNode error content", () => {
    it("centers the error and retry action inside the node", () => {
        const failedNode: CanvasNodeData = { ...imageNode, metadata: { status: "error", errorDetails: "生成失败，请稍后重试" } };

        const markup = renderImageNode({ data: failedNode, onRetry: noop });

        expect(markup).toContain("h-full w-full flex-col items-center justify-center");
        expect(markup).toContain(`color:${canvasThemes.light.node.danger}`);
        expect(markup).toContain("生成失败，请稍后重试");
        expect(markup).toContain("重试");
    });

    it.each(["light", "dark"] as const)("wraps complete error copy in a themed %s error surface", (themeName) => {
        const theme = canvasThemes[themeName];
        const errorDetails = "即梦 CLI 参考图暂存失败：媒体上传请求被上游拒绝，请检查可用授权素材地址后再试。";
        const markup = renderContent({ ...imageNode, metadata: { status: "error", errorDetails } }, theme);

        expect(markup).toContain("data-canvas-node-error-details");
        expect(markup).toContain("whitespace-pre-wrap break-words");
        expect(markup).toContain(`background:${theme.node.dangerSurface}`);
        expect(markup).toContain(`border-color:${theme.node.dangerBorder}`);
        expect(markup).toContain(errorDetails);
    });

    it("keeps error copy and retry control readable when the canvas is zoomed out", () => {
        const failedNode: CanvasNodeData = { ...imageNode, metadata: { status: "error", errorDetails: "当前模型能力不满足参考素材或数量参数" } };

        const markup = renderImageNode({ data: failedNode, scale: 0.25, onRetry: noop });

        expect(markup).toContain("font-size:48px;line-height:80");
        expect(markup).toContain("height:128px");
        expect(markup).toContain("当前模型能力不满足参考素材或数量参数");
    });

    it("renders a cancelled terminal state without a retry action", () => {
        const cancelledNode: CanvasNodeData = { ...imageNode, metadata: { status: "cancelled", agentTaskStatus: "cancelled" } };

        const markup = renderImageNode({ data: cancelledNode, onRetry: noop });

        expect(markup).toContain("任务已取消");
        expect(markup).not.toContain("重试");
    });

    it("pauses tasks that need review without offering a new generation retry", () => {
        const reviewNode: CanvasNodeData = { ...imageNode, metadata: { status: "needs_review", errorDetails: "上游创建状态待确认" } };

        const markup = renderImageNode({ data: reviewNode, onRetry: noop });

        expect(markup).toContain("上游创建状态待确认");
        expect(markup).toContain("检查状态");
        expect(markup).not.toContain(">重试<");
    });
});

describe("CanvasNode loading content", () => {
    it("renders real progress in the top-left status without fabricating unavailable progress", () => {
        const markup = renderContent({ ...imageNode, metadata: { status: "loading", generationProgress: 6, generationStage: "深度推理" } }, canvasThemes.light);
        expect(markup).toContain('aria-label="生成中 6%"');
        expect(markup).toContain("left-4 right-4 top-4");
        expect(markup).toContain("深度推理");
    });
    it.each(Object.values(CanvasNodeType).filter((type) => type !== CanvasNodeType.Config))("fills a loading %s node with the shared video animation", (type) => {
        const markup = renderContent({ ...imageNode, id: `loading-${type}`, type, metadata: { status: "loading" } }, canvasThemes.light);

        expect(markup).toContain("data-canvas-node-loading");
        expect(markup).toContain('role="status"');
        expect(markup).toContain('aria-label="生成中 预计 1%"');
        expect(markup).toContain("/generation-smoke.webp");
        expect(markup).toContain("/animations/generation-loading-animation.mp4");
        expect(markup).toContain('autoPlay=""');
        expect(markup).toContain('muted=""');
        expect(markup).toContain('loop=""');
        expect(markup).toContain('playsInline=""');
        expect(markup).toContain('preload="metadata"');
        expect(markup.match(/<img[^>]+src="\/generation-smoke\.webp"/g)).toHaveLength(1);
        expect(markup).not.toContain("animate-spin");
    });

    it("keeps a status label readable after a node is zoomed out", () => {
        const markup = renderContent({ ...imageNode, metadata: { status: "loading" } }, canvasThemes.light);
        const zoomedOutMarkup = renderToStaticMarkup(
            <NodeContent
                node={{ ...imageNode, metadata: { status: "loading" } }}
                theme={canvasThemes.light}
                scale={0.25}
                isEditingContent={false}
                textareaRef={{ current: null }}
                isBatchRoot={false}
                batchCount={0}
                batchExpanded={false}
                batchOpening={false}
                batchRecovering={false}
                onContentChange={noop}
                onStopEditing={noop}
                mentionReferences={[]}
            />,
        );

        expect(markup).toContain("生成中");
        expect(zoomedOutMarkup).toContain("font-size:34px");
    });
});
