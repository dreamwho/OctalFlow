import { describe, expect, it } from "vitest";

import { CanvasNodeType, type CanvasNodeData } from "../types";
import { edgePath, expandCanvasDragNodeIds, findConnectionTarget, isBlockedConnectionDrop, nodeAnchor, previewPath, resolvePromptComposerHeight, resolvePromptComposerTether, resolveSnapGuides, samePosition, selectNodesInBounds, worldFromScreen } from "./canvas-surface-geometry";

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

    it("tracks the active media node when the canvas viewport or node position changes", () => {
        const media = { ...target, position: { x: 100, y: 120 }, width: 200, height: 100 };
        const initial = resolvePromptComposerTether(media, { x: 80, y: 40, k: 0.5 }, { width: 1536, height: 927 });
        const moved = resolvePromptComposerTether({ ...media, position: { x: 300, y: 220 } }, { x: 80, y: 40, k: 0.5 }, { width: 1536, height: 927 });

        expect(initial).toEqual({ source: { x: 180, y: 150 }, target: { x: 768, y: 501 }, path: "M 180 150 C 180 270, 768 381, 768 501" });
        expect(moved?.source).toEqual({ x: 280, y: 200 });
        expect(moved?.target).toEqual(initial?.target);
        expect(resolvePromptComposerTether(media, { x: 0, y: 0, k: 1 }, { width: 390, height: 844 })).toBeNull();
    });

    it("clamps a resized composer and moves the tether target with its top edge", () => {
        const media = { ...target, position: { x: 100, y: 120 }, width: 200, height: 100 };
        expect(resolvePromptComposerHeight(927)).toBe(410);
        expect(resolvePromptComposerHeight(927, 440)).toBe(440);
        expect(resolvePromptComposerHeight(927, 1200)).toBe(775);
        expect(resolvePromptComposerHeight(927, 100)).toBe(330);
        expect(resolvePromptComposerTether(media, { x: 80, y: 40, k: 0.5 }, { width: 1536, height: 927 }, 440)?.target).toEqual({ x: 768, y: 471 });
        expect(resolvePromptComposerTether({ ...media, position: { x: 668, y: 353 } }, { x: 0, y: 0, k: 1 }, { width: 1536, height: 927 }, 440)?.path).toBe("M 768 453 C 768 460.56, 768 463.44, 768 471");
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

    it("moves hidden image-batch children with the selected root", () => {
        const root = { ...source, metadata: { batchChildIds: ["child-a", "child-b"] } };
        expect(expandCanvasDragNodeIds([root, target], [root.id, target.id])).toEqual([root.id, target.id, "child-a", "child-b"]);
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
