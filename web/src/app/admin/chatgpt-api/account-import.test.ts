import { describe, expect, it } from "vitest";
import { accountFilePayload, parseAccountDocument, readAccountFiles, splitAccountImport, submitAccountImport, type ImportProgress } from "./account-import";

const account = { access_token: "fixture-at", refresh_token: "fixture-rt", id_token: "fixture-id", email: "fixture@example.test" };
const file = (value: unknown, name = "fixture.json") => ({ name, text: async () => JSON.stringify(value) });

describe("account file import", () => {
    it("imports fifty large accounts in byte-bounded batches without dropping or duplicating entries", async () => {
        const accounts = Array.from({ length: 50 }, (_, i) => ({ ...account, access_token: `fixture-${i}-` + "中".repeat(1000) }));
        const result = await readAccountFiles(accounts.map((a) => file(a)));
        expect(result.errors).toEqual([]);
        const payload = accountFilePayload(result);
        const batches = splitAccountImport(payload);
        expect(batches.length).toBeGreaterThan(1);
        expect(batches.flatMap((batch) => batch.accounts!)).toEqual(accounts);
        for (const batch of batches) expect(new TextEncoder().encode(JSON.stringify(batch)).length).toBeLessThanOrEqual(65536);
        const progress: ImportProgress[] = [];
        let calls = 0;
        const complete = await submitAccountImport(
            payload,
            async (batch) => {
                calls++;
                return { added: batch.accounts!.length, skipped: 0, errors: [] };
            },
            (value) => progress.push(value),
        );
        expect(complete).toMatchObject({ completed: 50, added: 50, total: 50 });
        expect(calls).toBe(batches.length);
        expect(progress.map((value) => value.completed)).toEqual([0, ...batches.map((_, index) => batches.slice(0, index + 1).reduce((total, batch) => total + batch.accounts!.length, 0))]);
    });
    it("stops on an uncertain batch without retrying or sending later batches", async () => {
        const accounts = Array.from({ length: 5 }, (_, i) => ({ access_token: String(i) + "x".repeat(40_000) }));
        let calls = 0;
        await expect(
            submitAccountImport(
                { accounts, sync_after_import: false },
                async () => {
                    if (++calls === 2) throw new Error("network");
                    return { added: 1, skipped: 0, errors: [] };
                },
                () => {},
            ),
        ).rejects.toThrow("已确认完成 1/5");
        expect(calls).toBe(2);
    });
    it("preflights all batches before writing and supports pasted tokens", async () => {
        let calls = 0;
        await expect(
            submitAccountImport(
                { tokens: ["valid", "x".repeat(65536)], sync_after_import: false },
                async () => {
                    calls++;
                    return {};
                },
                () => {},
            ),
        ).rejects.toThrow("第 2 个账号");
        expect(calls).toBe(0);
        const payload = { tokens: ["x".repeat(40_000), "y".repeat(40_000)], sync_after_import: false as const };
        expect(splitAccountImport(payload)).toHaveLength(2);
    });
    it("normalizes CPA credentials and strips unrelated settings and session cookies", () => {
        expect(parseAccountDocument("\uFEFF" + JSON.stringify({ ...account, type: "codex", proxy: "private-proxy", session_token: "unused-cookie", enabled: false }))).toEqual([{ ...account, type: "codex" }]);
    });
    it("flattens Sub2API accounts without importing remote configuration", () => {
        expect(parseAccountDocument(JSON.stringify({ proxies: [{ url: "not-imported" }], accounts: [{ type: "oauth", credentials: account, concurrency: 99 }] }))).toEqual([account]);
    });
    it("recognizes twenty files as ten accounts across both formats", async () => {
        const cpa = Array.from({ length: 10 }, (_, i) => ({ ...account, access_token: "fixture-" + i }));
        const result = await readAccountFiles([...cpa.map((a) => file(a)), ...cpa.map((a) => file({ accounts: [{ credentials: a }] }))]);
        expect(result).toMatchObject({ files: 20, duplicates: 10, errors: [] });
        expect(result.accounts).toHaveLength(10);
        expect(accountFilePayload(result)).toEqual({ accounts: cpa, sync_after_import: false });
    });
    it("merges missing fields from duplicate records without losing the first credential", async () => {
        const result = await readAccountFiles([file({ access_token: account.access_token }), file(account)]);
        expect(result.accounts).toEqual([account]);
    });
    it("rejects mixed invalid files as a whole without exposing credential text", async () => {
        const result = await readAccountFiles([file(account), { name: "bad.json", text: async () => '{"access_token":"private-secret"' }, file({ accounts: [{}] }), file(account, "bad.txt")]);
        expect(result.errors).toHaveLength(3);
        expect(result.errors.join()).not.toContain("private-secret");
        expect(() => accountFilePayload(result)).toThrow("处理全部错误");
    });
    it.each(["null", "[]", "true", '{"accounts":[]}', '{"access_token":42}', '{"refresh_token":"rt"}'])("rejects empty or unsupported account data %s", (text) => {
        expect(() => parseAccountDocument(text)).toThrow();
    });
    it("handles failed file reads and empty selections", async () => {
        const result = await readAccountFiles([
            {
                name: "fixture.json",
                text: async () => {
                    throw new Error("private-error");
                },
            },
        ]);
        expect(result.errors).toEqual(["文件 1：读取失败，请重新选择"]);
        expect(() => accountFilePayload({ accounts: [], duplicates: 0, files: 0, errors: [] })).toThrow();
    });
    it("validates the existing bridge byte limit after dropping unused export data", async () => {
        const largeExtra = await readAccountFiles([file({ ...account, extra: "x".repeat(100_000) })]);
        expect(largeExtra.errors).toEqual([]);
        const largeCredentials = await readAccountFiles([file({ access_token: "x".repeat(65_536) })]);
        expect(largeCredentials.errors[0]).toContain("64KB");
    });
});
