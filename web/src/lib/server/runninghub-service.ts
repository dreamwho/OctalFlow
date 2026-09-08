import { randomUUID } from "node:crypto";

import {
    appendRunningHubRequestLog,
    getRunningHubApp,
    getRunningHubPrivateSettings,
    getRunningHubTask,
    saveRunningHubTask,
    upsertRunningHubApp,
    type RunningHubApp,
    type RunningHubField,
    type RunningHubTask,
} from "@/lib/server/runninghub-store";
import { fetchSafeOutbound } from "@/lib/server/safe-outbound-fetch";

export class RunningHubError extends Error {
    constructor(message: string, readonly status = 502, readonly retryable = false) {
        super(message);
        this.name = "RunningHubError";
    }
}

export async function getRunningHubAccountStatus() {
    const settings = await requireSettings();
    return runningHubJson(settings, "/uc/openapi/accountStatus", { apikey: settings.apiKey }, { phase: "account" });
}

export async function syncRunningHubApp(appId: string) {
    const app = await getRunningHubApp(appId);
    if (!app) throw new RunningHubError("RunningHub 应用不存在", 404);
    const settings = await requireSettings();
    const payload =
        app.kind === "ai-app"
            ? await runningHubJson(settings, `/api/webapp/apiCallDemo?apiKey=${encodeURIComponent(settings.apiKey)}&webappId=${encodeURIComponent(app.remoteId)}`, undefined, { phase: "sync", appId: app.id, method: "GET" })
            : await runningHubJson(settings, "/api/openapi/getJsonApiFormat", { apiKey: settings.apiKey, workflowId: app.remoteId }, { phase: "sync", appId: app.id });
    const fields = app.kind === "ai-app" ? parseAiAppFields(payload) : parseWorkflowFields(payload);
    if (!fields.length) throw new RunningHubError("RunningHub 未返回可配置字段，请确认 ID 与应用发布状态", 422);
    return upsertRunningHubApp({ ...app, fields });
}

export async function submitRunningHubImageTask(input: { imageTaskId: string; userId: string; appId: string; prompt: string; files: File[]; size?: string; quality?: string }) {
    const app = await getRunningHubApp(input.appId);
    if (!app || !app.enabled || !app.featureBindings.includes("interior-design")) throw new RunningHubError("该 RunningHub 应用未启用或未绑定室内设计", 422);
    if (!app.fields.length) throw new RunningHubError("请先在 RunningHub 管理页同步应用字段", 422);
    if (!input.files.length) throw new RunningHubError("室内设计需要一张参考图", 400);
    const settings = await requireSettings();
    const localTask: RunningHubTask = {
        id: `rh-task-${randomUUID()}`,
        imageTaskId: input.imageTaskId,
        userId: input.userId,
        appId: app.id,
        status: "queued",
        resultUrls: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    };
    await saveRunningHubTask(localTask);
    try {
        const uploadedNames = await Promise.all(input.files.map((file) => uploadRunningHubFile(settings, file, localTask.id, app.id)));
        const nodeInfoList = buildNodeInfoList(app, input.prompt, uploadedNames, { size: input.size, quality: input.quality });
        const path = app.kind === "ai-app" ? "/task/openapi/ai-app/run" : "/task/openapi/create";
        const payload = {
            apiKey: settings.apiKey,
            ...(app.kind === "ai-app" ? { webappId: app.remoteId } : { workflowId: app.remoteId }),
            nodeInfoList,
            ...(settings.instanceType === "plus" ? { instanceType: "plus" } : {}),
        };
        const result = await runningHubJson(settings, path, payload, { phase: "submit", taskId: localTask.id, appId: app.id });
        const remoteTaskId = textAt(result, ["data", "taskId"]) || textAt(result, ["taskId"]);
        if (!remoteTaskId) throw upstreamError(result, "RunningHub 未返回任务 ID");
        const task = { ...localTask, remoteTaskId, status: "queued" as const, updatedAt: new Date().toISOString() };
        await saveRunningHubTask(task);
        return task;
    } catch (error) {
        const failed = { ...localTask, status: "failed" as const, error: error instanceof Error ? error.message : "RunningHub 提交失败", updatedAt: new Date().toISOString(), completedAt: new Date().toISOString() };
        await saveRunningHubTask(failed);
        throw error;
    }
}

