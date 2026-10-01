import { randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, lstat, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

import { buildDreaminaCliSubmitArgs, type DreaminaCliSubmissionInput } from "./dreamina-cli-catalog";
import { createTrafficLease } from "./traffic-meter-client";
import { currentTrafficContext, type TrafficContext } from "./traffic-context";

const execFile = promisify(execFileCallback);
const SAFE_SUBMIT_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;

export type DreaminaCliExecResult = { stdout: string; stderr: string; exitCode: number };
export type DreaminaCliRunner = (executable: string, args: readonly string[], options: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv }) => Promise<DreaminaCliExecResult>;
export type DreaminaCliVersion = { version: string; commit?: string; buildTime?: string };
export type DreaminaCliCredit = { totalCredit: number; userId: string; userName?: string; vipLevel?: string };
export type DreaminaCliQueryResult = { state: "pending" | "succeeded" | "failed"; status: string; files: string[]; creditCost?: number; error?: string };
export type DreaminaCliSubmission = { submitId: string; creditCost?: number };

export class DreaminaCliProviderError extends Error {
    constructor(
        message: string,
        readonly status = 502,
        readonly submissionState: "not_started" | "safe_failure" | "unknown" = "safe_failure",
    ) {
        super(message);
        this.name = "DreaminaCliProviderError";
    }
}

export class DreaminaCliSubmissionUncertainError extends DreaminaCliProviderError {
    constructor(message = "即梦 CLI 提交结果未知，请勿自动重试") {
        super(message, 502, "unknown");
        this.name = "DreaminaCliSubmissionUncertainError";
    }
}

export async function resolveDreaminaCliExecutable() {
    const configured = process.env.DREAMYO_DREAMINA_CLI_PATH?.trim();
    if (!configured) return "dreamina";
    if (!isAbsolute(configured)) throw new DreaminaCliProviderError("即梦 CLI 可执行文件必须使用绝对路径", 500, "not_started");
    let executable = "";
    try {
        executable = await realpath(/*turbopackIgnore: true*/ configured);
        const details = await stat(/*turbopackIgnore: true*/ executable);
        if (!details.isFile()) throw new Error("not_file");
    } catch {
        throw new DreaminaCliProviderError("即梦 CLI 可执行文件不可用", 503, "not_started");
    }
    return executable;
}

export async function readDreaminaCliVersion(options: { runner?: DreaminaCliRunner; timeoutMs?: number } = {}) {
    const result = await runDreaminaCli(["version"], options);
    return parseDreaminaCliVersion(result.stdout);
}

export async function readDreaminaCliCredit(options: { runner?: DreaminaCliRunner; timeoutMs?: number } = {}) {
    const result = await runDreaminaCli(["user_credit"], options);
    return parseDreaminaCliCredit(result.stdout);
}

export async function submitDreaminaCliTask(input: DreaminaCliSubmissionInput, options: { runner?: DreaminaCliRunner; timeoutMs?: number; cwd?: string } = {}) {
    const args = buildDreaminaCliSubmitArgs(input);
    try {
        const result = await runDreaminaCli(args, { ...options, trafficContext: dreaminaCliTrafficContext(input.modelId || input.command) });
        if (result.exitCode !== 0) throw new DreaminaCliSubmissionUncertainError("即梦 CLI 已执行但未确认任务是否提交");
        const rejected = parseDreaminaCliSubmitFailure(result.stdout);
        if (rejected) throw new DreaminaCliProviderError(rejected, 503, "safe_failure");
        const submission = parseDreaminaCliSubmission(result.stdout);
        if (!submission) throw new DreaminaCliSubmissionUncertainError();
        return submission;
    } catch (error) {
        if (error instanceof DreaminaCliSubmissionUncertainError) throw error;
        if (error instanceof DreaminaCliProviderError && (error.submissionState === "not_started" || error.submissionState === "safe_failure")) throw error;
        if (error instanceof DreaminaCliProviderError) throw new DreaminaCliSubmissionUncertainError(error.message);
        throw new DreaminaCliSubmissionUncertainError();
    }
}

export async function queryDreaminaCliTask(input: { submitId: string; downloadDir: string }, options: { runner?: DreaminaCliRunner; timeoutMs?: number; cwd?: string } = {}) {
    const submitId = normalizeSubmitId(input.submitId);
    const downloadDir = await resolveDreaminaCliOutputDirectory(input.downloadDir);
    const result = await runDreaminaCli(["query_result", `--submit_id=${submitId}`, `--download_dir=${downloadDir}`], {
        ...options,
        cwd: options.cwd || downloadDir,
        trafficContext: dreaminaCliTrafficContext("__unattributed__", "query"),
    });
    return parseDreaminaCliQueryResult(result.stdout, downloadDir);
}

