import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ ciphertextRow: undefined as Record<string, unknown> | undefined }));

vi.mock("@/lib/server/database", () => ({
    isPostgresDatabaseEnabled: () => true,
    postgresRepository: async () => undefined,
    withPostgresTransaction: vi.fn(),
}));

vi.mock("@/lib/server/database/postgres", () => ({
    ensurePostgresSchema: vi.fn(async () => undefined),
    isPostgresDatabaseEnabled: () => true,
    postgresQuery: vi.fn(async () => ({ rows: mocks.ciphertextRow ? [mocks.ciphertextRow] : [] })),
}));

vi.mock("@/lib/server/secret-crypto", () => ({
    decryptSecretValue: (value: string) => value,
    encryptSecretValue: (value: string) => value,
}));

vi.mock("@/lib/server/data-adapter", () => ({
    readJsonDataFile: vi.fn(async () => undefined),
    writeJsonDataFile: vi.fn(async () => undefined),
    withJsonDataFileLock: vi.fn(async (_name: string, run: () => Promise<unknown>) => run()),
}));

import { getMagicProxyOverview } from "./magic-proxy-service";

/** 回归：存量配置保存的 http 订阅地址曾让 readSettings 抛错，
 * 导致魔法代理与各 Provider 代理绑定的读取全部失败、本地文件导入也被连带拦截。 */
describe("magic proxy stored settings leniency", () => {
    beforeEach(() => {
        mocks.ciphertextRow = undefined;
    });

    it("reads stored settings even when the saved subscription url is http", async () => {
        mocks.ciphertextRow = {
            subscription_url_ciphertext: "http://airport.example.com/sub?token=1",
            nodes_ciphertext: JSON.stringify([{ name: "节点1", type: "ss", server: "1.2.3.4", port: 443, cipher: "aes-128-gcm", password: "x" }]),
        };

        const overview = await getMagicProxyOverview();

        expect(overview.configured).toBe(true);
        expect(overview.nodeCount).toBe(1);
    });

    it("returns unconfigured when nothing is stored", async () => {
        const overview = await getMagicProxyOverview();
        expect(overview.configured).toBe(false);
    });
});