export async function queryRunningHubImageTask(localTaskId: string) {
    const task = await getRunningHubTask(localTaskId);
    if (!task) throw new RunningHubError("RunningHub 任务记录不存在", 404);
    if (!task.remoteTaskId) throw new RunningHubError(task.error || "RunningHub 任务缺少上游 ID", 422);
    const settings = await requireSettings();
    const payload = await runningHubJson(settings, "/task/openapi/outputs", { apiKey: settings.apiKey, taskId: task.remoteTaskId }, { phase: "query", taskId: task.id, appId: task.appId }, true);
    const code = Number((payload as Record<string, unknown>).code);
    if (code === 0) {
        const urls = extractRunningHubResultUrls((payload as Record<string, unknown>).data ?? (payload as Record<string, unknown>).results);
        if (!urls.length) throw new RunningHubError("RunningHub 任务已完成但未返回图片", 502, true);
        const completed = { ...task, status: "success" as const, resultUrls: urls, error: undefined, updatedAt: new Date().toISOString(), completedAt: new Date().toISOString() };
        await saveRunningHubTask(completed);
        return completed;
    }
    if (code === 804 || code === 813 || code === 421) {
        const running = { ...task, status: code === 804 ? ("running" as const) : ("queued" as const), updatedAt: new Date().toISOString() };
        await saveRunningHubTask(running);
        return running;
    }
    const error = safeUpstreamMessage(payload, "RunningHub 任务失败");
    const failed = { ...task, status: "failed" as const, error, updatedAt: new Date().toISOString(), completedAt: new Date().toISOString() };
    await saveRunningHubTask(failed);
    return failed;
}

export async function cancelRunningHubTask(localTaskId: string) {
    const task = await getRunningHubTask(localTaskId);
    if (!task) throw new RunningHubError("RunningHub 任务记录不存在", 404);
    if (task.remoteTaskId) {
        const settings = await requireSettings();
        await runningHubJson(settings, "/task/openapi/cancel", { apiKey: settings.apiKey, taskId: task.remoteTaskId }, { phase: "cancel", taskId: task.id, appId: task.appId }, true);
    }
    const cancelled = { ...task, status: "cancelled" as const, updatedAt: new Date().toISOString(), completedAt: new Date().toISOString() };
    await saveRunningHubTask(cancelled);
    return cancelled;
}