export async function withDreaminaCliTempDirectory<T>(callback: (directory: string) => Promise<T>, options: { prefix?: string } = {}) {
    const root = await dreaminaCliTempRoot();
    const prefix = safeTempPrefix(options.prefix || "task");
    const directory = await mkdtemp(join(/*turbopackIgnore: true*/ root, `dreamina-${prefix}-`));
    const canonicalDirectory = await realpath(/*turbopackIgnore: true*/ directory);
    try {
        return await callback(canonicalDirectory);
    } finally {
        await rm(/*turbopackIgnore: true*/ canonicalDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
}

/** A stable, task-scoped download directory. Pending queries retain it across worker leases. */
export async function dreaminaCliTaskDirectory(taskId: string) {
    const root = await realpath(/*turbopackIgnore: true*/ await dreaminaCliTempRoot());
    const directory = join(/*turbopackIgnore: true*/ root, `task-${safeTempPrefix(taskId)}`);
    await mkdir(/*turbopackIgnore: true*/ directory, { recursive: true, mode: 0o700 });
    const details = await lstat(/*turbopackIgnore: true*/ directory).catch(() => null);
    const canonical = await realpath(/*turbopackIgnore: true*/ directory).catch(() => "");
    if (!details?.isDirectory() || details.isSymbolicLink() || !canonical || !isPathInside(canonical, root)) throw new DreaminaCliProviderError("即梦 CLI 任务目录不可用", 500, "not_started");
    return canonical;
}

export async function removeDreaminaCliTaskDirectory(taskId: string) {
    const directory = await dreaminaCliTaskDirectory(taskId);
    await rm(/*turbopackIgnore: true*/ directory, { recursive: true, force: true });
}

export async function assertDreaminaCliRegularFile(path: string, directory: string) {
    const sourceDetails = await lstat(/*turbopackIgnore: true*/ path).catch(() => null);
    if (!sourceDetails?.isFile() || sourceDetails.isSymbolicLink()) throw new DreaminaCliProviderError("即梦 CLI 输出文件无效", 400, "safe_failure");
    const candidate = await realpath(/*turbopackIgnore: true*/ path).catch(() => "");
    const root = await realpath(/*turbopackIgnore: true*/ directory).catch(() => "");
    if (!candidate || !root || !isPathInside(candidate, root)) throw new DreaminaCliProviderError("即梦 CLI 文件路径不在受控目录中", 400, "safe_failure");
    const details = await lstat(/*turbopackIgnore: true*/ candidate).catch(() => null);
    if (!details?.isFile()) throw new DreaminaCliProviderError("即梦 CLI 输出文件无效", 400, "safe_failure");
    return candidate;
}

export function parseDreaminaCliVersion(stdout: string): DreaminaCliVersion {
    const value = parseJsonRecord(stdout, "即梦 CLI 版本信息无法解析");
    const version = text(value.version, 120);
    if (!version) throw new DreaminaCliProviderError("即梦 CLI 未返回版本信息", 502);
    return { version, ...(text(value.commit, 120) ? { commit: text(value.commit, 120) } : {}), ...(text(value.build_time ?? value.buildTime, 120) ? { buildTime: text(value.build_time ?? value.buildTime, 120) } : {}) };
}

export function parseDreaminaCliCredit(stdout: string): DreaminaCliCredit {
    const value = parseJsonRecord(stdout, "即梦 CLI 账户信息无法解析");
    const totalCredit = finiteNumber(value.total_credit ?? value.totalCredit);
    const userId = text(value.user_id ?? value.userId, 200);
    if (totalCredit === undefined || !userId) throw new DreaminaCliProviderError("即梦 CLI 未返回完整账户信息", 502);
    return {
        totalCredit,
        userId,
        ...(text(value.user_name ?? value.userName, 200) ? { userName: text(value.user_name ?? value.userName, 200) } : {}),
        ...(text(value.vip_level ?? value.vipLevel, 120) ? { vipLevel: text(value.vip_level ?? value.vipLevel, 120) } : {}),
    };
}

/**
 * This accepts only the documented submit-id spellings.  Unknown successful
 * output is intentionally not guessed: task recovery will mark it for review.
 */
export function parseDreaminaCliSubmitId(stdout: string) {
    return parseDreaminaCliSubmission(stdout)?.submitId || "";
}

export function parseDreaminaCliSubmission(stdout: string): DreaminaCliSubmission | null {
    const value = tryParseJsonRecord(stdout);
    const id = text(value?.submit_id ?? value?.submitId, 200);
    if (!SAFE_SUBMIT_ID.test(id)) return null;
    const creditCost = finiteNumber(value?.credit_count ?? value?.creditCount);
    return { submitId: id, ...(creditCost !== undefined && creditCost >= 0 ? { creditCost } : {}) };
}

export function parseDreaminaCliSubmitFailure(stdout: string) {
    const value = tryParseJsonRecord(stdout);
    const status = text(value?.gen_status ?? value?.status ?? value?.state, 80).toLowerCase();
    if (!/(?:fail|failed|error|rejected|cancelled|canceled)/.test(status)) return "";
    return safeMessage(value?.fail_reason ?? value?.error ?? value?.message ?? value?.msg) || "即梦 CLI 明确拒绝了本次提交";
}

/**
 * Query output varies between CLI versions.  Treat only explicit terminal or
 * pending status plus files downloaded inside the sandbox as actionable.
 */
export function parseDreaminaCliQueryResult(stdout: string, downloadDir: string): DreaminaCliQueryResult {
    const value = tryParseJsonRecord(stdout);
    if (!value) throw new DreaminaCliProviderError("即梦 CLI 查询结果无法解析", 502);
    const status = text(value.gen_status ?? value.status ?? value.state ?? value.task_status, 80).toLowerCase();
    const error = safeMessage(value.fail_reason ?? value.error ?? value.message ?? value.msg);
    const files = collectOutputPaths(value, downloadDir);
    const parsedCreditCost = finiteNumber(value.credit_count ?? value.creditCount);
    const credit = parsedCreditCost !== undefined && parsedCreditCost >= 0 ? { creditCost: parsedCreditCost } : {};
    if (files.length) return { state: "succeeded", status: status || "completed", files, ...credit };
    if (/(?:fail|failed|error|rejected|cancelled|canceled)/.test(status)) return { state: "failed", status: status || "failed", files: [], ...credit, ...(error ? { error } : {}) };
    if (/(?:pending|queued|querying|running|generating|processing|submitted|created)/.test(status)) return { state: "pending", status, files: [], ...credit };
    throw new DreaminaCliProviderError("即梦 CLI 查询结果状态未知", 502);
}

export function safeDreaminaCliMessage(value: unknown) {
    return safeMessage(value);
}

async function runDreaminaCli(
    args: readonly string[],
    options: { runner?: DreaminaCliRunner; timeoutMs?: number; cwd?: string; trafficContext?: TrafficContext },
) {
    const executable = await resolveDreaminaCliExecutable();
    let result: DreaminaCliExecResult;
    try {
        result = await runWithDreaminaCliTrafficLease(executable, args, options);
    } catch (error) {
        if (error instanceof DreaminaCliProviderError) throw error;
        if (isSpawnFailure(error)) throw new DreaminaCliProviderError("即梦 CLI 无法启动", 503, "not_started");
        throw new DreaminaCliProviderError("即梦 CLI 执行失败", 502, "unknown");
    }
    if (result.exitCode !== 0) throw new DreaminaCliProviderError(safeMessage(result.stderr) || "即梦 CLI 执行失败", 502, "unknown");
    return result;
}

const nativeRunner: DreaminaCliRunner = async (executable, args, options) => {
    try {
        const result = await execFile(executable, [...args], {
            ...(options.cwd ? { cwd: options.cwd } : {}),
            ...(options.timeoutMs ? { timeout: options.timeoutMs } : {}),
            ...(options.env ? { env: options.env } : {}),
            shell: false,
            windowsHide: true,
            encoding: "utf8",
        });
        return { stdout: String(result.stdout || ""), stderr: String(result.stderr || ""), exitCode: 0 };
    } catch (error) {
        const item = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: string | number; killed?: boolean };
        if (typeof item.code === "string" && ["ENOENT", "EACCES", "EPERM"].includes(item.code)) throw error;
        return { stdout: String(item.stdout || ""), stderr: String(item.stderr || ""), exitCode: typeof item.code === "number" ? item.code : 1 };
    }
};

const DREAMINA_PROXY_ENVIRONMENT_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"] as const;

/**
 * The installed official CLI is a Go binary. Its help has no proxy flag, but
 * the binary exposes net/http.ProxyFromEnvironment and HTTP_PROXY/HTTPS_PROXY
 * support. We therefore pass only those verified variables to the child;
 * ALL_PROXY is removed because the binary does not expose evidence that it
 * honors it.
 */
export function buildDreaminaCliProxyEnvironment(environment: NodeJS.ProcessEnv, relayProxyUrl: string): NodeJS.ProcessEnv {
    const childEnvironment = Object.fromEntries(
        Object.entries(environment).filter(([key]) => !DREAMINA_PROXY_ENVIRONMENT_KEYS.includes(key as (typeof DREAMINA_PROXY_ENVIRONMENT_KEYS)[number])),
    ) as NodeJS.ProcessEnv;
    childEnvironment.HTTP_PROXY = relayProxyUrl;
    childEnvironment.HTTPS_PROXY = relayProxyUrl;
    childEnvironment.http_proxy = relayProxyUrl;
    childEnvironment.https_proxy = relayProxyUrl;
    childEnvironment.NO_PROXY = "";
    childEnvironment.no_proxy = "";
    return childEnvironment;
}

export function dreaminaCliSourceProxyUrl(environment: NodeJS.ProcessEnv = process.env): string | undefined {
    for (const key of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"] as const) {
        const value = environment[key]?.trim();
        if (!value) continue;
        try {
            const url = new URL(value);
            if (["http:", "https:"].includes(url.protocol) && url.hostname && !url.search && !url.hash) return value;
        } catch {
            // Preserve the existing CLI behavior when the meter is disabled;
            // configured meter runs reject this unverified route below.
        }
    }
    return undefined;
}

export function dreaminaCliProxyCoverageUnavailable(environment: NodeJS.ProcessEnv = process.env): string | undefined {
    const httpProxyValues = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]
        .map((key) => environment[key]?.trim() || "")
        .filter(Boolean);
    for (const value of httpProxyValues) {
        try {
            const url = new URL(value);
            if (!url.hostname || !["http:", "https:"].includes(url.protocol) || url.search || url.hash) return "http_proxy_unverified";
        } catch {
            return "http_proxy_unverified";
        }
    }
    if (!httpProxyValues.length && ["ALL_PROXY", "all_proxy"].some((key) => Boolean(environment[key]?.trim()))) return "all_proxy_unverified";
    return undefined;
}

