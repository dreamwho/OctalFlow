import { cookies } from "next/headers";
import type { NextResponse } from "next/server";

import { deleteSession, getPublicUsersByIds, getUserBySession, sessionMaxAgeSeconds, type AuthSettings, type PublicUser } from "./store";
import { authorizedWorkerUserId } from "@/lib/server/maintenance-auth";
import { getTrustedProxyHops } from "@/lib/server/trusted-proxy";
import { parseSessionCookie } from "./store-normalizers";
import { normalizeModelId } from "@/lib/model-capability";
import { roleModelAccessAllows, userRoleDefinition } from "@/lib/user-roles";

const SESSION_COOKIE_NAME = "dreamyo_session";

type CurrentUser = PublicUser;

async function getSessionCookieValue() {
    const cookieStore = await cookies();
    return cookieStore.get(SESSION_COOKIE_NAME)?.value;
}

export async function getCurrentUser(request?: Request) {
    const sessionUser = await getUserBySession(await getSessionCookieValue());
    if (sessionUser || !request) return sessionUser;
    const workerUserId = authorizedWorkerUserId(request);
    if (!workerUserId) return null;
    const workerUser = (await getPublicUsersByIds([workerUserId]))[0];
    return workerUser?.status === "active" ? workerUser : null;
}

export async function clearCurrentSession() {
    await deleteSession(await getSessionCookieValue());
}

export async function getCurrentSessionId() {
    return parseSessionCookie(await getSessionCookieValue())?.id;
}

export function setSessionCookie(response: NextResponse, value: string, request?: Request) {
    response.cookies.set(SESSION_COOKIE_NAME, value, {
        httpOnly: true,
        sameSite: "lax",
        secure: shouldUseSecureSessionCookie(request),
        maxAge: sessionMaxAgeSeconds(),
        path: "/",
    });
}

export function clearSessionCookie(response: NextResponse, request?: Request) {
    const secure = shouldUseSecureSessionCookie(request);
    response.cookies.set(SESSION_COOKIE_NAME, "", {
        httpOnly: true,
        sameSite: "lax",
        secure,
        maxAge: 0,
        path: "/",
    });
}

function shouldUseSecureSessionCookie(request?: Request) {
    const override = process.env.DREAMYO_COOKIE_SECURE?.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(override || "")) return true;
    if (["0", "false", "no", "off"].includes(override || "")) return false;

    if (getTrustedProxyHops() > 0) {
        const forwardedProto = request?.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
        if (forwardedProto) return forwardedProto === "https";

        const forwarded = request?.headers.get("forwarded") || "";
        const forwardedProtoMatch = forwarded.match(/(?:^|;|,)\s*proto=([^;,]+)/i);
        if (forwardedProtoMatch?.[1]) return forwardedProtoMatch[1].replace(/^"|"$/g, "").toLowerCase() === "https";
    }

    if (request?.url) {
        try {
            return new URL(request.url).protocol === "https:";
        } catch {
            return false;
        }
    }

    return false;
}

export function serializeCurrentUser(user: CurrentUser) {
    return {
        id: user.id,
        accountId: user.accountId,
        username: user.username,
        email: user.email,
        displayName: user.displayName,
        bio: user.bio,
        avatarUrl: user.avatarUrl,
        role: user.role,
        adminPermissions: [...user.adminPermissions],
        status: user.status,
        planId: user.planId,
        planName: user.planName,
        hasActivePlan: user.hasActivePlan,
        pointsBalance: user.pointsBalance,
        permanentPointsBalance: user.permanentPointsBalance,
        dailyPointsBalance: user.dailyPointsBalance,
        dailyPointsExpiresAt: user.dailyPointsExpiresAt,
        mfaEnabled: user.mfaEnabled,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
        lastLoginAt: user.lastLoginAt,
    };
}

