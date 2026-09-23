import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({ accounts: [] as Array<Record<string, unknown>> }));
vi.mock("@/lib/server/data-adapter", () => ({
    readJsonDataFile: vi.fn(async () => structuredClone(database)),
    writeJsonDataFile: vi.fn(async (_name: string, value: typeof database) => { database.accounts = structuredClone(value.accounts); }),
    withJsonDataFileLock: vi.fn(async (_name: string, action: () => Promise<unknown>) => action()),
}));
vi.mock("@/lib/server/secret-crypto", () => ({
    encryptSecretValue: (value: string) => `encrypted:${value}`,
    decryptSecretValue: (value: string) => value.replace(/^encrypted:/, ""),
}));

import { editDolaAccount, getDolaAccountCookie, importDolaAccounts } from "./account-service";

describe("Dola account editor", () => {
    beforeEach(() => { database.accounts = []; });

    it("keeps an unchanged Cookie private and updates account details", async () => {
        const imported = await importDolaAccounts([{ cookie: "sid=old" }]);
        const id = imported.results[0].account!.id;
        const edited = await editDolaAccount(id, { name: "新名称", email: "a@example.com", group: "A", cookie: "" });
        expect(edited).toMatchObject({ id, name: "新名称", email: "a@example.com", group: "A", credentialVersion: 1 });
        expect(JSON.stringify(edited)).not.toContain("sid=old");
        expect(await getDolaAccountCookie(id)).toBe("sid=old");
    });

    it("validates a replacement Cookie and excludes it from dispatch until login is checked", async () => {
        const imported = await importDolaAccounts([{ cookie: "sid=old" }]);
        const id = imported.results[0].account!.id;
        await expect(editDolaAccount(id, { name: "账号", email: "", group: "", cookie: "invalid" })).rejects.toThrow("Cookie 键值格式无效");
        const edited = await editDolaAccount(id, { name: "账号", email: "", group: "", cookie: "sid=new" });
        expect(edited).toMatchObject({ credentialVersion: 2, status: "verification_required", loginState: "unknown" });
        expect(await getDolaAccountCookie(id)).toBe("sid=new");
        expect(JSON.stringify(edited)).not.toContain("sid=new");
    });
});
