import { randomUUID } from "node:crypto";

import dayjs from "dayjs";
import timezone from "dayjs/plugin/timezone";
import utc from "dayjs/plugin/utc";

import { readJsonDataFile, withJsonDataFileLock, writeJsonDataFile } from "@/lib/server/data-adapter";
import { ensurePostgresSchema, isPostgresDatabaseEnabled, postgresQuery } from "@/lib/server/database";
import { DreaminaCliRepository } from "@/lib/server/database/dreamina-cli-repository";

const FILE_NAME = "dreamina-cli.json";
const DEFAULT_TIME_ZONE = "Asia/Shanghai";

dayjs.extend(utc);
dayjs.extend(timezone);

export type DreaminaCliAccountStatus = "unconfigured" | "unverified" | "authorized" | "not_logged_in" | "permission_denied" | "compliance_required" | "error";
export type DreaminaCliRequestCommand = "version" | "user_credit" | "text2image" | "image2image" | "image_upscale" | "text2video" | "image2video" | "frames2video" | "multiframe2video" | "multimodal2video" | "query_result" | "download";
export type DreaminaCliRequestPhase = "preflight" | "submit" | "query" | "download" | "account_refresh";
export type DreaminaCliRequestStatus = "started" | "success" | "failed" | "needs_review" | "deferred";
export type DreaminaCliCreditObservation = "official" | "unavailable" | "observed" | "ambiguous" | "inconsistent";

export type DreaminaCliAccountState = {
    id: "default";
    status: DreaminaCliAccountStatus;
    userId?: string;
    userName?: string;
    vipLevel?: string;
    totalCredit?: number;
    cliVersion?: string;
    cliCommit?: string;
    cliBuildTime?: string;
    executableFingerprint?: string;
    lastCreditCheckedAt?: string;
    lastSuccessAt?: string;
    lastErrorCode?: string;
    lastErrorMessage?: string;
    submitLeaseOwner?: string;
    submitLeaseTaskId?: string;
    submitLeaseUntil?: string;
    createdAt: string;
    updatedAt: string;
};

export type DreaminaCliRequestLog = {
    id: string;
    createdAt: string;
    updatedAt: string;
    taskId?: string;
    attemptNo?: number;
    command: DreaminaCliRequestCommand;
    phase: DreaminaCliRequestPhase;
    capability?: "image" | "video";
    model?: string;
    upstreamModel?: string;
    status: DreaminaCliRequestStatus;
    durationMs?: number;
    submissionId?: string;
    succeededAt?: string;
    failedAt?: string;
    beforeCredit?: number;
    afterCredit?: number;
    observedCreditDelta?: number;
    creditObservation: DreaminaCliCreditObservation;
    errorCode?: string;
    error?: string;
    requestSummary: Record<string, unknown>;
    submissionSummary: Record<string, unknown>;
    resultSummary: Record<string, unknown>;
};

export type DreaminaCliStatsRange = "all" | "week" | "month" | "year";
export type DreaminaCliRequestStats = {
    range: DreaminaCliStatsRange;
    startAt?: string;
    endAt: string;
    timeZone: string;
    total: number;
    success: number;
    failed: number;
    needsReview: number;
    officialCredits: number;
    observedCredits: number;
};
export type DreaminaCliStatsWindow = Pick<DreaminaCliRequestStats, "range" | "startAt" | "endAt" | "timeZone">;
type DreaminaCliDatabase = { account?: DreaminaCliAccountState; logs: DreaminaCliRequestLog[] };
const EMPTY_DATABASE: DreaminaCliDatabase = { logs: [] };

export function emptyDreaminaCliAccountState(): DreaminaCliAccountState {
    const now = new Date().toISOString();
    return { id: "default", status: "unverified", createdAt: now, updatedAt: now };
}

export async function getDreaminaCliAccountState() {
    if (isPostgresDatabaseEnabled()) return (await (await postgresRepository()).getAccountState()) || emptyDreaminaCliAccountState();
    return (await readDatabase()).account || emptyDreaminaCliAccountState();
}

