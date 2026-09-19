import { randomUUID } from "node:crypto";

import { getAuthSettings, setAuthSettings, type AuthSettings, type SystemChannelModelConfig, type SystemModelChannel } from "@/lib/auth/store";
import { applyChannelProtocol } from "@/lib/channel-protocol-registry";
import { normalizeModelId } from "@/lib/model-capability";
import { normalizeDefaultModelsConfig, synchronizeLogicalModelsWithChannels } from "@/lib/model-routing-config";
import { resolveModelRequestTimeoutMs } from "@/lib/server/model-request-policy";

import {
    DREAMINA_CLI_CHANNEL_ID,
    DREAMINA_CLI_CHANNEL_NAME,
    DREAMINA_CLI_MODELS,
    DREAMINA_CLI_OPERATION_ONLY_MODEL_IDS,
    DREAMINA_CLI_PROTOCOL,
    dreaminaCliCommandCapability,
    dreaminaCliModel,
    dreaminaCliRequiresVip,
    isDreaminaCliModelId,
    type DreaminaCliSubmissionInput,
} from "./dreamina-cli-catalog";
import { DreaminaCliProviderError, readDreaminaCliCredit, readDreaminaCliVersion, submitDreaminaCliTask, type DreaminaCliRunner } from "./dreamina-cli-provider";
import {
    acquireDreaminaCliSubmitLease,
    appendDreaminaCliRequestLog,
    dreaminaCliRequestStats,
    getDreaminaCliAccountState,
    releaseDreaminaCliSubmitLease,
    updateDreaminaCliAccountState,
    type DreaminaCliAccountState,
    type DreaminaCliStatsRange,
} from "./dreamina-cli-store";

export class DreaminaCliServiceError extends Error {
    constructor(
        message: string,
        readonly status = 502,
        readonly retryAfterAt?: number,
    ) {
        super(message);
        this.name = "DreaminaCliServiceError";
    }
}

export type DreaminaCliOverview = {
    runtime: {
        installed: boolean;
        authorized: boolean;
        version?: string;
        commit?: string;
        buildTime?: string;
        account?: { userIdMasked: string; vipLevel: string; totalCredit: number };
        checkedAt: string;
        error?: string;
    };
    models: {
        enabledModelIds: string[];
        catalog: Array<{
            id: string;
            upstreamModel: string;
            displayName: string;
            capability: "image" | "video";
            command: string;
            description: string;
            vipOnly?: boolean;
        }>;
    };
    stats: Awaited<ReturnType<typeof dreaminaCliRequestStats>>;
};

export async function getDreaminaCliOverview(): Promise<DreaminaCliOverview> {
    const [state, settings, stats] = await Promise.all([getDreaminaCliAccountState(), getAuthSettings(), dreaminaCliRequestStats()]);
    const channel = dreaminaCliChannel(settings);
    return {
        runtime: publicRuntime(state),
        models: { enabledModelIds: enabledDreaminaCliModelIds(channel), catalog: publicCatalog() },
        stats,
    };
}

export function getDreaminaCliStats(range: DreaminaCliStatsRange = "all") {
    return dreaminaCliRequestStats(range);
}

