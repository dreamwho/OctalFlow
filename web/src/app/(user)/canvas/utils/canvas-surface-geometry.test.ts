import { describe, expect, it } from "vitest";

import { CanvasNodeType, type CanvasNodeData } from "../types";
import { CANVAS_GRID_SIZE, CANVAS_NODE_GAP, edgePath, expandCanvasDragNodeIds, findConnectionTarget, isBlockedConnectionDrop, nodeAnchor, previewPath, resolveCanvasNodePlacement, resolveCanvasNodePointerSelection, resolveCanvasSelectionLayout, resolvePromptComposerOverlay, resolveSnapGuides, samePosition, selectNodesInBounds, worldFromScreen } from "./canvas-surface-geometry";

const source: CanvasNodeData = { id: "source", type: CanvasNodeType.Text, title: "来源", position: { x: 100, y: 120 }, width: 240, height: 160, metadata: {} };
const target: CanvasNodeData = { id: "target", type: CanvasNodeType.Image, title: "目标", position: { x: 500, y: 220 }, width: 300, height: 200, metadata: {} };

describe("canvas surface geometry", () => {
    it("converts screen coordinates through the viewport transform", () => {
        expect(worldFromScreen(330, 250, { x: 80, y: 40, k: 2 }, { left: 10, top: 10 })).toEqual({ x: 120, y: 100 });
    });

    it("uses node-side centers as connection anchors", () => {
        expect(nodeAnchor(source, "source")).toEqual({ x: 340, y: 200 });
        expect(nodeAnchor(target, "target")).toEqual({ x: 500, y: 320 });
        expect(edgePath(source, target)).toBe("M 340 200 C 420 200, 420 320, 500 320");
    });

    it("uses two background grid cells for new-node spacing", () => {
        expect(CANVAS_GRID_SIZE).toBe(22);
        expect(CANVAS_NODE_GAP).toBe(CANVAS_GRID_SIZE * 2);
    });

    it("places toolbar-created nodes beside the node nearest the viewport center with a two-cell gap", () => {
        const placement = resolveCanvasNodePlacement([source, target], { width: 340, height: 240 }, { x: 220, y: 200 });

        expect(placement).toEqual({ x: source.position.x, y: source.position.y + source.height + CANVAS_NODE_GAP });
    });

    it("uses the most recently created surrounding node when the center node has no free side", () => {
        const right = { ...target, id: "right", position: { x: 406, y: 120 }, width: 200, height: 160 };
        const bottom = { ...target, id: "bottom", position: { x: 100, y: 346 }, width: 240, height: 160 };
        const left = { ...target, id: "left", position: { x: -206, y: 120 }, width: 240, height: 160 };
        const top = { ...target, id: "top", position: { x: 100, y: -106 }, width: 240, height: 160 };
        const placement = resolveCanvasNodePlacement([source, right, bottom, left, top], { width: 200, height: 160 }, { x: 220, y: 200 });

        expect(placement).toEqual({ x: 384, y: -106 });
    });

    it("keeps close horizontal connections as short forward curves instead of looping", () => {
        const nearTarget = { ...target, position: { x: 350, y: 220 }, width: 300, height: 200 };
        const path = edgePath(source, nearTarget);

        expect(path).toContain(" C ");
        expect(path).not.toContain(" Q ");
        expect(path).not.toContain("-32");
    });

    it("routes backward connections as a short free-angle curve without detours", () => {
        const lowerTarget = { ...target, position: { x: 320, y: 280 }, width: 340, height: 240 };
        const shorterSource = { ...source, position: { x: 0, y: 0 }, width: 340, height: 210 };
        const path = edgePath(shorterSource, lowerTarget);

        expect(path).toBe("M 340 105 C 350 105, 310 400, 320 400");
    });

    it("routes overlapping backward connections with a smooth curve outside the nodes", () => {
        const from = { ...source, position: { x: 0, y: 0 }, width: 340, height: 240 };
        const to = { ...target, position: { x: 280, y: 80 }, width: 340, height: 240 };
        const path = edgePath(from, to);

        expect(path).toBe("M 340 120 C 370 120, 250 200, 280 200");
    });

    it("builds previews in the direction of the active handle", () => {
        expect(previewPath({ x: 0, y: 20 }, { x: 100, y: 60 }, "source")).toBe("M 0 20 C 50 20, 50 60, 100 60");
        expect(previewPath({ x: 100, y: 60 }, { x: 0, y: 20 }, "target")).toBe("M 100 60 C 50 60, 50 20, 0 20");
        expect(previewPath({ x: 100, y: 60 }, { x: 160, y: 20 }, "target")).toBe("M 100 60 C 70 60, 190 20, 160 20");
    });

    it("keeps the composer at a fixed visual size and centered below the active node", () => {
        const media = { ...target, position: { x: 668, y: 120 }, width: 200, height: 100 };
        expect(resolvePromptComposerOverlay(media, { x: 0, y: 0, k: 1 }, { width: 1536, height: 927 })).toEqual({ left: 438, top: 236, width: 660, height: 232 });
        expect(resolvePromptComposerOverlay(media, { x: 537.6, y: 84, k: 0.3 }, { width: 1536, height: 927 })).toEqual({ left: 438, top: 166, width: 660, height: 232 });
    });

    it("keeps the fixed composer inside narrow viewports without adding a tether", () => {
        expect(resolvePromptComposerOverlay(target, { x: 0, y: 0, k: 1 }, { width: 390, height: 320 })).toEqual({ left: 12, top: 76, width: 366, height: 232 });
    });

    it("targets node bodies and nearby handles without selecting the origin", () => {
        expect(findConnectionTarget({ x: 510, y: 300 }, { nodeId: source.id, handleType: "source" }, [source, target], 1)).toBe(target.id);
        expect(findConnectionTarget({ x: 100, y: 200 }, { nodeId: source.id, handleType: "source" }, [source, target], 1)).toBeNull();
        expect(findConnectionTarget({ x: 449, y: 320 }, { nodeId: source.id, handleType: "source" }, [source, target], 1)).toBe(target.id);
    });

    it("blocks connection creation menus on the origin and invalid config sources", () => {
        const config = { ...target, id: "config", type: CanvasNodeType.Config };

        expect(isBlockedConnectionDrop({ x: 110, y: 180 }, { nodeId: source.id, handleType: "source" }, [source, config], 1)).toBe(true);
        expect(findConnectionTarget({ x: 510, y: 300 }, { nodeId: source.id, handleType: "target" }, [source, config], 1)).toBeNull();
        expect(isBlockedConnectionDrop({ x: 510, y: 300 }, { nodeId: source.id, handleType: "target" }, [source, config], 1)).toBe(true);
        expect(isBlockedConnectionDrop({ x: 900, y: 700 }, { nodeId: source.id, handleType: "source" }, [source, config], 1)).toBe(false);
    });

    it("tolerates subpixel position differences only", () => {
        expect(samePosition({ x: 10, y: 20 }, { x: 10.005, y: 20.005 })).toBe(true);
        expect(samePosition({ x: 10, y: 20 }, { x: 10.02, y: 20 })).toBe(false);
    });

    it("adds box hits to an existing multi-selection", () => {
        expect(selectNodesInBounds([source, target], { x: 450, y: 180 }, { x: 820, y: 440 }, [source.id])).toEqual(new Set([source.id, target.id]));
    });

    it("does not replace a multi-selection when a selected node receives right-button mousedown", () => {
        const selected = new Set([source.id, target.id]);

        expect(resolveCanvasNodePointerSelection(selected, source.id, 2, false)).toBeNull();
        expect(selected).toEqual(new Set([source.id, target.id]));
        expect(resolveCanvasNodePointerSelection(selected, "another", 0, false)).toEqual(new Set(["another"]));
    });

    it("moves hidden image-batch children with the selected root", () => {
        const root = { ...source, metadata: { batchChildIds: ["child-a", "child-b"] } };
        expect(expandCanvasDragNodeIds([root, target], [root.id, target.id])).toEqual([root.id, target.id, "child-a", "child-b"]);
    });

    it("arranges selected root nodes by type and content using their real boxes and a two-cell gap", () => {
        const imageA = { ...target, id: "image-a", title: "A 图", position: { x: 720, y: 480 }, width: 280, height: 160, metadata: { content: "a" } };
        const imageB = { ...target, id: "image-b", title: "B 图", position: { x: -100, y: 80 }, width: 180, height: 280, metadata: { content: "b" } };
        const text = { ...source, id: "text", position: { x: 240, y: -40 }, width: 360, height: 120, metadata: { content: "文字" } };
        const batchChild = { ...target, id: "batch-child", position: { x: 1000, y: 1000 }, metadata: { batchRootId: imageA.id, content: "不参与" } };
        const nodes = [text, imageB, batchChild, imageA];
        const first = resolveCanvasSelectionLayout(nodes, nodes.map((node) => node.id));
        const second = resolveCanvasSelectionLayout(nodes, nodes.map((node) => node.id));
        const byId = new Map(first.map((item) => [item.id, item.position]));

        expect(first).toEqual(second);
        expect(byId.has(batchChild.id)).toBe(false);
        expect(byId.get(imageA.id)).toEqual({ x: -100, y: -40 });
        expect(byId.get(imageB.id)?.x).toBe(byId.get(imageA.id)!.x + imageA.width + CANVAS_NODE_GAP);
        expect(byId.get(text.id)?.y).toBe(Math.max(byId.get(imageA.id)!.y + imageA.height, byId.get(imageB.id)!.y + imageB.height) + CANVAS_NODE_GAP);
        const roots = nodes.filter((node) => byId.has(node.id));
        roots.forEach((leftNode, index) => {
            roots.slice(index + 1).forEach((rightNode) => {
                const left = { ...leftNode, position: byId.get(leftNode.id)! };
                const right = { ...rightNode, position: byId.get(rightNode.id)! };
                const horizontalGap = Math.max(left.position.x, right.position.x) - Math.min(left.position.x + left.width, right.position.x + right.width);
                const verticalGap = Math.max(left.position.y, right.position.y) - Math.min(left.position.y + left.height, right.position.y + right.height);
                expect(horizontalGap >= CANVAS_NODE_GAP || verticalGap >= CANVAS_NODE_GAP).toBe(true);
            });
        });
    });

    it("snaps a dragged node's top edge to another node's top edge", () => {
        const result = resolveSnapGuides([{ x: 100, y: 100, width: 200, height: 100 }], [{ x: 500, y: 120, width: 200, height: 100 }], 30);

        expect(result.dx).toBe(0);
        expect(result.dy).toBe(20);
        expect(result.guides).toEqual([{ orientation: "horizontal", position: 120, start: 100, end: 700 }]);
    });

    it("snaps a dragged node's left edge to another node's left edge", () => {
        const result = resolveSnapGuides([{ x: 90, y: 100, width: 200, height: 100 }], [{ x: 300, y: 400, width: 200, height: 100 }], 30);

        expect(result.dx).toBe(10);
        expect(result.dy).toBe(0);
        expect(result.guides).toEqual([{ orientation: "vertical", position: 300, start: 100, end: 500 }]);
    });

    it("does not snap when every candidate is beyond the threshold", () => {
        expect(resolveSnapGuides([{ x: 0, y: 0, width: 100, height: 100 }], [{ x: 500, y: 500, width: 100, height: 100 }], 10)).toEqual({ dx: 0, dy: 0, guides: [] });
    });

    it("does not snap when there are no static nodes to align against", () => {
        expect(resolveSnapGuides([{ x: 0, y: 0, width: 100, height: 100 }], [], 30)).toEqual({ dx: 0, dy: 0, guides: [] });
    });
});