export function dreaminaCliTrafficContext(model: string, role = "provider"): TrafficContext {
    const inherited = currentTrafficContext();
    return {
        channelId: inherited?.channelId || "dreamina-cli",
        channelName: inherited?.channelName || "Dreamina CLI",
        model: inherited?.model || model.trim() || "__unattributed__",
        protocol: inherited?.protocol || "dreamina-cli",
        // HTTP(S)_PROXY support is verified, but the inherited URL alone does
        // not identify whether the route is generic, magic, or chained.
        connectionMode: inherited?.connectionMode || (dreaminaCliSourceProxyUrl() ? "unknown" : "direct"),
        role: inherited?.role || role,
        attributionScope: inherited?.attributionScope || "exact",
        ...(inherited?.taskId ? { taskId: inherited.taskId } : {}),
        ...(inherited?.requestId ? { requestId: inherited.requestId } : {}),
        ...(inherited?.attemptId ? { attemptId: inherited.attemptId } : {}),
    };
}

async function runWithDreaminaCliTrafficLease(
    executable: string,
    args: readonly string[],
    options: { runner?: DreaminaCliRunner; timeoutMs?: number; cwd?: string; trafficContext?: TrafficContext },
) {
    const runner = options.runner || nativeRunner;
    const runnerOptions = {
        ...(options.cwd ? { cwd: options.cwd } : {}),
        ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    };
    if (process.env.DREAMYO_TRAFFIC_METER_URL?.trim()) {
        const unsupportedProxy = dreaminaCliProxyCoverageUnavailable();
        if (unsupportedProxy) {
            throw new DreaminaCliProviderError("即梦 CLI 当前代理类型未验证，流量计量覆盖不可用", 503, "not_started");
        }
    }
    let lease;
    try {
        lease = await createTrafficLease(dreaminaCliSourceProxyUrl(), options.trafficContext || dreaminaCliTrafficContext(args[0] || "__unattributed__"), []);
    } catch (error) {
        throw new DreaminaCliProviderError(
            safeMessage(error) || "即梦流量计量服务不可用",
            503,
            "not_started",
        );
    }
    if (!lease) return runner(executable, args, runnerOptions);
    try {
        return await runner(executable, args, {
            ...runnerOptions,
            env: buildDreaminaCliProxyEnvironment(process.env, lease.proxyUrl),
        });
    } finally {
        await lease.release();
    }
}

