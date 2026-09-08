type PublicModelCapability = "image" | "video" | "text" | "audio";

export function resolvePublicCapabilityModels(logicalModels: Array<{ id: string; capability: PublicModelCapability; pickerVisible?: boolean }>, fallback: Record<PublicModelCapability, string[]>) {
    return Object.fromEntries(
        (Object.keys(fallback) as PublicModelCapability[]).map((capability) => {
            const scopedModels = logicalModels.filter((model) => model.capability === capability);
            const logical = scopedModels.filter((model) => model.pickerVisible !== false).map((model) => model.id);
            return [capability, scopedModels.length ? logical : fallback[capability]];
        }),
    ) as Record<PublicModelCapability, string[]>;
}

export function flattenPublicCapabilityModels(models: Record<PublicModelCapability, string[]>) {
    return Array.from(new Set([models.image, models.video, models.text, models.audio].flat()));
}
