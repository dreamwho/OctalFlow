export type DolaAccountStatus = "unverified" | "ready" | "needs_login" | "verification_required" | "quota_exhausted" | "rate_limited" | "restricted" | "disabled";

export type DolaQuotaSnapshot = {
    bucket: string;
    model?: string;
    unit: "count" | "credit" | "unknown";
    remaining: number | null;
    limit: number | null;
    resetAt?: string;
    observedAt: string;
    source: "upstream" | "local" | "unknown";
    version: number;
};

export type DolaAccountValidation = {
    checkedAt: string;
    ready: boolean;
    login: boolean;
    signerReady: boolean;
    requestObserved: boolean;
    signed: boolean;
    httpStatus: number;
    identitySource?: string;
    proxyMode: "direct" | "magic" | "generic" | "chained";
    proxyTarget?: string;
    error?: string;
    generation?: { status: "success" | "failed" | "unknown"; checkedAt: string; taskId: string; model?: string; error?: string };
};

export type DolaAccount = {
    id: string;
    name: string;
    email?: string;
    status: DolaAccountStatus;
    enabled: boolean;
    credentialVersion: number;
    quota?: DolaQuotaSnapshot[];
    requestCount: number;
    successCount: number;
    errorCount: number;
    activeAttempts: number;
    lastUsedAt?: string;
    lastVerifiedAt?: string;
    /** 只读启动协议返回的实时 Cookie 登录态；与生成协议可用性分开记录。 */
    loginState?: "ready" | "needs_login" | "unknown";
    loginCheckedAt?: string;
    loginProtocolCode?: number;
    /** 最近一次被上游标记 rate_limited 的时间（冷却期内不参与调度） */
    rateLimitedAt?: string;
    /** 判定风控时上游返回的原始错误/标记值，用于在后台展示风控原因 */
    restrictedReason?: string;
    /** 最近一次使用该账号当前代理出口执行的页面签名协议验证。 */
    validation?: DolaAccountValidation;
    /** 账号授权类型：Cookie 导入 或 Google 浏览器授权登录 */
    authType?: "cookie" | "google";
    createdAt: string;
    updatedAt: string;
};

export type DolaAccountImportItem = {
    cookie: string;
    name?: string;
    email?: string;
    authType?: "cookie" | "google";
    sourceFileName?: string;
    sourceOrdinal?: number;
};

export type DolaAccountImportResult = {
    itemId: string;
    sourceFileName?: string;
    sourceOrdinal?: number;
    status: "created" | "updated" | "duplicate" | "invalid" | "needs_login" | "verification_required";
    account?: DolaAccount;
    message?: string;
};

export type DolaModelProfile = {
    id: "dola-seedance-2-5" | "dola-seedance-2-0-fast" | "dola-seedream-4-5";
    label: string;
    upstreamModelId: "seedance_v2.5" | "seedance_v2.0" | "Seedream 4.5";
    durations: number[];
    aspectRatios: string[];
    referenceRoles: Array<"reference" | "first_frame" | "last_frame">;
    supportsReferenceImage: true;
    capability: "video" | "image";
    transport: "protocol-page-signed";
    revision: string;
    evidenceCaseIds: string[];
};

export const DOLA_MODEL_PROFILES: readonly DolaModelProfile[] = [
    {
        id: "dola-seedance-2-5",
        label: "Dola Seedance 2.5",
        upstreamModelId: "seedance_v2.5",
        durations: [5, 10, 15, 30],
        aspectRatios: ["1:1", "3:4", "4:3", "9:16", "16:9", "21:9"],
        referenceRoles: ["reference", "first_frame", "last_frame"],
        supportsReferenceImage: true,
        capability: "video",
        transport: "protocol-page-signed",
        revision: "dola-web-2026-09-17",
        evidenceCaseIds: ["DOLA-ENV-CAMOUFOX-F005-I1", "DOLA-ENV-CAMOUFOX-IPWO-TW-F005-I1", "DOLA-PROTOCOL-MAINWORLD-F005-I1"],
    },
    {
        id: "dola-seedance-2-0-fast",
        label: "Dola Seedance 2.0 Fast",
        upstreamModelId: "seedance_v2.0",
        durations: [5, 10, 15],
        aspectRatios: ["1:1", "3:4", "4:3", "9:16", "16:9", "21:9"],
        referenceRoles: ["reference", "first_frame", "last_frame"],
        supportsReferenceImage: true,
        capability: "video",
        transport: "protocol-page-signed",
        revision: "dola-web-2026-09-17",
        evidenceCaseIds: ["DOLA-ENV-CAMOUFOX-F005-I1", "DOLA-ENV-CAMOUFOX-IPWO-TW-F005-I1", "DOLA-PROTOCOL-MAINWORLD-F005-I1"],
    },
    {
        id: "dola-seedream-4-5",
        label: "Dola Seedream 4.5",
        upstreamModelId: "Seedream 4.5",
        durations: [],
        aspectRatios: ["1:1", "3:4", "4:3", "9:16", "16:9", "21:9"],
        referenceRoles: [],
        supportsReferenceImage: true,
        capability: "image",
        transport: "protocol-page-signed",
        revision: "dola-web-2026-09-17",
        evidenceCaseIds: ["DOLA-PROTOCOL-MAINWORLD-IMAGE-I1"],
    },
];

export function dolaModelProfile(model: string) {
    const normalized = model.trim().toLowerCase();
    return DOLA_MODEL_PROFILES.find((item) => item.id === normalized || item.upstreamModelId.toLowerCase() === normalized);
}

export function dolaPublicModels() {
    return DOLA_MODEL_PROFILES.map((profile) => ({
        id: profile.id,
        name: profile.label,
        capabilities: [profile.capability],
        enabled: true,
        source: "dola" as const,
        durations: profile.durations,
        aspectRatios: profile.aspectRatios,
        supportsReferenceImage: profile.supportsReferenceImage,
        transport: profile.transport,
        revision: profile.revision,
    }));
}
