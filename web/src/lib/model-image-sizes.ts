import { modelOptionName, resolveModelChannel, type AiConfig } from "@/stores/use-config-store";

/** Public, administrator-configured choices for the selected logical binding. */
export function configuredModelImageSizes(config: AiConfig, modelId: string) {
    const model = config.logicalModels.find((item) => item.enabled && item.capability === "image" && item.id === modelOptionName(modelId));
    const channel = resolveModelChannel(config, modelId);
    const binding = model?.bindings.filter((item) => item.enabled && item.channelId === channel.id).sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id))[0];
    const values = binding?.capabilityProfile?.aspectRatios;
    if (!values?.length) return undefined;
    return values.map((value) => {
        const dimensions = value.match(/^(\d+)(?::|x|×)(\d+)$/i);
        const width = dimensions ? Number(dimensions[1]) : 1;
        const height = dimensions ? Number(dimensions[2]) : 1;
        const scale = 20 / Math.max(width, height, 1);
        return { value, label: value === "auto" ? "智能" : value.replace(/x/i, "×"), width: width * scale, height: height * scale };
    });
}

export function hasOnlyFixedImageSizes(options: ReturnType<typeof configuredModelImageSizes>) {
    return Boolean(options?.some((option) => option.value !== "auto") && options.every((option) => option.value === "auto" || /^\d+[x×]\d+$/i.test(option.value)));
}
