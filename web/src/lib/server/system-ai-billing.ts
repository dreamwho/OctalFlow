import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const SYSTEM_AI_LOGICAL_MODEL_HEADER = "x-dreamyo-logical-model";
export const SYSTEM_AI_POINTS_IDEMPOTENCY_HEADER = "x-dreamyo-points-idempotency-key";
export const SYSTEM_AI_POINTS_SIGNATURE_HEADER = "x-dreamyo-points-signature";
export const SYSTEM_AI_UPSTREAM_MODEL_HEADER = "x-dreamyo-upstream-model";

const SYSTEM_AI_POINTS_SIGNATURE_VERSION = "v1";
const SYSTEM_AI_POINTS_PROCESS_SECRET = "__dreamyoProSystemAiPointsProcessSecret" as const;

export type SystemAiBilling = {
    pointsCost?: number;
    pointsRecordId?: string;
};

export function systemAiBillingHeaders(logicalModel: string, idempotencyKey?: string, upstreamModel?: string) {
    const normalizedLogicalModel = logicalModel.trim();
    const normalizedIdempotencyKey = idempotencyKey?.trim();
    const normalizedUpstreamModel = upstreamModel?.trim();
    return {
        ...(normalizedLogicalModel ? { [SYSTEM_AI_LOGICAL_MODEL_HEADER]: normalizedLogicalModel } : {}),
        ...(normalizedIdempotencyKey
            ? {
                  [SYSTEM_AI_POINTS_IDEMPOTENCY_HEADER]: normalizedIdempotencyKey,
                  [SYSTEM_AI_POINTS_SIGNATURE_HEADER]: signSystemAiBusinessRequest(normalizedLogicalModel, normalizedIdempotencyKey, normalizedUpstreamModel || ""),
              }
            : {}),
        ...(normalizedUpstreamModel ? { [SYSTEM_AI_UPSTREAM_MODEL_HEADER]: normalizedUpstreamModel } : {}),
    };
}

export function readVerifiedSystemAiBusinessRequestId(headers: Headers, logicalModel: string, upstreamModel: string) {
    const businessRequestId = headers.get(SYSTEM_AI_POINTS_IDEMPOTENCY_HEADER)?.trim().slice(0, 200) || "";
    const signature = headers.get(SYSTEM_AI_POINTS_SIGNATURE_HEADER)?.trim() || "";
    if (!businessRequestId || !signature) return undefined;
    const expected = signSystemAiBusinessRequest(logicalModel.trim(), businessRequestId, upstreamModel.trim());
    const receivedBytes = Buffer.from(signature);
    const expectedBytes = Buffer.from(expected);
    if (receivedBytes.length !== expectedBytes.length || !timingSafeEqual(receivedBytes, expectedBytes)) return undefined;
    return businessRequestId;
}

export function systemAiPointsIdempotencyKey(input: { userId: string; businessRequestId: string; logicalModel: string; channelId: string; upstreamModel: string; callType: string }) {
    return `system-ai:${stableDigest([input.userId, input.businessRequestId, input.logicalModel, input.channelId, input.upstreamModel, input.callType])}`;
}

export function systemAiRequestFingerprint(input: { method: string; callType: string; logicalModel: string; channelId: string; upstreamModel: string; usageKind: string; amount: number; bodyDigest: string }) {
    return stableDigest([input.method.toUpperCase(), input.callType, input.logicalModel, input.channelId, input.upstreamModel, input.usageKind, String(input.amount), input.bodyDigest]);
}

export function systemAiIdempotencyKey(scope: string, ...parts: string[]) {
    const prefix =
        scope
            .trim()
            .replace(/[^a-zA-Z0-9._-]+/g, "-")
            .slice(0, 40) || "system-ai";
    const digest = createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 32);
    return `${prefix}:${digest}`;
}

function signSystemAiBusinessRequest(logicalModel: string, businessRequestId: string, upstreamModel: string) {
    return createHmac("sha256", systemAiPointsSigningSecret())
        .update([SYSTEM_AI_POINTS_SIGNATURE_VERSION, normalizeBillingModel(logicalModel), businessRequestId, normalizeBillingModel(upstreamModel)].join("\0"))
        .digest("base64url");
}

function stableDigest(parts: string[]) {
    return createHash("sha256").update(parts.join("\0")).digest("hex");
}

function normalizeBillingModel(value: string) {
    return value
        .trim()
        .replace(/^models\//i, "")
        .toLowerCase();
}

function systemAiPointsSigningSecret() {
    const configured = process.env.DREAMYO_ENCRYPTION_KEY?.trim();
    if (configured) return configured;
    const scope = globalThis as typeof globalThis & { __dreamyoProSystemAiPointsProcessSecret?: Buffer };
    scope[SYSTEM_AI_POINTS_PROCESS_SECRET] ||= randomBytes(32);
    return scope[SYSTEM_AI_POINTS_PROCESS_SECRET];
}

export function readSystemAiBilling(headers: Headers): SystemAiBilling {
    const rawCost = headers.get("x-dreamyo-points-cost");
    const cost = rawCost === null ? undefined : Number(rawCost);
    return {
        pointsCost: cost !== undefined && Number.isFinite(cost) && cost >= 0 ? cost : undefined,
        pointsRecordId: headers.get("x-dreamyo-points-record-id") || undefined,
    };
}

export function hasSystemAiCharge(billing: SystemAiBilling): billing is Required<SystemAiBilling> {
    return billing.pointsCost !== undefined && Boolean(billing.pointsRecordId);
}

export function signedInternalTrafficHeaders(url: string | URL, method: string, context?: { taskId?: string; requestId?: string; attemptId?: string }): Record<string, string> {
    const identity = Object.fromEntries((["taskId", "requestId", "attemptId"] as const).flatMap((key) => context?.[key] ? [[key, context[key]]] : []));
    if (!Object.keys(identity).length) return {};
    const payload = Buffer.from(JSON.stringify(identity)).toString("base64url");
    return { "x-dreamyo-internal-traffic": payload, "x-dreamyo-internal-traffic-signature": signInternalTraffic(url, method, payload) };
}

export function readVerifiedInternalTraffic(headers: Headers, url: string | URL, method: string): { taskId?: string; requestId?: string; attemptId?: string } {
    const payload = headers.get("x-dreamyo-internal-traffic") || "";
    const signature = headers.get("x-dreamyo-internal-traffic-signature") || "";
    if (!payload || !signature) return {};
    const expected = Buffer.from(signInternalTraffic(url, method, payload));
    const received = Buffer.from(signature);
    if (expected.length !== received.length || !timingSafeEqual(expected, received)) return {};
    try {
        const identity = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
        return Object.fromEntries((["taskId", "requestId", "attemptId"] as const).flatMap((key) => typeof identity?.[key] === "string" && identity[key].trim() && identity[key].length <= 200 ? [[key, identity[key]]] : []));
    } catch { return {}; }
}

function signInternalTraffic(url: string | URL, method: string, payload: string) {
    const target = new URL(url);
    return createHmac("sha256", systemAiPointsSigningSecret()).update(["traffic-v1", method.toUpperCase(), target.pathname + target.search, payload].join("\0")).digest("base64url");
}