async function dreaminaCliTempRoot() {
    const configured = process.env.DREAMYO_DREAMINA_CLI_TEMP_ROOT?.trim();
    if (configured && !isAbsolute(configured)) throw new DreaminaCliProviderError("即梦 CLI 临时目录必须使用绝对路径", 500, "not_started");
    const root = configured || join(tmpdir(), "dreamyo-dreamina-cli");
    await mkdir(/*turbopackIgnore: true*/ root, { recursive: true, mode: 0o700 });
    const details = await lstat(/*turbopackIgnore: true*/ root).catch(() => null);
    if (!details?.isDirectory() || details.isSymbolicLink()) throw new DreaminaCliProviderError("即梦 CLI 临时目录不可用", 500, "not_started");
    return root;
}

async function resolveDreaminaCliOutputDirectory(directory: string) {
    if (!isAbsolute(directory)) throw new DreaminaCliProviderError("即梦 CLI 下载目录必须使用绝对路径", 400);
    await mkdir(/*turbopackIgnore: true*/ directory, { recursive: true, mode: 0o700 });
    const root = await dreaminaCliTempRoot();
    const resolved = await realpath(/*turbopackIgnore: true*/ directory).catch(() => "");
    const allowed = await realpath(/*turbopackIgnore: true*/ root).catch(() => "");
    if (!resolved || !allowed || !isPathInside(resolved, allowed)) throw new DreaminaCliProviderError("即梦 CLI 下载目录不在受控临时目录中", 400);
    return resolved;
}

