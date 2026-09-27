import { describe, expect, it } from "vitest";

import { buildCanvasResourceReferences } from "./canvas-resource-references";
import type { CanvasConnection, CanvasNodeData } from "../types";

function imageNode(id: string, title: string, x: number): CanvasNodeData {
    return {
        id,
        type: "image",
        title,
        position: { x, y: 0 },
        width: 100,
        height: 100,
        metadata: { content: `/api/generation-log-assets/permanent/${id}.png` },
    } as unknown as CanvasNodeData;
}

describe("@图片N 编号只跟随已连接素材", () => {
    const canvasFirst = imageNode("canvas-first", "画布第一张", 0);
    const connectedFirst = imageNode("connected-1", "已连接第一张", 500);
    const connectedSecond = imageNode("connected-2", "已连接第二张", 900);
    const nodes = [canvasFirst, connectedFirst, connectedSecond];
    const connections = [
        { id: "c1", fromNodeId: connectedFirst.id, toNodeId: "target" },
        { id: "c2", fromNodeId: connectedSecond.id, toNodeId: "target" },
    ] as unknown as CanvasConnection[];

    it("已连接的图片从 图片1 开始编号，画布上的未连接图片排在后面", () => {
        const references = buildCanvasResourceReferences(nodes, connections, "target");
        const byNodeId = new Map(references.map((reference) => [reference.nodeId, reference]));

        // 第一个已连接图片必须是 @图片1，而不是画布顺序上的第一张图
        expect(byNodeId.get(connectedFirst.id)?.label).toBe("图片1");
        expect(byNodeId.get(connectedSecond.id)?.label).toBe("图片2");
        expect(byNodeId.get(canvasFirst.id)?.label).toBe("图片3");
        expect(byNodeId.get(connectedFirst.id)?.active).toBe(true);
        expect(byNodeId.get(canvasFirst.id)?.active).toBe(false);
    });

    it("没有任何连线时不产生 图片1 对应画布第一张图的映射", () => {
        const references = buildCanvasResourceReferences(nodes, [], "target");
        const active = references.filter((reference) => reference.active);
        expect(active).toHaveLength(0);
        // 未连接素材仍可见（供选择器展示），但不带已连接语义
        expect(references.every((reference) => reference.active === false)).toBe(true);
    });
});
