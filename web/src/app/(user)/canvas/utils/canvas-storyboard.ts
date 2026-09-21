import type { AiConfig } from "@/stores/use-config-store";
import type { CanvasQuickActionCapability } from "@/lib/canvas-quick-actions";

export { CHARACTER_THREE_VIEW_PROMPT } from "@/lib/canvas-quick-actions";

import { NODE_DEFAULT_SIZE } from "../constants";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type CanvasNodeMetadata } from "../types";
import { nodeSizeFromRatio } from "./canvas-node-size";
import { CANVAS_NODE_GAP, resolveCanvasNodePlacement } from "./canvas-surface-geometry";

// 提示词已迁移为后台可运营的画布功能菜单种子数据（@/lib/canvas-quick-actions）。


export const CANVAS_QUICK_ACTION_NODE_TYPES: Record<CanvasQuickActionCapability, CanvasNodeType> = {
    image: CanvasNodeType.Image,
    video: CanvasNodeType.Video,
    audio: CanvasNodeType.Audio,
    text: CanvasNodeType.Text,
};

/** 依据功能条目的能力类型与比例默认值，在源节点右侧创建新产物节点并建立连线。 */
export function createQuickActionNode({ source, nodes, nodeId, connectionId, nodeType, title, ratio, metadata }: { source: CanvasNodeData; nodes: CanvasNodeData[]; nodeId: string; connectionId: string; nodeType: CanvasNodeType; title: string; ratio?: string; metadata: CanvasNodeMetadata }) {
    const defaultSize = NODE_DEFAULT_SIZE[nodeType];
    const size = (ratio ? nodeSizeFromRatio(ratio, defaultSize.width, defaultSize.height) : null) || defaultSize;
    const position = resolveCanvasNodePlacement(
        nodes,
        size,
        { x: source.position.x + source.width / 2, y: source.position.y + source.height / 2 },
        { x: source.position.x + source.width + CANVAS_NODE_GAP, y: source.position.y + (source.height - size.height) / 2 },
    );

    return {
        node: {
            id: nodeId,
            type: nodeType,
            title,
            position,
            width: size.width,
            height: size.height,
            metadata,
        } satisfies CanvasNodeData,
        connection: { id: connectionId, fromNodeId: source.id, toNodeId: nodeId } satisfies CanvasConnection,
    };
}
