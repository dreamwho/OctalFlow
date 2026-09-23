import type { LogicalModelCapability, UserRole, UserRoleDefinition, UserRoleModelAccess } from "@/lib/auth/store-types";
import { inferModelCapability, normalizeModelId } from "@/lib/model-capability";

export const USER_ROLE_CAPABILITIES: LogicalModelCapability[] = ["image", "video", "text", "audio"];

export const DEFAULT_USER_ROLE: UserRoleDefinition = {
    id: "user",
    name: "普通用户",
    pointsMultiplier: 1,
    recordOnly: false,
    modelAccess: { all: true, capabilities: [...USER_ROLE_CAPABILITIES], modelIds: [], excludedModelIds: [] },
};

export function normalizeUserRoleId(value: unknown): UserRole | null {
    if (typeof value !== "string") return null;
    const id = value.trim().toLowerCase();
    return /^[a-z][a-z0-9_-]{1,31}$/i.test(id) ? id : null;
}

export function normalizeUserRoleDefinitions(value: unknown): UserRoleDefinition[] {
    const input = Array.isArray(value) ? value : [];
    const roles: UserRoleDefinition[] = [];
    const ids = new Set<string>();
    for (const item of input) {
        if (!item || typeof item !== "object" || Array.isArray(item)) continue;
        const raw = item as Partial<UserRoleDefinition>;
        const id = normalizeUserRoleId(raw.id);
        if (!id || id === "admin" || ids.has(id)) continue;
        const modelAccess = normalizeModelAccess(raw.modelAccess);
        const role: UserRoleDefinition = {
            id,
            name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim().slice(0, 40) : (id === "user" ? DEFAULT_USER_ROLE.name : id),
            pointsMultiplier: normalizeRoleMultiplier(raw.pointsMultiplier),
            recordOnly: raw.recordOnly === true,
            modelAccess,
        };
        if (id === "user") roles.unshift(role);
        else roles.push(role);
        ids.add(id);
    }
    if (!ids.has("user")) roles.unshift(structuredClone(DEFAULT_USER_ROLE));
    return roles.slice(0, 100);
}

export function userRoleDefinitionsValidationError(value: unknown) {
    if (!Array.isArray(value) || value.length < 1 || value.length > 100) return "角色列表无效";
    const ids = new Set<string>();
    for (const item of value) {
        if (!item || typeof item !== "object" || Array.isArray(item)) return "角色配置无效";
        const role = item as Partial<UserRoleDefinition>;
        const id = normalizeUserRoleId(role.id);
        if (!id || id === "admin") return "角色 ID 仅支持字母开头的字母、数字、下划线和连字符，且不能使用 admin";
        if (ids.has(id)) return `角色 ID 重复：${id}`;
        ids.add(id);
        if (typeof role.name !== "string" || !role.name.trim() || role.name.trim().length > 40) return `${id} 的角色名称需为 1–40 个字符`;
        if (typeof role.pointsMultiplier !== "number" || !Number.isFinite(role.pointsMultiplier) || role.pointsMultiplier < 0 || role.pointsMultiplier > 100) return `${id} 的积分消耗比例需在 0–100 之间`;
        if (typeof role.recordOnly !== "boolean") return `${id} 的积分记录策略无效`;
        const access = role.modelAccess;
        if (!access || typeof access !== "object" || typeof access.all !== "boolean") return `${id} 的模型权限无效`;
        if (!Array.isArray(access.capabilities) || access.capabilities.some((capability) => !USER_ROLE_CAPABILITIES.includes(capability))) return `${id} 的模型分类权限无效`;
        if (![access.modelIds, access.excludedModelIds].every((items) => Array.isArray(items) && items.length <= 2000 && items.every((model) => typeof model === "string" && model.trim().length <= 180))) return `${id} 的模型列表无效`;
    }
    if (!ids.has("user")) return "必须保留普通用户角色";
    return "";
}

export function userRoleDefinition(roles: UserRoleDefinition[] | undefined, role: UserRole) {
    if (role === "admin") return undefined;
    return normalizeUserRoleDefinitions(roles).find((item) => item.id === role) || DEFAULT_USER_ROLE;
}

export function userRoleAllowsModel(roleDefinition: UserRoleDefinition | undefined, modelId: string, capability?: LogicalModelCapability) {
    const access = roleDefinition?.modelAccess || DEFAULT_USER_ROLE.modelAccess;
    const normalizedId = normalizeModelId(modelId);
    if (access.excludedModelIds.some((id) => normalizeModelId(id) === normalizedId)) return false;
    if (access.all) return true;
    const actualCapability = capability || inferModelCapability(modelId);
    return access.capabilities.includes(actualCapability) || access.modelIds.some((id) => normalizeModelId(id) === normalizedId);
}

export function roleModelAccessAllows(roles: UserRoleDefinition[] | undefined, role: UserRole, modelId: string, capability?: LogicalModelCapability) {
    return role === "admin" || userRoleAllowsModel(userRoleDefinition(roles, role), modelId, capability);
}

export function normalizeRoleMultiplier(value: unknown) {
    const multiplier = Number(value);
    return Number.isFinite(multiplier) ? Number(Math.max(0, Math.min(100, multiplier)).toFixed(4)) : 1;
}

function normalizeModelAccess(value: unknown): UserRoleModelAccess {
    const raw = value && typeof value === "object" && !Array.isArray(value) ? (value as Partial<UserRoleModelAccess>) : {};
    const normalizeIds = (items: unknown) => Array.isArray(items) ? Array.from(new Set(items.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean))).slice(0, 2000) : [];
    const capabilities = Array.isArray(raw.capabilities) ? USER_ROLE_CAPABILITIES.filter((capability) => raw.capabilities!.includes(capability)) : [...USER_ROLE_CAPABILITIES];
    return {
        all: raw.all !== false,
        capabilities,
        modelIds: normalizeIds(raw.modelIds),
        excludedModelIds: normalizeIds(raw.excludedModelIds),
    };
}