export function extractRunningHubResultUrls(value: unknown) {
    const urls: string[] = [];
    const visit = (item: unknown, key = "") => {
        if (typeof item === "string") {
            if ((/url|file|image/i.test(key) || /^https?:\/\//i.test(item)) && /^https?:\/\//i.test(item.trim())) item.split(",").forEach((part) => /^https?:\/\//i.test(part.trim()) && urls.push(part.trim()));
            return;
        }
        if (Array.isArray(item)) return item.forEach((entry) => visit(entry, key));
        if (!item || typeof item !== "object") return;
        Object.entries(item as Record<string, unknown>).forEach(([childKey, child]) => visit(child, childKey));
    };
    visit(value);
    return Array.from(new Set(urls));
}

async function uploadRunningHubFile(settings: Awaited<ReturnType<typeof requireSettings>>, file: File, taskId: string, appId: string) {
    const startedAt = Date.now();
    const path = "/task/openapi/upload";
    try {
        const form = new FormData();
        form.set("apiKey", settings.apiKey);
        form.set("fileType", "input");
        form.set("file", file, file.name || "reference.png");
        const response = await fetchSafeOutbound(`${settings.apiBaseUrl}${path}`, { method: "POST", body: form, signal: AbortSignal.timeout(120_000) });
        const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        await appendRunningHubRequestLog({ taskId, appId, phase: "upload", path, statusCode: response.status, durationMs: Date.now() - startedAt, ...(response.ok ? {} : { error: safeUpstreamMessage(payload, `HTTP ${response.status}`) }) });
        if (!response.ok || Number(payload.code) !== 0) throw upstreamError(payload, "参考图上传到 RunningHub 失败", response.status);
        const fileName = textAt(payload, ["data", "fileName"]);
        if (!fileName) throw new RunningHubError("RunningHub 上传响应缺少文件名", 502, true);
        return fileName;
    } catch (error) {
        if (error instanceof RunningHubError) throw error;
        await appendRunningHubRequestLog({ taskId, appId, phase: "upload", path, statusCode: 0, durationMs: Date.now() - startedAt, error: error instanceof Error ? error.message.slice(0, 500) : "请求失败" });
        throw new RunningHubError(error instanceof Error ? error.message : "参考图上传失败", 502, true);
    }
}

function buildNodeInfoList(app: RunningHubApp, prompt: string, uploadedNames: string[], preferences: { size?: string; quality?: string }) {
    let imageIndex = 0;
    let promptAssigned = false;
    const promptCandidate = app.fields.find((field) => /prompt|text|描述|提示词|指令/i.test(`${field.fieldName} ${field.label}`) && field.type !== "image");
    return app.fields.map((field) => {
        let fieldValue = field.defaultValue;
        if (field.type === "image" && imageIndex < uploadedNames.length) fieldValue = uploadedNames[imageIndex++];
        if (field === promptCandidate || (!promptAssigned && !promptCandidate && (field.type === "textarea" || field.type === "text"))) {
            fieldValue = prompt;
            promptAssigned = true;
        }
        if (preferences.size && preferences.size !== "auto" && /aspect.?ratio|ratio|尺寸|比例/i.test(`${field.fieldName} ${field.label}`)) fieldValue = preferences.size;
        if (preferences.quality && preferences.quality !== "auto" && /resolution|quality|画质|分辨率/i.test(`${field.fieldName} ${field.label}`)) fieldValue = ({ low: "1k", medium: "2k", high: "4k" } as Record<string, string>)[preferences.quality] || preferences.quality;
        return { nodeId: field.nodeId, fieldName: field.fieldName, fieldValue };
    });
}

function parseAiAppFields(payload: unknown): RunningHubField[] {
    const list = valueAt(payload, ["data", "nodeInfoList"]);
    if (!Array.isArray(list)) return [];
    return list.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const record = item as Record<string, unknown>;
        const nodeId = String(record.nodeId || "").trim();
        const fieldName = String(record.fieldName || "").trim();
        if (!nodeId || !fieldName) return [];
        return [{ nodeId, fieldName, label: String(record.description || fieldName), type: normalizeFieldType(record.fieldType, fieldName), defaultValue: String(record.fieldValue ?? ""), options: parseOptions(record.fieldData) }];
    });
}

function parseWorkflowFields(payload: unknown): RunningHubField[] {
    const raw = valueAt(payload, ["data", "prompt"]);
    let workflow: unknown = raw;
    if (typeof raw === "string") {
        try {
            workflow = JSON.parse(raw);
        } catch {
            return [];
        }
    }
    if (!workflow || typeof workflow !== "object") return [];
    return Object.entries(workflow as Record<string, unknown>).flatMap(([nodeId, node]) => {
        if (!node || typeof node !== "object") return [];
        const record = node as Record<string, unknown>;
        const inputs = record.inputs && typeof record.inputs === "object" ? (record.inputs as Record<string, unknown>) : {};
        const title = record._meta && typeof record._meta === "object" ? String((record._meta as Record<string, unknown>).title || nodeId) : nodeId;
        return Object.entries(inputs).flatMap(([fieldName, value]) => {
            if (Array.isArray(value) || (value !== null && typeof value === "object")) return [];
            return [{ nodeId, fieldName, label: `${title} · ${fieldName}`, type: normalizeFieldType(typeof value === "boolean" ? "switch" : "text", fieldName), defaultValue: String(value ?? ""), options: [] }];
        });
    });
}

