import { readJsonDataFile, withJsonDataFileLock, writeJsonDataFile } from "@/lib/server/data-adapter";

const FILE_NAME = "dola/external-tasks.json";
const MAX_RECORDS = 10_000;

export type DolaExternalTask = {
    taskId: string;
    apiKeyId: string;
    accountId: string;
    createdAt: string;
    releasedAt?: string;
    /** 首次提交时的调用方请求体（账号触发上游限额后用于自动换号重试；不含 Cookie） */
    originalPayload?: Record<string, unknown>;
    /** 上游账号触发限额的时间 */
    rateLimitedAt?: string;
    /** 已自动换号重试次数 */
    rotations?: number;
    /** 换号后的实际任务 id：继续查询旧任务 id 时会改查该任务 */
    redirectToTaskId?: string;
};

/** 换号链解析：沿 redirectToTaskId 找到当前实际任务与最终记录 */
export async function resolveDolaExternalTask(taskId: string, apiKeyId: string) {
    let record = await getDolaExternalTask(taskId, apiKeyId);
    if (!record) return null;
    let effectiveTaskId = record.taskId;
    for (let guard = 0; record.redirectToTaskId && guard < 5; guard += 1) {
        effectiveTaskId = record.redirectToTaskId;
        const next = await getDolaExternalTask(effectiveTaskId, apiKeyId);
        if (!next) break;
        record = { ...next, originalPayload: record.originalPayload ?? next.originalPayload, rotations: record.rotations };
    }
    return { record, effectiveTaskId };
}

export async function updateDolaExternalTask(taskId: string, apiKeyId: string, patch: Partial<DolaExternalTask>) {
    let updated: DolaExternalTask | null = null;
    await withJsonDataFileLock(FILE_NAME, async () => {
        const records = await readJsonDataFile<DolaExternalTask[]>(FILE_NAME, []);
        const record = records.find((item) => item.taskId === taskId && item.apiKeyId === apiKeyId);
        if (!record) return;
        Object.assign(record, patch);
        updated = { ...record };
        await writeJsonDataFile(FILE_NAME, records);
    });
    return updated;
}

export async function bindDolaExternalTask(input: Omit<DolaExternalTask, "createdAt">) {
    const value: DolaExternalTask = { ...input, createdAt: new Date().toISOString() };
    await withJsonDataFileLock(FILE_NAME, async () => {
        const records = await readJsonDataFile<DolaExternalTask[]>(FILE_NAME, []);
        const next = [value, ...records.filter((item) => item.taskId !== value.taskId)];
        await writeJsonDataFile(FILE_NAME, next.slice(0, MAX_RECORDS));
    });
    return value;
}

export async function getDolaExternalTask(taskId: string, apiKeyId: string) {
    const records = await readJsonDataFile<DolaExternalTask[]>(FILE_NAME, []);
    return records.find((item) => item.taskId === taskId && item.apiKeyId === apiKeyId) || null;
}

export async function releaseDolaExternalTask(taskId: string, apiKeyId: string) {
    let accountId = "";
    await withJsonDataFileLock(FILE_NAME, async () => {
        const records = await readJsonDataFile<DolaExternalTask[]>(FILE_NAME, []);
        const record = records.find((item) => item.taskId === taskId && item.apiKeyId === apiKeyId);
        if (!record || record.releasedAt) return;
        record.releasedAt = new Date().toISOString();
        accountId = record.accountId;
        await writeJsonDataFile(FILE_NAME, records);
    });
    return accountId;
}
