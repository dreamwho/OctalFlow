import { CanvasNodeType, type CanvasNodeData, type Position, type ViewportTransform } from "../types";

export function worldFromScreen(clientX: number, clientY: number, viewport: ViewportTransform, rect: Pick<DOMRect, "left" | "top">): Position {
    return { x: (clientX - rect.left - viewport.x) / viewport.k, y: (clientY - rect.top - viewport.y) / viewport.k };
}

export function nodeAnchor(node: CanvasNodeData, handleType: "source" | "target"): Position {
    return { x: handleType === "source" ? node.position.x + node.width : node.position.x, y: node.position.y + node.height / 2 };
}

export function edgePath(from: CanvasNodeData, to: CanvasNodeData) {
    return smoothCurve(nodeAnchor(from, "source"), nodeAnchor(to, "target"), 1);
}

export function previewPath(start: Position, end: Position, handleType: "source" | "target") {
    return smoothCurve(start, end, handleType === "source" ? 1 : -1);
}

export function samePosition(a: Position, b: Position) {
    return Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01;
}

export type SnapGuide = {
    orientation: "horizontal" | "vertical";
    position: number;
    start: number;
    end: number;
};

type SnapBox = { x: number; y: number; width: number; height: number };
type SnapBounds = { left: number; right: number; top: number; bottom: number; centerX: number; centerY: number };

export function resolveSnapGuides(dragged: SnapBox[], statics: SnapBox[], threshold: number): { dx: number; dy: number; guides: SnapGuide[] } {
    if (!dragged.length || !statics.length) return { dx: 0, dy: 0, guides: [] };
    const group = snapBounds(dragged);
    let bestX = { delta: Infinity, position: 0, start: 0, end: 0 };
    let bestY = { delta: Infinity, position: 0, start: 0, end: 0 };
    for (const node of statics) {
        const bounds = snapBounds([node]);
        for (const groupX of [group.left, group.centerX, group.right]) {
            for (const staticX of [bounds.left, bounds.centerX, bounds.right]) {
                const delta = staticX - groupX;
                if (Math.abs(delta) < Math.abs(bestX.delta)) bestX = { delta, position: staticX, start: Math.min(group.top, bounds.top), end: Math.max(group.bottom, bounds.bottom) };
            }
        }
        for (const groupY of [group.top, group.centerY, group.bottom]) {
            for (const staticY of [bounds.top, bounds.centerY, bounds.bottom]) {
                const delta = staticY - groupY;
                if (Math.abs(delta) < Math.abs(bestY.delta)) bestY = { delta, position: staticY, start: Math.min(group.left, bounds.left), end: Math.max(group.right, bounds.right) };
            }
        }
    }
    const dx = Math.abs(bestX.delta) <= threshold ? bestX.delta : 0;
    const dy = Math.abs(bestY.delta) <= threshold ? bestY.delta : 0;
    const guides: SnapGuide[] = [];
    if (dx !== 0) guides.push({ orientation: "vertical", position: bestX.position, start: bestX.start, end: bestX.end });
    if (dy !== 0) guides.push({ orientation: "horizontal", position: bestY.position, start: bestY.start, end: bestY.end });
    return { dx, dy, guides };
}

function snapBounds(nodes: SnapBox[]): SnapBounds {
    const left = Math.min(...nodes.map((node) => node.x));
    const right = Math.max(...nodes.map((node) => node.x + node.width));
    const top = Math.min(...nodes.map((node) => node.y));
    const bottom = Math.max(...nodes.map((node) => node.y + node.height));
    return { left, right, top, bottom, centerX: (left + right) / 2, centerY: (top + bottom) / 2 };
}

export function selectNodesInBounds(nodes: CanvasNodeData[], start: Position, end: Position, initialNodeIds: Iterable<string> = []) {
    const minX = Math.min(start.x, end.x);
    const maxX = Math.max(start.x, end.x);
    const minY = Math.min(start.y, end.y);
    const maxY = Math.max(start.y, end.y);
    const selected = new Set(initialNodeIds);
    for (const node of nodes) {
        if (node.position.x < maxX && node.position.x + node.width > minX && node.position.y < maxY && node.position.y + node.height > minY) selected.add(node.id);
    }
    return selected;
}

export function expandCanvasDragNodeIds(nodes: CanvasNodeData[], selectedNodeIds: Iterable<string>) {
    const dragNodeIds = new Set(selectedNodeIds);
    for (const node of nodes) {
        if (!dragNodeIds.has(node.id)) continue;
        node.metadata?.batchChildIds?.forEach((childId) => dragNodeIds.add(childId));
    }
    return [...dragNodeIds];
}

export function findConnectionTarget(world: Position, draft: { nodeId: string; handleType: "source" | "target" }, nodes: CanvasNodeData[], scale: number) {
    const tolerance = 52 / Math.max(scale, 0.1);
    let best: { id: string; distance: number } | null = null;
    for (let index = nodes.length - 1; index >= 0; index -= 1) {
        const node = nodes[index];
        if (node.id === draft.nodeId || (draft.handleType === "target" && node.type === CanvasNodeType.Config)) continue;
        const anchor = nodeAnchor(node, draft.handleType === "source" ? "target" : "source");
        const inside = world.x >= node.position.x && world.x <= node.position.x + node.width && world.y >= node.position.y && world.y <= node.position.y + node.height;
        const distance = Math.hypot(world.x - anchor.x, world.y - anchor.y);
        if (!inside && distance > tolerance) continue;
        if (!best || distance < best.distance) best = { id: node.id, distance };
    }
    return best?.id || null;
}

export function isBlockedConnectionDrop(world: Position, draft: { nodeId: string; handleType: "source" | "target" }, nodes: CanvasNodeData[], scale: number) {
    const tolerance = 52 / Math.max(scale, 0.1);
    return nodes.some((node) => {
        const blocked = node.id === draft.nodeId || (draft.handleType === "target" && node.type === CanvasNodeType.Config);
        if (!blocked) return false;
        const anchor = nodeAnchor(node, draft.handleType === "source" ? "target" : "source");
        const inside = world.x >= node.position.x && world.x <= node.position.x + node.width && world.y >= node.position.y && world.y <= node.position.y + node.height;
        return inside || Math.hypot(world.x - anchor.x, world.y - anchor.y) <= tolerance;
    });
}

function smoothCurve(start: Position, end: Position, direction: 1 | -1) {
    const curvature = Math.min(Math.abs(end.x - start.x) * 0.5, 240);
    const c1 = { x: start.x + direction * curvature, y: start.y };
    const c2 = { x: end.x - direction * curvature, y: end.y };
    return `M ${format(start.x)} ${format(start.y)} C ${format(c1.x)} ${format(c1.y)}, ${format(c2.x)} ${format(c2.y)}, ${format(end.x)} ${format(end.y)}`;
}

function format(value: number) {
    return Number(value.toFixed(2));
}