export async function updateDreaminaCliAccountState(patch: Partial<Omit<DreaminaCliAccountState, "id" | "createdAt" | "updatedAt">>) {
    if (isPostgresDatabaseEnabled()) {
        const repository = await postgresRepository();
        const current = (await repository.getAccountState()) || emptyDreaminaCliAccountState();
        return repository.saveAccountState(mergeAccount(current, patch));
    }
    let state!: DreaminaCliAccountState;
    await mutateDatabase((database) => {
        state = mergeAccount(database.account || emptyDreaminaCliAccountState(), patch);
        database.account = state;
    });
    return state;
}

export async function acquireDreaminaCliSubmitLease(input: { owner?: string; taskId?: string; leaseUntil: Date }) {
    const owner = input.owner || `dreamina-cli-${randomUUID()}`;
    if (isPostgresDatabaseEnabled()) {
        const account = await (await postgresRepository()).acquireSubmitLease({ owner, taskId: input.taskId, leaseUntil: input.leaseUntil });
        return account ? { owner, account } : null;
    }
    let result: DreaminaCliAccountState | null = null;
    await mutateDatabase((database) => {
        const account = database.account || emptyDreaminaCliAccountState();
        const leaseActive = account.submitLeaseUntil && Date.parse(account.submitLeaseUntil) >= Date.now() && account.submitLeaseOwner !== owner;
        if (leaseActive) return;
        result = mergeAccount(account, { submitLeaseOwner: owner, submitLeaseTaskId: input.taskId, submitLeaseUntil: input.leaseUntil.toISOString() });
        database.account = result;
    });
    return result ? { owner, account: result } : null;
}

export async function releaseDreaminaCliSubmitLease(owner: string) {
    if (isPostgresDatabaseEnabled()) return (await postgresRepository()).releaseSubmitLease(owner);
    await mutateDatabase((database) => {
        const account = database.account;
        if (!account || account.submitLeaseOwner !== owner) return;
        database.account = mergeAccount(account, { submitLeaseOwner: undefined, submitLeaseTaskId: undefined, submitLeaseUntil: undefined });
    });
}

export async function appendDreaminaCliRequestLog(
    input: Omit<DreaminaCliRequestLog, "id" | "createdAt" | "updatedAt" | "requestSummary" | "submissionSummary" | "resultSummary"> & {
        requestSummary?: Record<string, unknown>;
        submissionSummary?: Record<string, unknown>;
        resultSummary?: Record<string, unknown>;
    },
) {
    const now = new Date().toISOString();
    const log: DreaminaCliRequestLog = {
        ...input,
        id: `dreamina-cli-log-${randomUUID()}`,
        createdAt: now,
        updatedAt: now,
        requestSummary: sanitizeSummary(input.requestSummary),
        submissionSummary: sanitizeSummary(input.submissionSummary),
        resultSummary: sanitizeSummary(input.resultSummary),
        ...(input.error ? { error: safeError(input.error) } : {}),
    };
    if (isPostgresDatabaseEnabled()) return (await postgresRepository()).appendRequestLog(log);
    await mutateDatabase((database) => database.logs.unshift(log));
    return log;
}

