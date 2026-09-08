import type { AiConfig } from "@/stores/use-config-store";

import { NODE_DEFAULT_SIZE } from "../constants";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type CanvasNodeMetadata } from "../types";
import { nodeSizeFromRatio } from "./canvas-node-size";
import { CANVAS_NODE_GAP, resolveCanvasNodePlacement } from "./canvas-surface-geometry";

export const CHARACTER_THREE_VIEW_PROMPT = `根据参考图生成角色资产三视图与超写实设计图，纯白无缝背景，无任何地平线、参考线与阴影，四面板水平排版：

【左侧三视图·三个站姿身长比例完全等大，脚底水平对齐】：

- 面板一：完整全身正面站姿（颈部以下至脚底，完整显示双腿、裤长与完整鞋子。仅头部不画且上方留出大片白底，躯干与衣服比例严格与侧面/背面一致，严禁截断下肢）
- 面板二：从头到脚完整全身侧面站姿
- 面板三：从头到脚完整全身背面站姿

【右侧正面肖像·胸部以上半身人像景别】：
正面直视镜头，包含完整锁骨、脖颈、全脸及完整顶部发髻。超真实的皮肤纹理，极具真实呼吸感，带有真实可见的毛孔、自然生理微细节，水润清新的肤色，通透皮肤下透出鼻翼微弱红润与微细血管，脸颊边缘带有微小面部绒毛。精细描绘的睫毛带有清晰的眼神光，眼神亲密而平静。虹膜纤维清晰、眼睛湿润有真实反光、睫毛根根分明，浓密眉毛略带杂毛，嘴唇柔软自然带有轻微原生唇纹，呈自然的粉红色，带有微妙的纹理，没有浓妆。

使用 100mm 微距镜头以 f/2.8 拍摄的极限微距照片，景深极浅，焦点锐利地落在眼睛上，鼻部和嘴唇平滑地虚化。未经磨皮滤镜、自然面部结构、真实发丝和胡茬细节、克制色彩、宽容度高、眼部焦点极其锐利、自然解剖准确、无美颜滤镜、获奖级编辑摄影。面部瑕疵真实可见。纯白极简空间，完全无地面线条。`;

export const CHARACTER_THREE_VIEW_GENERATION_DEFAULTS = {
    size: "16:9",
    quality: "high",
    count: "1",
} as const;

export type CanvasCharacterThreeViewParams = {
    model: string;
};

export function buildCharacterThreeViewGenerationConfig(config: AiConfig, model: string): AiConfig {
    return { ...config, model, ...CHARACTER_THREE_VIEW_GENERATION_DEFAULTS };
}

export function createCharacterThreeViewNode({ source, nodes, nodeId, connectionId, metadata }: { source: CanvasNodeData; nodes: CanvasNodeData[]; nodeId: string; connectionId: string; metadata: CanvasNodeMetadata }) {
    const defaultSize = NODE_DEFAULT_SIZE[CanvasNodeType.Image];
    const size = nodeSizeFromRatio(CHARACTER_THREE_VIEW_GENERATION_DEFAULTS.size, defaultSize.width, defaultSize.height) || defaultSize;
    const position = resolveCanvasNodePlacement(
        nodes,
        size,
        { x: source.position.x + source.width / 2, y: source.position.y + source.height / 2 },
        { x: source.position.x + source.width + CANVAS_NODE_GAP, y: source.position.y + (source.height - size.height) / 2 },
    );

    return {
        node: {
            id: nodeId,
            type: CanvasNodeType.Image,
            title: "人物三视图",
            position,
            width: size.width,
            height: size.height,
            metadata,
        } satisfies CanvasNodeData,
        connection: { id: connectionId, fromNodeId: source.id, toNodeId: nodeId } satisfies CanvasConnection,
    };
}
