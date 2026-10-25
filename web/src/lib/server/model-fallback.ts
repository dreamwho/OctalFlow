import type { AuthSettings, UserRole } from "@/lib/auth/store";
import { isLogicalModelResolvable } from "@/lib/model-routing-config";
import { roleModelAccessAllows } from "@/lib/user-roles";

export function configuredModelFallback(settings: Pick<AuthSettings, "logicalModels" | "systemChannels" | "userRoles">, role: UserRole, modelId: string, capability: "image" | "video") {
    const source = settings.logicalModels.find((model) => model.id.toLowerCase() === modelId.trim().toLowerCase() && model.capability === capability);
    if (!source?.fallbackModelId || !roleModelAccessAllows(settings.userRoles, role, source.id, capability)) return null;
    const target = settings.logicalModels.find((model) => model.id.toLowerCase() === source.fallbackModelId?.toLowerCase());
    if (!target || target.id === source.id || !target.enabled || target.capability !== capability) return null;
    if (!roleModelAccessAllows(settings.userRoles, role, target.id, capability) || !isLogicalModelResolvable(settings.logicalModels, settings.systemChannels, capability, target.id)) return null;
    return { id: target.id, name: target.name || target.id, sourceName: source.name || source.id };
}
