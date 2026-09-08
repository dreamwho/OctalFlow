import type { CanvasNodeData } from "../types";

// Presentation pacing only: these are not task deadlines, retries or upstream limits.
export function estimateCanvasProgress(elapsedMs: number, type?: string) {
    const halfLife = type === "text" ? 30 : type === "video" ? 120 : 60;
    const seconds = Math.max(0, elapsedMs / 1000);
    return {
        percent: Math.min(95, Math.floor(1 + 94 * (1 - 2 ** (-seconds / halfLife)))),
        waiting: seconds >= halfLife * 3,
        elapsed: `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`,
    };
}

export function stampCanvasGenerationStarts(previous: CanvasNodeData[], next: CanvasNodeData[], now: number) {
    if (!next.some((node) => node.metadata?.status === "loading")) return next;
    const byId = new Map(previous.map((node) => [node.id, node]));
    return next.map((node) => {
        if (node.metadata?.status !== "loading") return node;
        const old = byId.get(node.id);
        const restarting = old && old.metadata?.status !== "loading";
        const startedAt = restarting ? now : node.metadata.generationStartedAt || old?.metadata?.generationStartedAt || now;
        if (startedAt === node.metadata.generationStartedAt) return node;
        return { ...node, metadata: { ...node.metadata, ...(restarting ? { generationProgress: undefined, generationStage: undefined } : {}), generationStartedAt: startedAt } };
    });
}