/** Explicit admin action only. GET endpoints must call getDreaminaCliOverview instead. */
export async function refreshDreaminaCliRuntime(options: { runner?: DreaminaCliRunner } = {}) {
    const lease = await acquireDreaminaCliSubmitLease({ owner: `dreamina-refresh-${randomUUID()}`, leaseUntil: new Date(Date.now() + resolveModelRequestTimeoutMs(undefined, "image")) });
    if (!lease) throw new DreaminaCliServiceError("即梦 CLI 正在提交任务，暂不能刷新账户余额", 409);
    const startedAt = Date.now();
    try {
        const version = await readDreaminaCliVersion({ runner: options.runner, timeoutMs: resolveModelRequestTimeoutMs(undefined, "image") });
        const credit = await readDreaminaCliCredit({ runner: options.runner, timeoutMs: resolveModelRequestTimeoutMs(undefined, "image") });
        const checkedAt = new Date().toISOString();
        await updateDreaminaCliAccountState({
            status: "authorized",
            userId: credit.userId,
            userName: credit.userName,
            vipLevel: credit.vipLevel,
            totalCredit: credit.totalCredit,
            cliVersion: version.version,
            cliCommit: version.commit,
            cliBuildTime: version.buildTime,
            lastCreditCheckedAt: checkedAt,
            lastSuccessAt: checkedAt,
            lastErrorCode: undefined,
            lastErrorMessage: undefined,
        });
        await appendDreaminaCliRequestLog({
            command: "user_credit",
            phase: "account_refresh",
            status: "success",
            durationMs: Date.now() - startedAt,
            afterCredit: credit.totalCredit,
            creditObservation: "unavailable",
            requestSummary: { action: "manual_refresh" },
            resultSummary: { authorized: true, hasVipLevel: Boolean(credit.vipLevel) },
        });
    } catch (error) {
        const provider = error instanceof DreaminaCliProviderError ? error : null;
        await updateDreaminaCliAccountState({
            status: accountStatusFromError(provider?.message || "", "error"),
            lastErrorCode: provider ? `cli_${provider.status}` : "cli_refresh_failed",
            lastErrorMessage: safeServiceMessage(error),
        });
        await appendDreaminaCliRequestLog({
            command: "user_credit",
            phase: "account_refresh",
            status: "failed",
            durationMs: Date.now() - startedAt,
            creditObservation: "unavailable",
            errorCode: provider ? `cli_${provider.status}` : "cli_refresh_failed",
            error: safeServiceMessage(error),
            requestSummary: { action: "manual_refresh" },
            resultSummary: {},
        });
        throw new DreaminaCliServiceError(safeServiceMessage(error), provider?.status || 502);
    } finally {
        await releaseDreaminaCliSubmitLease(lease.owner);
    }
    return getDreaminaCliOverview();
}

export async function saveDreaminaCliModelSelection(input: { modelIds?: unknown }) {
    const requested = uniqueModelIds(input.modelIds);
    if (requested.some((id) => !isDreaminaCliModelId(id))) throw new DreaminaCliServiceError("所选模型不在即梦 CLI 固定目录中", 422);
    if (requested.length) {
        const state = await getDreaminaCliAccountState();
        if (state.status !== "authorized") throw new DreaminaCliServiceError("即梦 CLI 尚未完成有效授权，不能启用模型", 409);
    }
    const settings = await getAuthSettings();
    const existing = dreaminaCliChannel(settings);
    const normalModels = requested.filter((id) => !DREAMINA_CLI_OPERATION_ONLY_MODEL_IDS.has(id));
    const base = applyChannelProtocol(
        {
            ...(existing || defaultDreaminaCliChannel()),
            id: DREAMINA_CLI_CHANNEL_ID,
            name: DREAMINA_CLI_CHANNEL_NAME,
            baseUrl: "",
            apiKey: "",
            apiFormat: "openai",
            models: normalModels,
            enabled: requested.length > 0,
        },
        DREAMINA_CLI_PROTOCOL,
    );
    const modelCapabilities = Object.fromEntries(requested.map((id) => [normalizeModelId(id), dreaminaCliModel(id)!.capability]));
    const modelConfigs = Object.fromEntries(requested.map((id) => [normalizeModelId(id), dreaminaCliModelConfig(id)]));
    const channel: SystemModelChannel = {
        ...base,
        apiKey: "",
        hasApiKey: false,
        advancedConfig: {
            ...base.advancedConfig!,
            protocol: DREAMINA_CLI_PROTOCOL,
            authMode: "provider-managed",
            modelCatalogPaths: [],
            modelCapabilities,
            modelConfigs,
        },
    };
    const channels = existing ? settings.systemChannels.map((item) => (item.id === existing.id ? channel : item)) : [...settings.systemChannels, channel];
    const existingLogicalIds = new Set(settings.logicalModels.map((model) => model.id));
    const logicalModels = synchronizeLogicalModelsWithChannels(settings.logicalModels, channels).map((model) => {
        if (existingLogicalIds.has(model.id)) return model;
        const binding = model.bindings.find((item) => item.channelId === DREAMINA_CLI_CHANNEL_ID);
        const catalog = dreaminaCliModel(binding?.upstreamModel);
        return catalog ? { ...model, name: catalog.displayName } : model;
    });
    const defaultModels = normalizeDefaultModelsConfig(settings.defaultModels, logicalModels, channels);
    await setAuthSettings({ systemChannels: channels, logicalModels, defaultModels });
    return { enabledModelIds: requested, models: publicCatalog().map((model) => ({ ...model, enabled: requested.includes(model.id) })), channel: publicChannel(channel) };
}

