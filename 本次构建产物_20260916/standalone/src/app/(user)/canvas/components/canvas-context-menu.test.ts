import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { CanvasNodeContextMenu, canArrangeCanvasSelection, clampCanvasContextMenuPosition } from "./canvas-context-menu";

describe("Canvas context menu positioning", () => {
    it("keeps the measured menu inside every viewport edge", () => {
        expect(clampCanvasContextMenuPosition({ x: 390, y: 820 }, { width: 176, height: 84 }, { width: 390, height: 844 })).toEqual({ x: 206, y: 752 });
        expect(clampCanvasContextMenuPosition({ x: -20, y: -10 }, { width: 176, height: 84 }, { width: 390, height: 844 })).toEqual({ x: 8, y: 8 });
    });

    it("shows 图片超分 only for eligible image nodes", () => {
        const props = { menu: { type: "node", x: 20, y: 20, nodeId: "image" } as const, onClose: () => undefined, onDuplicate: () => undefined, onDelete: () => undefined, onRename: () => undefined, onUpscale: () => undefined };
        expect(renderToStaticMarkup(createElement(CanvasNodeContextMenu, { ...props, canUpscale: true }))).toContain("图片超分");
        expect(renderToStaticMarkup(createElement(CanvasNodeContextMenu, props))).not.toContain("图片超分");
    });

    it("shows 一键整理 only when the right-clicked node remains in a multi-selection", () => {
        const menu = { type: "node", x: 20, y: 20, nodeId: "selected" } as const;
        const props = { menu, onClose: () => undefined, onDuplicate: () => undefined, onDelete: () => undefined, onRename: () => undefined, onArrange: () => undefined };

        expect(canArrangeCanvasSelection(menu, new Set(["selected", "other"]))).toBe(true);
        expect(canArrangeCanvasSelection(menu, new Set(["other", "another"]))).toBe(false);
        expect(canArrangeCanvasSelection(menu, new Set(["selected"]))).toBe(false);
        expect(renderToStaticMarkup(createElement(CanvasNodeContextMenu, { ...props, canArrange: true }))).toContain("一键整理");
        expect(renderToStaticMarkup(createElement(CanvasNodeContextMenu, props))).not.toContain("一键整理");
    });

    it("shows 室内设计 only for an eligible image node", () => {
        const props = { menu: { type: "node", x: 20, y: 20, nodeId: "image" } as const, onClose: () => undefined, onDuplicate: () => undefined, onDelete: () => undefined, onRename: () => undefined, onInteriorDesign: () => undefined };

        expect(renderToStaticMarkup(createElement(CanvasNodeContextMenu, { ...props, canInteriorDesign: true }))).toContain("室内设计");
        expect(renderToStaticMarkup(createElement(CanvasNodeContextMenu, props))).not.toContain("室内设计");
    });

    it("shows 人物三视图 only for an eligible image node", () => {
        const props = { menu: { type: "node", x: 20, y: 20, nodeId: "image" } as const, onClose: () => undefined, onDuplicate: () => undefined, onDelete: () => undefined, onRename: () => undefined, onStoryboard: () => undefined };

        const markup = renderToStaticMarkup(createElement(CanvasNodeContextMenu, { ...props, canStoryboard: true }));
        expect(markup).toContain("分镜大师");
        expect(markup).toContain('aria-haspopup="menu"');
        expect(renderToStaticMarkup(createElement(CanvasNodeContextMenu, props))).not.toContain("分镜大师");
    });

    it("keeps the context menu above prompt and agent overlays", () => {
        const props = { menu: { type: "node", x: 20, y: 20, nodeId: "image" } as const, onClose: () => undefined, onDuplicate: () => undefined, onDelete: () => undefined, onRename: () => undefined };
        expect(renderToStaticMarkup(createElement(CanvasNodeContextMenu, props))).toContain("z-[110]");
    });

    it("shows the three video tools only for an eligible video node", () => {
        const props = { menu: { type: "node", x: 20, y: 20, nodeId: "video" } as const, onClose: () => undefined, onDuplicate: () => undefined, onDelete: () => undefined, onRename: () => undefined };
        const videoMarkup = renderToStaticMarkup(createElement(CanvasNodeContextMenu, { ...props, canUseVideoTools: true }));

        expect(videoMarkup).toContain("捕捉帧");
        expect(videoMarkup).toContain("深度提取");
        expect(videoMarkup).toContain("分析");
        expect(renderToStaticMarkup(createElement(CanvasNodeContextMenu, props))).not.toContain("深度提取");
    });
});
