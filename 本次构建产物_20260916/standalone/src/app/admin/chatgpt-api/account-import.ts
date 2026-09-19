import { accountOperationOutcome, type AccountOperationResult } from "./account-operation-result";

export type ImportedAccount = Record<string, string> & { access_token: string };
export type AccountImportPayload = { accounts?: unknown[]; tokens?: string[]; sync_after_import: false };
export type ImportProgress = { completed: number; total: number; batch: number; batches: number; added: number; skipped: number };
export type AccountFileImport = { accounts: ImportedAccount[]; duplicates: number; files: number; errors: string[] };
// Matches the existing administrative bridge request-body contract.
export const ACCOUNT_IMPORT_MAX_BYTES = 64 * 1024;
const fields = ["access_token", "refresh_token", "id_token", "email", "account_id", "chatgpt_account_id", "chatgpt_user_id", "type"] as const;
const object = (value: unknown): Record<string, unknown> | null => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null);

export function parseAccountDocument(text: string): ImportedAccount[] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text.replace(/^\uFEFF/, ""));
    } catch {
        throw new Error("不是有效的 JSON 文件");
    }
    const root = object(parsed);
    const rows = Array.isArray(parsed) ? parsed : Array.isArray(root?.accounts) ? root.accounts : [parsed];
    if (!rows.length) throw new Error("文件中没有账号");
    return rows.map((row, index) => {
        const item = object(row);
        const credentials = object(item?.credentials);
        const account: Record<string, string> = {};
        for (const key of fields) {
            const value = credentials?.[key] ?? item?.[key];
            if (typeof value === "string" && value.trim()) account[key] = value.trim();
        }
        if (!account.access_token) throw new Error(`第 ${index + 1} 个账号缺少 access_token`);
        // The export's OAuth record type is not an account plan.
        if (credentials) delete account.type;
        return account as ImportedAccount;
    });
}

export async function readAccountFiles(files: readonly Pick<File, "name" | "text">[]): Promise<AccountFileImport> {
    const result: AccountFileImport = { accounts: [], duplicates: 0, files: files.length, errors: [] };
    const unique = new Map<string, ImportedAccount>();
    // Read each file once; never persist the raw file or expose parser errors containing credentials.
    for (const [index, file] of files.entries()) {
        if (!file.name.toLowerCase().endsWith(".json")) {
            result.errors.push(`文件 ${index + 1}：请选择 JSON 文件`);
            continue;
        }
        let text: string;
        try {
            text = await file.text();
        } catch {
            result.errors.push(`文件 ${index + 1}：读取失败，请重新选择`);
            continue;
        }
        try {
            for (const account of parseAccountDocument(text)) {
                const existing = unique.get(account.access_token);
                if (existing) {
                    result.duplicates++;
                    unique.set(account.access_token, { ...account, ...existing });
                } else unique.set(account.access_token, account);
            }
        } catch (error) {
            result.errors.push(`文件 ${index + 1}：${error instanceof Error ? error.message : "格式无效"}`);
        }
    }
    result.accounts = [...unique.values()];
    if (!result.errors.length && result.accounts.length) {
        try {
            splitAccountImport(accountFilePayload(result));
        } catch (error) {
            result.errors.push(error instanceof Error ? error.message : "账号格式无效");
        }
    }
    return result;
}

export function accountFilePayload(result: AccountFileImport) {
    if (result.errors.length || !result.accounts.length) throw new Error("请先选择有效的账号 JSON 文件，并处理全部错误");
    const payload = { accounts: result.accounts, sync_after_import: false as const };
    return payload;
}

export function splitAccountImport(payload: AccountImportPayload): AccountImportPayload[] {
    const key = payload.accounts ? "accounts" : "tokens";
    const items = payload.accounts || payload.tokens || [];
    if (!items.length) throw new Error("没有可导入的账号");
    const make = (values: unknown[]) => ({ [key]: values, sync_after_import: false }) as AccountImportPayload;
    const encoder = new TextEncoder();
    const base = encoder.encode(JSON.stringify(make([]))).length;
    let bytes = base;
    let batch: unknown[] = [];
    const batches: AccountImportPayload[] = [];
    for (const [index, item] of items.entries()) {
        const size = encoder.encode(JSON.stringify(item)).length;
        if (base + size > ACCOUNT_IMPORT_MAX_BYTES) throw new Error(`第 ${index + 1} 个账号单独超过 64KB，请检查该账号文件是否异常`);
        if (bytes + size + (batch.length ? 1 : 0) > ACCOUNT_IMPORT_MAX_BYTES) {
            batches.push(make(batch));
            batch = [];
            bytes = base;
        }
        bytes += size + (batch.length ? 1 : 0);
        batch.push(item);
    }
    if (batch.length) batches.push(make(batch));
    return batches;
}

export async function submitAccountImport(payload: AccountImportPayload, submit: (batch: AccountImportPayload) => Promise<AccountOperationResult>, onProgress: (progress: ImportProgress) => void) {
    const batches = splitAccountImport(payload);
    const progress: ImportProgress = { completed: 0, total: (payload.accounts || payload.tokens || []).length, batch: 0, batches: batches.length, added: 0, skipped: 0 };
    onProgress({ ...progress });
    for (const [index, batch] of batches.entries()) {
        try {
            const result = await submit(batch);
            const outcome = accountOperationOutcome(result);
            if (outcome.kind !== "complete" || outcome.failed) throw new Error("该批结果尚未全部确认成功");
            progress.completed += (batch.accounts || batch.tokens || []).length;
            progress.batch = index + 1;
            progress.added += result.added!;
            progress.skipped += result.skipped!;
            onProgress({ ...progress });
        } catch {
            throw new Error(
                `第 ${index + 1}/${batches.length} 批导入中断，已确认完成 ${progress.completed}/${progress.total} 个（新增 ${progress.added} 个，更新/跳过 ${progress.skipped} 个）。当前批可能已写入，请先刷新账号列表核对；未自动重试，也未提交后续批次。`,
            );
        }
    }
    return progress;
}
