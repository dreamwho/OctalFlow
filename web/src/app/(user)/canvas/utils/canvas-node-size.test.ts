import { describe, expect, it } from "vitest";

import { CanvasNodeType, type CanvasNodeData } from "../types";
import { fitCanvasImageNodeSize, fitNodeAspectRatio, nodeSizeFromRatio, resizeImageNodeToNaturalRatio, resizeNodeBox } from "./canvas-node-size";

const imageNode: CanvasNodeData = {
    id: "image",
    type: CanvasNodeType.Image,
    title: "图片",
    position: { x: 100, y: 200 },
    width: 340,
    height: 240,
    metadata: { content: "/image.png" },
};

describe("Canvas image node sizing", () => {
    it("fits a square image to a square frame without side gutters", () => {
        expect(fitNodeAspectRatio(1024, 1024, 340, 340)).toEqual({ width: 340, height: 340 });
    });

    it("keeps Agent ratio-specified nodes inside their configured bounds", () => {
        expect(fitCanvasImageNodeSize(1024, 1024)).toEqual({ width: 240, height: 240 });
        expect(fitCanvasImageNodeSize(8192, 6144)).toEqual({ width: 320, height: 240 });
        expect(fitCanvasImageNodeSize(1600, 900).width).toBeCloseTo(340, 3);
        expect(fitCanvasImageNodeSize(1600, 900).height).toBeCloseTo(191.25, 3);
        expect(fitCanvasImageNodeSize(900, 1600).width).toBeCloseTo(135, 3);
        expect(fitCanvasImageNodeSize(900, 1600).height).toBeCloseTo(240, 3);
        const landscape = nodeSizeFromRatio("16:9", 340, 240);
        const portrait = nodeSizeFromRatio("9:16", 340, 240);
        expect(landscape?.width).toBeCloseTo(340, 3);
        expect(landscape?.height).toBeCloseTo(191.25, 3);
        expect(portrait?.width).toBeCloseTo(135, 3);
        expect(portrait?.height).toBeCloseTo(240, 3);
    });

    it("keeps the node center while correcting a saved frame ratio", () => {
        const resized = resizeImageNodeToNaturalRatio(imageNode, 1024, 1024);

        expect(resized).toMatchObject({ width: 240, height: 240, position: { x: 150, y: 200 }, metadata: { naturalWidth: 1024, naturalHeight: 1024 } });
    });

    it("keeps natural-ratio correction inside the default image node frame", () => {
        const resized = resizeImageNodeToNaturalRatio(imageNode, 1600, 900);

        expect(resized).toMatchObject({ width: 340, height: 191.25, position: { x: 100, y: 224.375 }, metadata: { naturalWidth: 1600, naturalHeight: 900 } });
    });

    it("normalizes legacy generated nodes that already match the natural ratio", () => {
        const resized = resizeImageNodeToNaturalRatio({ ...imageNode, width: 426.6667, metadata: { ...imageNode.metadata, generationType: "generation" } }, 1600, 900);

        expect(resized).toMatchObject({ width: 340, height: 191.25, position: { x: 143.33335, y: 224.375 } });
    });

    it("preserves an intentional free-resize frame", () => {
        const resized = resizeImageNodeToNaturalRatio({ ...imageNode, metadata: { ...imageNode.metadata, freeResize: true } }, 1024, 1024);

        expect(resized).toMatchObject({ width: 340, height: 240, position: { x: 100, y: 200 } });
    });

    it("returns the original node after dimensions and ratio are already synchronized", () => {
        const squareNode = { ...imageNode, width: 340, height: 340, metadata: { ...imageNode.metadata, naturalWidth: 1024, naturalHeight: 1024 } };

        expect(resizeImageNodeToNaturalRatio(squareNode, 1024, 1024)).toBe(squareNode);
    });
});

describe("canvas node corner resize", () => {
    const landscape = { startLeft: 100, startTop: 80, startWidth: 640, startHeight: 360, minWidth: 220, minHeight: 160, ratio: 640 / 360 };

    it("scales a ratio-locked node proportionally instead of snapping to a dominant axis", () => {
        const result = resizeNodeBox({ ...landscape, fromLeft: false, fromTop: false, dx: -100, dy: -100, keepRatio: true });

        expect(result.width).toBeCloseTo(521.3, 0);
        expect(result.height).toBeCloseTo(293.2, 0);
        expect(result.position).toEqual({ x: 100, y: 80 });
    });

    it("clamps a shrinking ratio-locked node to its true minimum without breaking the ratio", () => {
        const result = resizeNodeBox({ ...landscape, fromLeft: false, fromTop: false, dx: -400, dy: -400, keepRatio: true });

        expect(result.width).toBeCloseTo(284.4, 0);
        expect(result.height).toBeCloseTo(160, 0);
    });

    it("anchors the opposite corner while resizing from the top-left", () => {
        const result = resizeNodeBox({ ...landscape, fromLeft: true, fromTop: true, dx: 100, dy: 100, keepRatio: true });

        expect(result.width).toBeCloseTo(521.3, 0);
        expect(result.height).toBeCloseTo(293.2, 0);
        expect(result.position.x).toBeCloseTo(218.7, 0);
        expect(result.position.y).toBeCloseTo(146.8, 0);
    });

    it("keeps free-resize dimensions independent of each other", () => {
        const result = resizeNodeBox({ startLeft: 0, startTop: 0, startWidth: 400, startHeight: 300, fromLeft: false, fromTop: false, dx: -100, dy: -50, keepRatio: false, ratio: 1, minWidth: 220, minHeight: 160 });

        expect(result).toEqual({ width: 300, height: 250, position: { x: 0, y: 0 } });
    });

    it("grows a ratio-locked node past its start size", () => {
        const result = resizeNodeBox({ ...landscape, fromLeft: false, fromTop: false, dx: 100, dy: 100, keepRatio: true });

        expect(result.width).toBeGreaterThan(640);
        expect(result.height).toBeGreaterThan(360);
    });
});