export async function getDreaminaCliPublicStatus() {
    const [state, settings] = await Promise.all([getDreaminaCliAccountState(), getAuthSettings()]);
    return {
        enabled: dreaminaCliOperationEnabled(settings, "dreamina-image-upscale"),
        authorized: state.status === "authorized",
        ...(state.vipLevel ? { vipLevel: state.vipLevel } : {}),
        checkedAt: state.lastCreditCheckedAt || state.lastSuccessAt || state.updatedAt,
    };
}

export function isDreaminaCliConfig(config: { advancedConfig?: { protocol?: string }; channelId?: string }) {
    return config.advancedConfig?.protocol === DREAMINA_CLI_PROTOCOL || config.channelId === DREAMINA_CLI_CHANNEL_ID;
}

export function dreaminaCliOperationEnabled(settings: AuthSettings, modelId: string) {
    const channel = dreaminaCliChannel(settings);
    return Boolean(channel?.enabled && enabledDreaminaCliModelIds(channel).includes(modelId));
}

/** The current official CLI returns credit_count with a successful submit. */
export async function submitDreaminaCliTaskWithCreditObservation(input: DreaminaCliSubmissionInput, context: { taskId?: string; attemptNo?: number; modelId?: string; timeoutMs?: number; runner?: DreaminaCliRunner }) {
    const capability = dreaminaCliCommandCapability(input.command);
    const timeoutMs = context.timeoutMs || resolveModelRequestTimeoutMs(undefined, capability);
    const lease = await acquireDreaminaCliSubmitLease({ owner: `dreamina-submit-${randomUUID()}`, taskId: context.taskId, leaseUntil: new Date(Date.now() + timeoutMs) });
    if (!lease) {
        const activeLease = await getDreaminaCliAccountState();
        const leaseUntil = Date.parse(activeLease.submitLeaseUntil || "");
        const retryAfterAt = Number.isFinite(leaseUntil) && leaseUntil > Date.now() ? leaseUntil : undefined;
        await appendDreaminaCliRequestLog({
            command: input.command,
            phase: "preflight",
            capability,
            model: context.modelId || input.modelId,
            status: "deferred",
            creditObservation: "unavailable",
            requestSummary: { deferred: "account_lease" },
            resultSummary: {},
        });
        throw new DreaminaCliServiceError("即梦 CLI 正在处理其他提交，系统会在当前提交结束后自动继续", 409, retryAfterAt);
    }
    const startedAt = Date.now();
    try {
        if (dreaminaCliRequiresVip(input) && !hasDreaminaCliVip(lease.account.vipLevel)) {
            throw new DreaminaCliProviderError("所选即梦 CLI 模型或分辨率需要 VIP 会员，请先刷新账号状态", 403, "not_started");
        }
        const submission = await submitDreaminaCliTask(input, { runner: context.runner, timeoutMs });
        const officialCreditCost = submission.creditCost;
        const completedAt = new Date().toISOString();
        await updateDreaminaCliAccountState({
            status: "authorized",
            lastSuccessAt: completedAt,
            lastErrorCode: undefined,
            lastErrorMessage: undefined,
        });
        await appendDreaminaCliRequestLog({
            taskId: context.taskId,
            attemptNo: context.attemptNo,
            command: input.command,
            phase: "submit",
            capability,
            model: context.modelId || input.modelId,
            upstreamModel: dreaminaCliModel(input.modelId)?.upstreamModel,
            status: "started",
            durationMs: Date.now() - startedAt,
            submissionId: submission.submitId,
            ...(officialCreditCost !== undefined ? { observedCreditDelta: officialCreditCost } : {}),
            creditObservation: officialCreditCost !== undefined ? "official" : "unavailable",
            requestSummary: requestSummary(input),
            submissionSummary: { accepted: true, submitId: submission.submitId, ...(officialCreditCost !== undefined ? { officialCreditCost } : {}) },
            resultSummary: {},
        });
        return { ...submission, creditObservation: { kind: officialCreditCost !== undefined ? ("official" as const) : ("unavailable" as const), ...(officialCreditCost !== undefined ? { delta: officialCreditCost } : {}) } };
    } catch (error) {
        const provider = error instanceof DreaminaCliProviderError ? error : null;
        const uncertain = provider?.submissionState === "unknown";
        const failureStatus = uncertain ? "needs_review" : "failed";
        await updateDreaminaCliAccountState({
            status: accountStatusFromError(provider?.message || "", lease.account.status),
            lastErrorCode: uncertain ? "submission_outcome_unknown" : "cli_submit_failed",
            lastErrorMessage: safeServiceMessage(error),
        });
        await appendDreaminaCliRequestLog({
            taskId: context.taskId,
            attemptNo: context.attemptNo,
            command: input.command,
            phase: "submit",
            capability,
            model: context.modelId || input.modelId,
            upstreamModel: dreaminaCliModel(input.modelId)?.upstreamModel,
            status: failureStatus,
            durationMs: Date.now() - startedAt,
            creditObservation: "unavailable",
            errorCode: uncertain ? "submission_outcome_unknown" : "cli_submit_failed",
            error: safeServiceMessage(error),
            requestSummary: requestSummary(input),
            resultSummary: {},
        });
        if (error instanceof DreaminaCliServiceError || error instanceof DreaminaCliProviderError) throw error;
        throw new DreaminaCliServiceError(safeServiceMessage(error));
    } finally {
        await releaseDreaminaCliSubmitLease(lease.owner);
    }
}