/** A submitted CLI task keeps one log row; intermediate polling is deliberately not logged. */
export async function finalizeDreaminaCliRequestLog(input: {
    submissionId: string;
    status: Extract<DreaminaCliRequestStatus, "success" | "failed" | "needs_review">;
    resultSummary?: Record<string, unknown>;
    errorCode?: string;
    error?: string;
    observedCreditDelta?: number;
    creditObservation?: DreaminaCliCreditObservation;
    finishedAt?: string;
}) {
    const submissionId = input.submissionId.trim();
    if (!submissionId) return undefined;
    const finishedAt = input.finishedAt || new Date().toISOString();
    const patch = {
        ...input,
        submissionId,
        finishedAt,
        resultSummary: sanitizeSummary(input.resultSummary),
        ...(input.error ? { error: safeError(input.error) } : {}),
    };
    if (isPostgresDatabaseEnabled()) return (await postgresRepository()).finalizeRequestLogBySubmissionId(patch);
    let updated: DreaminaCliRequestLog | undefined;
    await mutateDatabase((database) => {
        const index = database.logs.findIndex((item) => item.submissionId === submissionId && item.phase === "submit");
        if (index < 0) return;
        const current = database.logs[index]!;
        const finishedAtMs = Date.parse(finishedAt);
        const startedAtMs = Date.parse(current.createdAt);
        const next: DreaminaCliRequestLog = {
            ...current,
            status: input.status,
            updatedAt: finishedAt,
            ...(Number.isFinite(finishedAtMs) && Number.isFinite(startedAtMs) ? { durationMs: Math.max(0, finishedAtMs - startedAtMs) } : {}),
            ...(input.status === "success" ? { succeededAt: finishedAt, failedAt: undefined } : { failedAt: finishedAt }),
            ...(input.observedCreditDelta !== undefined ? { observedCreditDelta: input.observedCreditDelta } : {}),
            ...(input.creditObservation ? { creditObservation: input.creditObservation } : {}),
            ...(input.errorCode ? { errorCode: input.errorCode } : { errorCode: undefined }),
            ...(patch.error ? { error: patch.error } : { error: undefined }),
            resultSummary: patch.resultSummary,
        };
        database.logs[index] = next;
        updated = next;
    });
    return updated;
}

export async function listDreaminaCliRequestLogs(input: { page?: number; pageSize?: number; status?: DreaminaCliRequestStatus; command?: DreaminaCliRequestCommand } = {}) {
    const page = positiveInteger(input.page, 1);
    const pageSize = Math.min(100, positiveInteger(input.pageSize, 20));
    if (isPostgresDatabaseEnabled()) return (await postgresRepository()).listRequestLogs({ page, pageSize, status: input.status, command: input.command });
    const logs = (await readDatabase()).logs;
    const filtered = logs.filter((item) => item.phase !== "query" && (!input.status || item.status === input.status) && (!input.command || item.command === input.command));
    return { items: filtered.slice((page - 1) * pageSize, page * pageSize), total: filtered.length, page, pageSize };
}

export async function dreaminaCliRequestStats(range: DreaminaCliStatsRange = "all", now = new Date()) {
    const window = dreaminaCliStatsWindow(range, now);
    if (isPostgresDatabaseEnabled()) return (await postgresRepository()).requestStats(window);
    return requestStats((await readDatabase()).logs, window);
}

export async function clearDreaminaCliRequestLogs() {
    if (isPostgresDatabaseEnabled()) return (await postgresRepository()).clearRequestLogs();
    let deletedCount = 0;
    await mutateDatabase((database) => {
        deletedCount = database.logs.length;
        database.logs = [];
    });
    return deletedCount;
}

export function requestStats(logs: DreaminaCliRequestLog[], window = dreaminaCliStatsWindow("all")): DreaminaCliRequestStats {
    const officialCosts = new Map<string, { cost: number; spentAt: number }>();
    const lifecycleLogs = logs.filter((item) => item.phase !== "query");
    for (const item of lifecycleLogs) {
        if (item.creditObservation !== "official" || item.observedCreditDelta === undefined) continue;
        const key = item.submissionId || (item.taskId ? `task:${item.taskId}` : `log:${item.id}`);
        const spentAt = Date.parse(item.createdAt);
        if (!Number.isFinite(spentAt)) continue;
        const current = officialCosts.get(key);
        officialCosts.set(key, { cost: Math.max(current?.cost || 0, Math.max(0, item.observedCreditDelta)), spentAt: Math.min(current?.spentAt ?? spentAt, spentAt) });
    }
    const scoped = lifecycleLogs.filter((item) => isInStatsWindow(item.createdAt, window));
    const officialCredits = [...officialCosts.values()].filter((item) => isTimestampInStatsWindow(item.spentAt, window)).reduce((total, item) => total + item.cost, 0);
    const observedCredits = scoped.reduce((total, item) => total + (item.creditObservation === "observed" ? Math.max(0, item.observedCreditDelta || 0) : 0), 0);
    return {
        ...window,
        total: scoped.length,
        success: scoped.filter((item) => item.status === "success").length,
        failed: scoped.filter((item) => item.status === "failed").length,
        needsReview: scoped.filter((item) => item.status === "needs_review").length,
        officialCredits,
        observedCredits: observedCredits + officialCredits,
    };
}

