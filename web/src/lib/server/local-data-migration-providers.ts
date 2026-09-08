import type { QueryExecutor } from "@/lib/server/database";
import { DreaminaCliRepository } from "@/lib/server/database/dreamina-cli-repository";
import { GeminiAiRequestLogRepository } from "@/lib/server/database/geminiai-request-log-repository";
import { GeminiToolsRepository } from "@/lib/server/database/gemini-tools-repository";
import type { DreaminaCliAccountState, DreaminaCliRequestLog } from "@/lib/server/dreamina-cli-store";
import type { GeminiAiRequestLog } from "@/lib/server/geminiai-request-log-store";
import type {
    GeminiToolsGatewaySettings,
    GeminiToolsOAuthSession,
    GeminiToolsRequestLog,
    StoredGeminiToolsAccount,
    StoredGeminiToolsApiKey,
} from "@/lib/server/gemini-tools-store";

type JsonRecord = Record<string, unknown>;

type ProviderImportCounts = {
    geminiToolsAccounts: number;
    geminiToolsOAuthSessions: number;
    geminiToolsApiKeys: number;
    geminiToolsLogs: number;
    geminiToolsGateway: number;
    geminiaiRequestLogs: number;
    dreaminaCliAccount: number;
    dreaminaCliLogs: number;
};

export async function importMigrationProviders(client: QueryExecutor, files: Record<string, unknown>): Promise<ProviderImportCounts> {
    const counts: ProviderImportCounts = {
        geminiToolsAccounts: 0,
        geminiToolsOAuthSessions: 0,
        geminiToolsApiKeys: 0,
        geminiToolsLogs: 0,
        geminiToolsGateway: 0,
        geminiaiRequestLogs: 0,
        dreaminaCliAccount: 0,
        dreaminaCliLogs: 0,
    };
    const geminiTools = new GeminiToolsRepository(client);
    const geminiaiLogs = new GeminiAiRequestLogRepository(client);
    const dreaminaCli = new DreaminaCliRepository(client);

    const geminiToolsFile = optionalObjectFile(files, "gemini-tools.json");
    if (geminiToolsFile) {
        const accounts = records(geminiToolsFile, "accounts", "gemini-tools.json").map((value) => value as StoredGeminiToolsAccount);
        for (const account of accounts) await geminiTools.upsertAccount(account);
        counts.geminiToolsAccounts = accounts.length;

        const oauthSessions = records(geminiToolsFile, "oauthSessions", "gemini-tools.json").map((value) => value as GeminiToolsOAuthSession);
        for (const session of oauthSessions) await geminiTools.createOAuthSession(session);
        counts.geminiToolsOAuthSessions = oauthSessions.length;

        const apiKeys = records(geminiToolsFile, "apiKeys", "gemini-tools.json").map((value) => value as StoredGeminiToolsApiKey);
        for (const apiKey of apiKeys) await geminiTools.insertApiKey(apiKey);
        counts.geminiToolsApiKeys = apiKeys.length;

        const logs = records(geminiToolsFile, "logs", "gemini-tools.json").map((value) => value as GeminiToolsRequestLog);
        for (const log of logs) await geminiTools.appendLog(log, logs.length);
        counts.geminiToolsLogs = logs.length;

        if (geminiToolsFile.gateway !== undefined) {
            await geminiTools.updateGateway(geminiToolsFile.gateway as GeminiToolsGatewaySettings);
            counts.geminiToolsGateway = 1;
        }
    }

    const geminiaiFile = optionalObjectFile(files, "geminiai-request-logs.json");
    if (geminiaiFile) {
        const logs = records(geminiaiFile, "logs", "geminiai-request-logs.json").map((value) => value as GeminiAiRequestLog);
        for (const log of logs) await geminiaiLogs.append(log, logs.length);
        counts.geminiaiRequestLogs = logs.length;
    }

    const dreaminaFile = optionalObjectFile(files, "dreamina-cli.json");
    if (dreaminaFile) {
        if (dreaminaFile.account !== undefined) {
            await dreaminaCli.saveAccountState(dreaminaFile.account as DreaminaCliAccountState);
            counts.dreaminaCliAccount = 1;
        }

        const logs = records(dreaminaFile, "logs", "dreamina-cli.json").map((value) => value as DreaminaCliRequestLog);
        for (const log of logs) await dreaminaCli.appendRequestLog(log);
        counts.dreaminaCliLogs = logs.length;
    }

    return counts;
}

function optionalObjectFile(files: Record<string, unknown>, fileName: string): JsonRecord | undefined {
    if (!Object.prototype.hasOwnProperty.call(files, fileName)) return undefined;
    const value = files[fileName];
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${fileName} 必须是对象`);
    return value as JsonRecord;
}

function records(file: JsonRecord, field: string, fileName: string): JsonRecord[] {
    const value = file[field];
    if (!Array.isArray(value)) throw new Error(`${fileName}.${field} 必须是数组`);
    return value.map((item, index) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`${fileName}.${field}[${index}] 必须是对象`);
        return item as JsonRecord;
    });
}
