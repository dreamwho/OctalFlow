import type { CanvasNodeData } from "../types";

// Presentation pacing only: these are not task deadlines, retries or upstream limits.
export function estimateCanvasProgress(elapsedMs: number, type?: string, expectedMs?: number) {
    const expected = expectedMs && Number.isFinite(expectedMs) && expectedMs > 0 ? expectedMs : defaultDuration(type);
    const seconds = Math.max(0, elapsedMs / 1000);
    const ratio = Math.max(0, elapsedMs) / expected;
    // Reach 90% around the median actual duration, reserving a slow tail for variation.
    const percent = ratio <= 1 ? 1 + 89 * (1 - (1 - ratio) ** 1.8) : 90 + 5 * (1 - Math.exp(-(ratio - 1) / 2));
    return {
        percent: Math.min(95, Math.round(percent)),
        waiting: ratio >= 1,
        elapsed: `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`,
    };
}

function defaultDuration(type?: string) {
    return (type === "text" ? 30 : type === "video" ? 120 : 60) * 1000;
}

function model(node: CanvasNodeData) {
    const metadata = node.metadata;
    return metadata?.imageTask?.model || metadata?.videoTask?.model || metadata?.textTask?.model || metadata?.audioTask?.model || metadata?.model;
}

export function canvasExpectedDuration(node: CanvasNodeData, history: CanvasNodeData[]) {
    const candidates = history.filter(
        (item) =>
            item.type === node.type &&
            item.metadata?.derivedVideoOperation === node.metadata?.derivedVideoOperation &&
            item.metadata?.status === "success" &&
            Number.isFinite(item.metadata.generationStartedAt) &&
            Number.isFinite(item.metadata.generationFinishedAt) &&
            item.metadata.generationFinishedAt! > item.metadata.generationStartedAt!,
    );
    const sameModel = model(node) ? candidates.filter((item) => model(item) === model(node)) : [];
    const durations = (sameModel.length ? sameModel : candidates).map((item) => item.metadata!.generationFinishedAt! - item.metadata!.generationStartedAt!).sort((a, b) => a - b);
    if (!durations.length) return defaultDuration(node.type);
    const middle = Math.floor(durations.length / 2);
    return durations.length % 2 ? durations[middle] : (durations[middle - 1] + durations[middle]) / 2;
}

export function stampCanvasGenerationStarts(previous: CanvasNodeData[], next: CanvasNodeData[], now: number) {
    if (!previous.some((node) => node.metadata?.status === "loading") && !next.some((node) => node.metadata?.status === "loading")) return next;
    const byId = new Map(previous.map((node) => [node.id, node]));
    return next.map((node) => {
        const old = byId.get(node.id);
        if (node.metadata?.status === "success" && old?.metadata?.status === "loading" && old.metadata.generationStartedAt) {
            return { ...node, metadata: { ...node.metadata, generationStartedAt: old.metadata.generationStartedAt, generationFinishedAt: now } };
        }
        if (node.metadata?.status !== "loading") return node;
        const restarting = old && old.metadata?.status !== "loading";
        const startedAt = restarting ? now : node.metadata.generationStartedAt || old?.metadata?.generationStartedAt || now;
        if (startedAt === node.metadata.generationStartedAt && node.metadata.generationExpectedMs) return node;
        const expectedMs = (!restarting && node.metadata.generationExpectedMs) || canvasExpectedDuration(node, previous.length ? previous : next);
        return { ...node, metadata: { ...node.metadata, ...(restarting ? { generationProgress: undefined, generationStage: undefined, generationFinishedAt: undefined } : {}), generationStartedAt: startedAt, generationExpectedMs: expectedMs } };
    });
}
