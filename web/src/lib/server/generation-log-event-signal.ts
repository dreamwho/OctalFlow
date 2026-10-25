import { getDatabaseProvider, getPostgresConnectionString, subscribePostgresNotification } from "@/lib/server/database";

type LogEventListener = () => void;

const GENERATION_LOG_NOTIFY_CHANNEL = "dreamyo_generation_logs";
const globalSignals = globalThis as typeof globalThis & {
    __dreamyoProGenerationLogSignals?: Map<string, Set<LogEventListener>>;
    __dreamyoProGenerationLogSignalBridge?: Promise<unknown>;
};
const listeners = (globalSignals.__dreamyoProGenerationLogSignals ??= new Map<string, Set<LogEventListener>>());

export function notifyGenerationLogChanged(userId: string) {
    for (const listener of [...(listeners.get(userId) || [])]) listener();
}

export function waitForGenerationLogChange(userId: string, timeoutMs: number, signal?: AbortSignal) {
    void ensureGenerationLogEventBridge();
    return new Promise<boolean>((resolve) => {
        let settled = false;
        const finish = (notified: boolean) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            signal?.removeEventListener("abort", aborted);
            const current = listeners.get(userId);
            current?.delete(changed);
            if (current && !current.size) listeners.delete(userId);
            resolve(notified);
        };
        const changed = () => finish(true);
        const aborted = () => finish(false);
        const timeout = setTimeout(() => finish(false), timeoutMs);
        const current = listeners.get(userId) || new Set<LogEventListener>();
        current.add(changed);
        listeners.set(userId, current);
        if (signal?.aborted) aborted();
        else signal?.addEventListener("abort", aborted, { once: true });
    });
}

export function ensureGenerationLogEventBridge() {
    if (getDatabaseProvider() !== "postgres" || !getPostgresConnectionString()) return Promise.resolve();
    if (globalSignals.__dreamyoProGenerationLogSignalBridge) return globalSignals.__dreamyoProGenerationLogSignalBridge;
    globalSignals.__dreamyoProGenerationLogSignalBridge = subscribePostgresNotification(GENERATION_LOG_NOTIFY_CHANNEL, (userId) => {
        const id = userId.trim();
        if (id && id.length <= 160) notifyGenerationLogChanged(id);
    }).catch((error) => {
        globalSignals.__dreamyoProGenerationLogSignalBridge = undefined;
        console.warn("Generation log PostgreSQL notification bridge unavailable", { error: error instanceof Error ? error.message : String(error) });
    });
    return globalSignals.__dreamyoProGenerationLogSignalBridge;
}