function dreaminaCliChannel(settings: AuthSettings) {
    return settings.systemChannels.find((channel) => channel.id === DREAMINA_CLI_CHANNEL_ID || channel.advancedConfig?.protocol === DREAMINA_CLI_PROTOCOL);
}

function defaultDreaminaCliChannel(): SystemModelChannel {
    return {
        id: DREAMINA_CLI_CHANNEL_ID,
        name: DREAMINA_CLI_CHANNEL_NAME,
        baseUrl: "",
        apiKey: "",
        apiFormat: "openai",
        models: [],
        enabled: false,
    };
}

function enabledDreaminaCliModelIds(channel: SystemModelChannel | undefined) {
    if (!channel) return [];
    const normal = channel.models.map((model) => normalizeModelId(model)).filter(isDreaminaCliModelId);
    const operations = Object.keys(channel.advancedConfig?.modelConfigs || {})
        .map((model) => normalizeModelId(model))
        .filter((model) => DREAMINA_CLI_OPERATION_ONLY_MODEL_IDS.has(model));
    return Array.from(new Set([...normal, ...operations]));
}

function dreaminaCliModelConfig(id: string): SystemChannelModelConfig {
    const model = dreaminaCliModel(id);
    if (!model) throw new DreaminaCliServiceError("即梦模型不存在", 422);
    return {
        capability: model.capability,
        source: "official",
        apiFormat: "openai",
        protocol: DREAMINA_CLI_PROTOCOL,
        referenceRule: model.commands.includes("multimodal2video") ? "服务器只接收已归属的图片、视频和音频素材，由 Dreamina CLI staged upload。" : "服务器只接收已归属素材，由 Dreamina CLI staged upload。",
        supportsReferenceImage: model.commands.some((command) => command !== "text2image" && command !== "text2video"),
        supportsReferenceVideo: model.commands.includes("multimodal2video"),
        supportsReferenceAudio: model.commands.includes("multimodal2video"),
    };
}

