import type { AuthSettings, LogicalModelCapability, SystemModelChannel } from "@/lib/auth/store";
import { channelModelCapability, resolveLogicalModelCapabilityProfile } from "@/lib/model-routing-config";
import { channelSupportsModel, rawModelName } from "./generation-channel";
import { filterHealthyRuntimeCandidates } from "./channel-runtime-health";
import { channelConnectionReady } from "@/lib/channel-protocol-registry";

export type ResolvedLogicalModel = {
    logicalModelId: string;
    upstreamModel: string;
    channelId: string;
    channel: SystemModelChannel;
    capabilityProfile?: ReturnType<typeof resolveLogicalModelCapabilityProfile>;
};

export function resolveLogicalModel(settings: Pick<AuthSettings, "logicalModels" | "systemChannels">, capability: LogicalModelCapability, requestedModelId: string, preferredChannelId = ""): ResolvedLogicalModel | null {
    return resolveLogicalModelCandidates(settings, capability, requestedModelId, preferredChannelId)[0] || null;
}

export function resolveLogicalModelCandidates(settings: Pick<AuthSettings, "logicalModels" | "systemChannels">, capability: LogicalModelCapability, requestedModelId: string, preferredChannelId = ""): ResolvedLogicalModel[] {
    const { channelId: requestedChannelId } = splitChannelModel(requestedModelId);
    const requested = rawModelName(requestedModelId).replace(/^models\//i, "");
    if (!requested) return [];
    const effectivePreferredChannelId = preferredChannelId || requestedChannelId;
    const logical = settings.logicalModels.find((model) => model.enabled && model.capability === capability && model.id.toLowerCase() === requested.toLowerCase());
    if (logical) {
        const bindings = logical.bindings.filter((binding) => binding.enabled).sort((a, b) => a.priority - b.priority || (b.weight || 100) - (a.weight || 100) || a.id.localeCompare(b.id));
        const preferred = effectivePreferredChannelId ? bindings.find((binding) => binding.channelId === effectivePreferredChannelId) : undefined;
        const resolved: ResolvedLogicalModel[] = [];
        for (const binding of preferred ? [preferred, ...bindings.filter((item) => item !== preferred)] : bindings) {
            const channel = settings.systemChannels.find((item) => item.id === binding.channelId && item.enabled && channelConnectionReady(item) && channelSupportsModel(item.models, binding.upstreamModel));
            if (channel) resolved.push({ logicalModelId: logical.id, upstreamModel: binding.upstreamModel, channelId: channel.id, channel, capabilityProfile: resolveLogicalModelCapabilityProfile(binding, capability, channel, binding.upstreamModel) });
        }
        // Text planning tracks health per channel + upstream model in
        // text-planning-runtime. A channel-level cooldown must not hide a healthy
        // backup text model that shares the same gateway.
        return capability === "text" ? resolved : filterHealthyRuntimeCandidates(resolved, capability);
    }
    if (settings.logicalModels.length) return [];
    const ordered = effectivePreferredChannelId
        ? [...settings.systemChannels.filter((channel) => channel.id === effectivePreferredChannelId), ...settings.systemChannels.filter((channel) => channel.id !== effectivePreferredChannelId)]
        : settings.systemChannels;
    const resolved = ordered
        .filter((item) => item.enabled && channelConnectionReady(item) && channelSupportsModel(item.models, requested) && channelModelCapability(item, requested) === capability)
        .map((channel) => ({ logicalModelId: requested, upstreamModel: requested, channelId: channel.id, channel, capabilityProfile: resolveLogicalModelCapabilityProfile({}, capability, channel, requested) }));
    return capability === "text" ? resolved : filterHealthyRuntimeCandidates(resolved, capability);
}

export function resolveLogicalBillingModel(logicalModels: AuthSettings["logicalModels"], capability: LogicalModelCapability, channelId: string, upstreamModel: string, preferredLogicalModelId = "") {
    const matches = logicalModels.filter(
        (logical) => logical.enabled && logical.capability === capability && logical.bindings.some((binding) => binding.enabled && binding.channelId === channelId && channelSupportsModel([binding.upstreamModel], upstreamModel)),
    );
    return matches.find((logical) => logical.id.toLowerCase() === preferredLogicalModelId.trim().toLowerCase())?.id || matches[0]?.id || upstreamModel;
}

function splitChannelModel(value: string) {
    const separator = value.indexOf("::");
    return separator >= 0 ? { channelId: value.slice(0, separator), model: value.slice(separator + 2) } : { channelId: "", model: value };
}
