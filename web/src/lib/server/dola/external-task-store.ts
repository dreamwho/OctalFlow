import { readJsonDataFile, withJsonDataFileLock, writeJsonDataFile } from "@/lib/server/data-adapter";

const FILE_NAME = "dola/external-tasks.json";
const MAX_RECORDS = 10_000;

export type DolaExternalTask = { taskId: string; apiKeyId: string; accountId: string; createdAt: string; releasedAt?: string };

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