function publicRuntime(state: DreaminaCliAccountState): DreaminaCliOverview["runtime"] {
    const account = state.status === "authorized" && state.totalCredit !== undefined ? { userIdMasked: maskRemoteUserId(state.userId || ""), vipLevel: state.vipLevel || "", totalCredit: state.totalCredit } : undefined;
    return {
        installed: Boolean(state.cliVersion),
        authorized: state.status === "authorized",
        ...(state.cliVersion ? { version: state.cliVersion } : {}),
        ...(state.cliCommit ? { commit: state.cliCommit } : {}),
        ...(state.cliBuildTime ? { buildTime: state.cliBuildTime } : {}),
        ...(account ? { account } : {}),
        checkedAt: state.lastCreditCheckedAt || state.lastSuccessAt || state.updatedAt,
        ...(state.lastErrorMessage ? { error: state.lastErrorMessage } : {}),
    };
}

function publicCatalog() {
    return DREAMINA_CLI_MODELS.map(({ operationOnly: _operationOnly, commands: _commands, ...model }) => model);
}

function publicChannel(channel: SystemModelChannel) {
    return { id: channel.id, name: channel.name, enabled: channel.enabled, models: enabledDreaminaCliModelIds(channel) };
}

function uniqueModelIds(value: unknown) {
    if (!Array.isArray(value)) throw new DreaminaCliServiceError("modelIds 必须为数组", 400);
    return Array.from(new Set(value.map((item) => (typeof item === "string" ? item.trim().toLowerCase() : "")).filter(Boolean))).slice(0, DREAMINA_CLI_MODELS.length);
}

function requestSummary(input: DreaminaCliSubmissionInput) {
    return {
        command: input.command,
        ...(input.resolutionType ? { resolutionType: input.resolutionType } : {}),
        ...(input.videoResolution ? { videoResolution: input.videoResolution } : {}),
        ...(input.duration !== undefined ? { duration: input.duration } : {}),
        ...(input.generateNum !== undefined ? { generateNum: input.generateNum } : {}),
        inputImageCount: input.images?.length || 0,
        inputVideoCount: input.videos?.length || 0,
        inputAudioCount: input.audios?.length || 0,
    };
}

function accountStatusFromError(message: string, fallback: DreaminaCliAccountState["status"]): DreaminaCliAccountState["status"] {
    const normalized = message.toLowerCase();
    if (/\bvip\b|会员/.test(normalized)) return "authorized";
    if (/(?:login|登录|unauthorized|not.?logged)/.test(normalized)) return "not_logged_in";
    if (/(?:permission|forbidden|权限)/.test(normalized)) return "permission_denied";
    if (/aigccomplianceconfirmationrequired|合规/.test(normalized)) return "compliance_required";
    if (/(?:无法启动|不可用|not found|enoent|eacces)/.test(normalized)) return "error";
    return fallback;
}

function hasDreaminaCliVip(value: string | undefined) {
    const level = value?.trim().toLowerCase() || "";
    return Boolean(level && !["0", "free", "guest", "none", "normal"].includes(level));
}

function safeServiceMessage(error: unknown) {
    const message = error instanceof Error ? error.message : "即梦 CLI 服务失败";
    return message
        .replace(/(?:https?:\/\/|file:\/\/)[^\s"']+/gi, "[已隐藏地址]")
        .replace(/(?:^|\s)\/?(?:Users|home|tmp|var|private|workspace)\/[^\s"']+/g, " [已隐藏路径]")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 500);
}

function maskRemoteUserId(value: string) {
    if (!value) return "";
    return value.length <= 4 ? "****" : `${value.slice(0, 2)}****${value.slice(-2)}`;
}
