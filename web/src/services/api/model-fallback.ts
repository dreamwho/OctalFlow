import { throwIfClientSessionExpired } from "@/services/api/session-expiration";

export type ModelFallbackCapability = "image" | "video";
export type ModelFallbackOffer = { id: string; name: string; sourceName?: string };

export async function getModelFallback(model: string, capability: ModelFallbackCapability, signal?: AbortSignal): Promise<ModelFallbackOffer | null> {
    const query = new URLSearchParams({ model, capability });
    const response = await fetch(`/api/models/fallback?${query.toString()}`, { cache: "no-store", signal });
    throwIfClientSessionExpired(response);
    const payload = (await response.json().catch(() => null)) as { code?: number; data?: ModelFallbackOffer | null; msg?: string } | null;
    if (!response.ok || payload?.code !== 0) throw new Error(payload?.msg || "查询备用模型失败");
    const offer = payload.data;
    if (!offer || typeof offer.id !== "string" || !offer.id.trim() || typeof offer.name !== "string" || !offer.name.trim()) return null;
    return { id: offer.id, name: offer.name, sourceName: typeof offer.sourceName === "string" ? offer.sourceName : undefined };
}
