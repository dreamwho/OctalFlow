import type { LogicalModel, LogicalModelCapability } from "@/lib/auth/store";

export function reorderLogicalModels(models: LogicalModel[], capability: LogicalModelCapability, sourceId: string, targetId: string) {
    if (sourceId === targetId) return models;
    const scoped = models.filter((model) => model.capability === capability);
    const sourceIndex = scoped.findIndex((model) => model.id === sourceId);
    const targetIndex = scoped.findIndex((model) => model.id === targetId);
    if (sourceIndex < 0 || targetIndex < 0) return models;
    const reordered = [...scoped];
    const [moved] = reordered.splice(sourceIndex, 1);
    reordered.splice(targetIndex, 0, moved);
    let scopedIndex = 0;
    return models.map((model) => (model.capability === capability ? reordered[scopedIndex++] : model));
}

export function moveLogicalModel(models: LogicalModel[], capability: LogicalModelCapability, modelId: string, offset: -1 | 1) {
    const scoped = models.filter((model) => model.capability === capability);
    const index = scoped.findIndex((model) => model.id === modelId);
    const target = scoped[index + offset];
    return target ? reorderLogicalModels(models, capability, modelId, target.id) : models;
}

export function setLogicalModelPickerVisibility(models: LogicalModel[], modelId: string, visible: boolean) {
    return models.map((model) => (model.id === modelId ? { ...model, pickerVisible: visible } : model));
}
