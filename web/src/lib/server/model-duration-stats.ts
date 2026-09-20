import { listGenerationLogs } from "@/lib/server/generation-log-store";

export type ModelDurationStat = { avgDurationMs: number; samples: number };

const MAX_PAGES = 3;
const MAX_SAMPLES_PER_MODEL = 20;
const CACHE_TTL_MS = 60_000;

let cache: { at: number; data: Record<string, ModelDurationStat> } | null = null;

/** 聚合最近成功生成记录的各模型平均耗时；60s 进程内缓存，避免每次弹层打开都扫描日志。 */
export async function computeModelDurationStats(): Promise<Record<string, ModelDurationStat>> {
    if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.data;
    const durationsByModel = new Map<string, number[]>();
    for (let page = 1; page <= MAX_PAGES; page += 1) {
        const result = await listGenerationLogs({ page, pageSize: 100, status: "success" });
        for (const log of result.items) {
            if (!log.model || !(log.durationMs > 0)) continue;
            const durations = durationsByModel.get(log.model) || [];
            if (durations.length >= MAX_SAMPLES_PER_MODEL) continue;
            durations.push(log.durationMs);
            durationsByModel.set(log.model, durations);
        }
        if (page * 100 >= result.total) break;
    }
    const data = Object.fromEntries(
        Array.from(durationsByModel.entries()).map(([model, durations]) => [
            model,
            { avgDurationMs: Number((durations.reduce((sum, value) => sum + value, 0) / durations.length).toFixed(0)), samples: durations.length },
        ]),
    );
    cache = { at: Date.now(), data };
    return data;
}