function normalizeFieldType(value: unknown, fieldName: string): RunningHubField["type"] {
    const type = String(value || "text").toLowerCase();
    if (/image|图片/.test(type) || /image|图片/.test(fieldName)) return "image";
    if (/video|视频/.test(type) || /video|视频/.test(fieldName)) return "video";
    if (/audio|音频/.test(type) || /audio|音频/.test(fieldName)) return "audio";
    if (type === "textarea" || type === "number" || type === "select" || type === "radio" || type === "switch") return type;
    return "text";
}

function parseOptions(value: unknown) {
    if (Array.isArray(value)) return value.map(String);
    if (typeof value !== "string" || !value.trim()) return [];
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
        return value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean);
    }
}

async function requireSettings() {
    const settings = await getRunningHubPrivateSettings();
    if (!settings.enabled) throw new RunningHubError("请先在管理后台启用 RunningHub", 422);
    if (!settings.apiKey) throw new RunningHubError("请先配置 RunningHub API Key", 422);
    return settings;
}

async function runningHubJson(
    settings: Awaited<ReturnType<typeof requireSettings>>,
    path: string,
    body: unknown,
    log: { phase: "account" | "sync" | "submit" | "query" | "cancel"; taskId?: string; appId?: string; method?: "GET" | "POST" },
    allowBusinessError = false,
) {
    const startedAt = Date.now();
    const method = log.method || "POST";
    try {
        const response = await fetchSafeOutbound(`${settings.apiBaseUrl}${path}`, {
            method,
            headers: { Authorization: `Bearer ${settings.apiKey}`, ...(method === "POST" ? { "Content-Type": "application/json" } : {}) },
            ...(method === "POST" ? { body: JSON.stringify(body || {}) } : {}),
            cache: "no-store",
            signal: AbortSignal.timeout(log.phase === "query" ? 60_000 : 120_000),
        });
        const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        const businessOk = allowBusinessError || Number(payload.code) === 0;
        await appendRunningHubRequestLog({ taskId: log.taskId, appId: log.appId, phase: log.phase, path, statusCode: response.status, durationMs: Date.now() - startedAt, ...(!response.ok || !businessOk ? { error: safeUpstreamMessage(payload, `HTTP ${response.status}`) } : {}) });
        if (!response.ok || !businessOk) throw upstreamError(payload, `RunningHub ${log.phase} 请求失败`, response.status);
        return payload;
    } catch (error) {
        if (error instanceof RunningHubError) throw error;
        await appendRunningHubRequestLog({ taskId: log.taskId, appId: log.appId, phase: log.phase, path, statusCode: 0, durationMs: Date.now() - startedAt, error: error instanceof Error ? error.message.slice(0, 500) : "请求失败" });
        throw new RunningHubError(error instanceof Error ? error.message : "RunningHub 请求失败", 502, true);
    }
}

function upstreamError(payload: unknown, fallback: string, status = 502) {
    const code = Number((payload as Record<string, unknown> | null)?.code);
    return new RunningHubError(safeUpstreamMessage(payload, fallback), status >= 400 && status < 600 ? status : 502, code === 421 || code === 804 || code === 813 || status >= 500);
}

function safeUpstreamMessage(payload: unknown, fallback: string) {
    if (!payload || typeof payload !== "object") return fallback;
    const record = payload as Record<string, unknown>;
    const message = typeof record.msg === "string" ? record.msg : typeof record.message === "string" ? record.message : "";
    return (message.trim() || fallback).slice(0, 500);
}

function valueAt(value: unknown, path: string[]) {
    return path.reduce<unknown>((current, key) => (current && typeof current === "object" ? (current as Record<string, unknown>)[key] : undefined), value);
}
function textAt(value: unknown, path: string[]) {
    const result = valueAt(value, path);
    return typeof result === "string" || typeof result === "number" ? String(result) : "";
}