export function dreaminaCliStatsWindow(range: DreaminaCliStatsRange, now = new Date()): DreaminaCliStatsWindow {
    const timeZone = validTimeZone(process.env.OCTALAICANVAS_TIME_ZONE || DEFAULT_TIME_ZONE);
    const endAt = now.toISOString();
    if (range === "all") return { range, endAt, timeZone };
    const zoned = dayjs(now).tz(timeZone);
    const start = range === "week" ? zoned.startOf("day").subtract((zoned.day() + 6) % 7, "day") : zoned.startOf(range);
    return { range, startAt: start.toISOString(), endAt, timeZone };
}

async function postgresRepository() {
    await ensurePostgresSchema();
    return new DreaminaCliRepository({ query: postgresQuery });
}

async function readDatabase() {
    const stored = await readJsonDataFile<Partial<DreaminaCliDatabase>>(FILE_NAME, EMPTY_DATABASE);
    return { account: validAccount(stored.account), logs: Array.isArray(stored.logs) ? stored.logs.map(normalizeLog).filter((item): item is DreaminaCliRequestLog => Boolean(item)) : [] };
}

async function mutateDatabase(mutator: (database: DreaminaCliDatabase) => void) {
    return withJsonDataFileLock(FILE_NAME, async () => {
        const database = await readDatabase();
        mutator(database);
        await writeJsonDataFile(FILE_NAME, database);
    });
}

function mergeAccount(current: DreaminaCliAccountState, patch: Partial<Omit<DreaminaCliAccountState, "id" | "createdAt" | "updatedAt">>): DreaminaCliAccountState {
    const next = { ...current, ...patch, id: "default" as const, updatedAt: new Date().toISOString() };
    for (const key of [
        "userId",
        "userName",
        "vipLevel",
        "totalCredit",
        "cliVersion",
        "cliCommit",
        "cliBuildTime",
        "executableFingerprint",
        "lastCreditCheckedAt",
        "lastSuccessAt",
        "lastErrorCode",
        "lastErrorMessage",
        "submitLeaseOwner",
        "submitLeaseTaskId",
        "submitLeaseUntil",
    ] as const) {
        if (Object.prototype.hasOwnProperty.call(patch, key) && patch[key] === undefined) delete next[key];
    }
    return next;
}

function validAccount(value: unknown): DreaminaCliAccountState | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const item = value as Partial<DreaminaCliAccountState>;
    if (!item.createdAt || !item.updatedAt) return undefined;
    return { ...emptyDreaminaCliAccountState(), ...item, id: "default", status: accountStatus(item.status) };
}

function normalizeLog(value: unknown): DreaminaCliRequestLog | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const item = value as Partial<DreaminaCliRequestLog>;
    if (!item.id || !item.createdAt || !item.updatedAt || !item.command || !item.phase || !item.status) return undefined;
    return {
        id: item.id,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        ...(item.taskId ? { taskId: item.taskId } : {}),
        ...(typeof item.attemptNo === "number" ? { attemptNo: item.attemptNo } : {}),
        command: requestCommand(item.command),
        phase: requestPhase(item.phase),
        ...(item.capability === "image" || item.capability === "video" ? { capability: item.capability } : {}),
        ...(item.model ? { model: item.model } : {}),
        ...(item.upstreamModel ? { upstreamModel: item.upstreamModel } : {}),
        status: requestStatus(item.status),
        ...(typeof item.durationMs === "number" ? { durationMs: item.durationMs } : {}),
        ...(item.submissionId ? { submissionId: item.submissionId } : {}),
        ...(item.succeededAt ? { succeededAt: item.succeededAt } : {}),
        ...(item.failedAt ? { failedAt: item.failedAt } : {}),
        ...(typeof item.beforeCredit === "number" ? { beforeCredit: item.beforeCredit } : {}),
        ...(typeof item.afterCredit === "number" ? { afterCredit: item.afterCredit } : {}),
        ...(typeof item.observedCreditDelta === "number" ? { observedCreditDelta: item.observedCreditDelta } : {}),
        creditObservation: creditObservation(item.creditObservation),
        ...(item.errorCode ? { errorCode: item.errorCode } : {}),
        ...(item.error ? { error: safeError(item.error) } : {}),
        requestSummary: sanitizeSummary(item.requestSummary),
        submissionSummary: sanitizeSummary(item.submissionSummary),
        resultSummary: sanitizeSummary(item.resultSummary),
    };
}