export function serializePublicSettings(settings: AuthSettings, user?: Pick<PublicUser, "role">) {
    const role = user?.role || "user";
    const rolePolicy = userRoleDefinition(settings.userRoles, role);
    const pointFactor = role === "admin" ? 1 : rolePolicy?.recordOnly ? 0 : rolePolicy?.pointsMultiplier ?? 1;
    const permittedModels = settings.logicalModels.filter((model) => model.enabled && roleModelAccessAllows(settings.userRoles, role, model.id, model.capability));
    const permittedUpstreamModels = new Set(permittedModels.flatMap((model) => model.bindings.filter((binding) => binding.enabled).map((binding) => normalizeModelId(binding.upstreamModel))));
    const visiblePricedModels = new Set(permittedModels.flatMap((model) => [model.id, ...model.bindings.filter((binding) => binding.enabled).map((binding) => binding.upstreamModel)].map(normalizeModelId)));
    const visiblePointCosts = Object.fromEntries(Object.entries(settings.modelPointCosts).filter(([model]) => role === "admin" || rolePolicy?.modelAccess.all || visiblePricedModels.has(normalizeModelId(model))).map(([model, cost]) => [model, Number((cost * pointFactor).toFixed(4))]));
    const modelDefaults = Object.fromEntries((["image", "video", "text", "audio"] as const).map((capability) => {
        const configured = settings.defaultModels[`${capability}Model`];
        const permitted = permittedModels.find((model) => model.capability === capability && (model.id === configured || model.pickerVisible !== false));
        return [`${capability}Model`, permitted?.id || ""];
    })) as AuthSettings["defaultModels"];
    return {
        site: {
            title: settings.site.title,
            logoUrl: settings.site.logoUrl,
            iconUrl: settings.site.iconUrl,
            seoDescription: settings.site.seoDescription,
            footerCopyright: settings.site.footerCopyright,
            termsUrl: settings.site.termsUrl,
            termsVersion: settings.site.termsVersion,
            privacyUrl: settings.site.privacyUrl,
            privacyVersion: settings.site.privacyVersion,
            friendLinks: settings.site.friendLinks.map((item) => ({ id: item.id, label: item.label, url: item.url, enabled: item.enabled })),
            socials: Object.fromEntries(Object.entries(settings.site.socials).map(([key, item]) => [key, { enabled: item.enabled, label: item.label, url: item.url }])),
            frontendTheme: settings.site.frontendTheme || "dark",
            adminTheme: settings.site.adminTheme || "dark",
        },
        registrationEnabled: settings.registrationEnabled,
        emailRegistrationEnabled: settings.emailRegistrationEnabled,
        loginMethods: { ...settings.loginMethods },
        modelPointCosts: visiblePointCosts,
        generationPointMultipliers: {
            imageQuality: { ...settings.generationPointMultipliers.imageQuality },
            videoQuality: { ...settings.generationPointMultipliers.videoQuality },
            videoSeconds: { ...settings.generationPointMultipliers.videoSeconds },
        },
        generationConcurrency: { ...settings.generationConcurrency },
        generationDefaults: {
            canvasImageCount: settings.generationDefaults.canvasImageCount,
            imageSize: settings.generationDefaults.imageSize,
            imageQuality: settings.generationDefaults.imageQuality,
            imageCount: settings.generationDefaults.imageCount,
            imageMaxCount: settings.generationDefaults.imageMaxCount,
            videoQuality: settings.generationDefaults.videoQuality,
            videoSeconds: settings.generationDefaults.videoSeconds,
            audioVoice: settings.generationDefaults.audioVoice,
            audioFormat: settings.generationDefaults.audioFormat,
        },
        defaultModels: modelDefaults,
        modelPickerGroups: settings.modelPickerGroups,
        logicalModels: permittedModels
            .map((model) => ({
                id: model.id,
                name: model.name,
                capability: model.capability,
                pickerGroup: model.pickerGroup,
                icon: model.icon,
                enabled: true,
                pickerVisible: model.pickerVisible !== false,
                bindings: model.bindings
                    .filter((binding) => binding.enabled)
                    .map((binding) => ({
                        id: binding.id,
                        channelId: binding.channelId,
                        upstreamModel: binding.upstreamModel,
                        enabled: true,
                        priority: binding.priority,
                        ...(binding.displayName ? { displayName: binding.displayName } : {}),
                    })),
            })),
        systemChannels: settings.systemChannels
            .filter((channel) => channel.enabled)
            .map((channel) => ({ ...channel, models: channel.models.filter((model) => permittedUpstreamModels.has(normalizeModelId(model))) }))
            .filter((channel) => channel.models.length > 0)
            .map((channel) => ({
                id: channel.id,
                name: channel.name,
                baseUrl: `/api/ai/system/${channel.id}`,
                apiKey: "system",
                apiFormat: channel.apiFormat,
                models: channel.models,
                enabled: channel.enabled,
                hasApiKey: Boolean(channel.apiKey) || channel.advancedConfig?.authMode === "provider-managed",
                ...publicAudioAdvancedConfig(channel.advancedConfig),
            })),
    };
}

function publicAudioAdvancedConfig(config: AuthSettings["systemChannels"][number]["advancedConfig"]) {
    if (config?.protocol !== "minimax-audio" && config?.protocol !== "aliyun-bailian-audio") return {};
    return {
        advancedConfig: {
            protocol: config.protocol,
            ...(typeof config.minimaxVoiceCloneEnabled === "boolean" ? { minimaxVoiceCloneEnabled: config.minimaxVoiceCloneEnabled } : {}),
            ...(typeof config.minimaxVoiceDesignEnabled === "boolean" ? { minimaxVoiceDesignEnabled: config.minimaxVoiceDesignEnabled } : {}),
            ...(typeof config.minimaxMusicEnabled === "boolean" ? { minimaxMusicEnabled: config.minimaxMusicEnabled } : {}),
        },
    };
}
