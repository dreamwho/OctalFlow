import { AsyncLocalStorage } from "node:async_hooks";
import { systemGenerationChannelId } from "@/lib/server/generation-channel";

export type TrafficContext = {
    channelId: string;
    channelName: string;
    model: string;
    protocol: string;
    connectionMode?: string;
    role?: string;
    attributionScope?: string;
    requestId?: string;
    taskId?: string;
    attemptId?: string;
};

const globals = globalThis as typeof globalThis & { dreamyoTrafficContext?: AsyncLocalStorage<Partial<TrafficContext>> };
const storage = (globals.dreamyoTrafficContext ??= new AsyncLocalStorage<Partial<TrafficContext>>());

export function withTrafficContext<T>(context: Partial<TrafficContext>, action: () => T): T {
    return storage.run({ ...storage.getStore(), ...context }, action);
}

export function updateTrafficContext(context: Partial<TrafficContext>) {
    const current = storage.getStore();
    if (current) Object.assign(current, context);
}

export function currentTrafficContext() {
    return storage.getStore();
}

export function trafficBodyModel(body: RequestInit["body"]) {
    if (body instanceof FormData) return String(body.get("model") || "");
    if (typeof body !== "string") return "";
    try {
        return String(JSON.parse(body)?.model || "");
    } catch {
        return "";
    }
}

export function providerTrafficHeaders(headers: Headers, defaults: TrafficContext) {
    // Only server-owned metadata reaches an authenticated internal provider.
    headers.set("x-dreamyo-traffic-context", Buffer.from(JSON.stringify({ ...defaults, ...currentTrafficContext() })).toString("base64url"));
}

export function generationTrafficContext(config: { channelId?: string; baseUrl?: string; model?: string; apiFormat?: string; advancedConfig?: { protocol?: string } }, role: string, taskId?: string): TrafficContext {
    const channelId = config.channelId || systemGenerationChannelId(config.baseUrl || "");
    return { channelId, channelName: channelId, model: config.model || "", protocol: config.advancedConfig?.protocol || config.apiFormat || "unknown", role, ...(taskId ? { taskId, requestId: taskId } : {}) };
}