function sanitizeSummary(value: unknown) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const result: Record<string, string | number | boolean | null | Array<string | number | boolean>> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        const normalized = key.trim().slice(0, 80);
        if (!normalized || /(?:prompt|path|file|token|secret|cookie|authorization|stdout|stderr|device|code|url)/i.test(normalized)) continue;
        if (typeof item === "string") result[normalized] = item.trim().slice(0, 200);
        else if (typeof item === "number" || typeof item === "boolean" || item === null) result[normalized] = item;
        else if (Array.isArray(item) && item.every((entry) => typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean")) result[normalized] = item.slice(0, 20);
    }
    return result;
}

function safeError(value: string) {
    return value
        .replace(/(?:https?:\/\/|file:\/\/)[^\s"']+/gi, "[已隐藏地址]")
        .replace(/(?:^|\s)\/?(?:Users|home|tmp|var|private|workspace)\/[^\s"']+/g, " [已隐藏路径]")
        .replace(/(?:token|secret|authorization|cookie)\s*[=:]\s*[^\s,;]+/gi, "$1=[已隐藏]")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 500);
}

function positiveInteger(value: unknown, fallback: number) {
    const parsed = Math.floor(Number(value));
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isInStatsWindow(value: string, window: DreaminaCliStatsWindow) {
    return isTimestampInStatsWindow(Date.parse(value), window);
}

function isTimestampInStatsWindow(value: number, window: DreaminaCliStatsWindow) {
    const start = window.startAt ? Date.parse(window.startAt) : Number.NEGATIVE_INFINITY;
    const end = Date.parse(window.endAt);
    return Number.isFinite(value) && value >= start && value < end;
}

function validTimeZone(value: string) {
    try {
        new Intl.DateTimeFormat("en", { timeZone: value }).format();
        return value;
    } catch {
        return DEFAULT_TIME_ZONE;
    }
}

function accountStatus(value: unknown): DreaminaCliAccountStatus {
    return ["unconfigured", "unverified", "authorized", "not_logged_in", "permission_denied", "compliance_required", "error"].includes(String(value)) ? (value as DreaminaCliAccountStatus) : "unverified";
}

function requestCommand(value: unknown): DreaminaCliRequestCommand {
    return ["version", "user_credit", "text2image", "image2image", "image_upscale", "text2video", "image2video", "frames2video", "multiframe2video", "multimodal2video", "query_result", "download"].includes(String(value))
        ? (value as DreaminaCliRequestCommand)
        : "version";
}

function requestPhase(value: unknown): DreaminaCliRequestPhase {
    return ["preflight", "submit", "query", "download", "account_refresh"].includes(String(value)) ? (value as DreaminaCliRequestPhase) : "preflight";
}

function requestStatus(value: unknown): DreaminaCliRequestStatus {
    return ["started", "success", "failed", "needs_review", "deferred"].includes(String(value)) ? (value as DreaminaCliRequestStatus) : "failed";
}

function creditObservation(value: unknown): DreaminaCliCreditObservation {
    return ["official", "unavailable", "observed", "ambiguous", "inconsistent"].includes(String(value)) ? (value as DreaminaCliCreditObservation) : "unavailable";
}