function collectOutputPaths(value: Record<string, unknown>, downloadDir: string) {
    const root = resolve(/*turbopackIgnore: true*/ downloadDir);
    const paths = new Set<string>();
    const visit = (entry: unknown, depth = 0) => {
        if (depth > 8 || entry === null || entry === undefined) return;
        if (typeof entry === "string") {
            const candidate = resolve(/*turbopackIgnore: true*/ root, entry);
            if (isPathInside(candidate, root) && looksLikeMediaPath(candidate)) paths.add(candidate);
            return;
        }
        if (Array.isArray(entry)) return entry.forEach((item) => visit(item, depth + 1));
        if (typeof entry !== "object") return;
        for (const [key, item] of Object.entries(entry as Record<string, unknown>)) {
            if (["file", "files", "path", "paths", "output", "outputs", "result", "results", "result_json", "resultjson", "media", "images", "videos", "audios", "media_files", "downloaded_files"].includes(key.toLowerCase())) visit(item, depth + 1);
        }
    };
    visit(value);
    return [...paths];
}

function looksLikeMediaPath(value: string) {
    return /\.(?:png|jpe?g|webp|gif|mp4|webm|mov|m4v)$/i.test(basename(value));
}

function isPathInside(value: string, root: string) {
    const path = relative(root, value);
    return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function normalizeSubmitId(value: string) {
    const id = value.trim();
    if (!SAFE_SUBMIT_ID.test(id)) throw new DreaminaCliProviderError("即梦 CLI 任务 ID 无效", 400);
    return id;
}

function parseJsonRecord(stdout: string, message: string) {
    const value = tryParseJsonRecord(stdout);
    if (!value) throw new DreaminaCliProviderError(message, 502);
    return value;
}

function tryParseJsonRecord(stdout: string) {
    try {
        const value = JSON.parse(stdout.trim()) as unknown;
        return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
    } catch {
        return null;
    }
}

function text(value: unknown, maximum: number) {
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

function finiteNumber(value: unknown) {
    const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
    return Number.isFinite(parsed) ? parsed : undefined;
}

function safeTempPrefix(value: string) {
    const base = value.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
    return (base || randomUUID()).slice(0, 80);
}

function isSpawnFailure(error: unknown) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    return code === "ENOENT" || code === "EACCES" || code === "EPERM";
}

function safeMessage(value: unknown) {
    const textValue = typeof value === "string" ? value : value instanceof Error ? value.message : "";
    const normalized = textValue
        .replace(/(?:https?:\/\/|file:\/\/)[^\s"']+/gi, "[已隐藏地址]")
        .replace(/(?:^|\s)\/?(?:Users|home|tmp|var|private|workspace)\/[^\s"']+/g, " [已隐藏路径]")
        .replace(/(?:token|secret|authorization|cookie)\s*[=:]\s*[^\s,;]+/gi, "$1=[已隐藏]")
        .replace(/\s+/g, " ")
        .trim();
    return normalized.slice(0, 500);
}
