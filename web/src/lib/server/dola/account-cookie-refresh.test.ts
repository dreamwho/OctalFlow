import { beforeEach, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => ({ accounts: [] as Array<Record<string, unknown>> }));
vi.mock("@/lib/server/data-adapter", () => ({
    readJsonDataFile: vi.fn(async () => structuredClone(storage)),
    writeJsonDataFile: vi.fn(async (_file: string, value: typeof storage) => { storage.accounts = structuredClone(value.accounts); }),
    withJsonDataFileLock: vi.fn(async (_file: string, callback: () => Promise<unknown>) => callback()),
}));
vi.mock("@/lib/server/secret-crypto", () => ({ encryptSecretValue: (value: string) => value, decryptSecretValue: (value: string) => value }));

import { getDolaAccount, getDolaAccountCookie, importDolaAccounts, refreshDolaAccountCookieIfVersion } from "./account-service";

beforeEach(() => { storage.accounts = []; });

it("saves a refreshed Cookie atomically, preserving unchanged versions and rejecting stale sessions", async () => {
    const imported = await importDolaAccounts([{ cookie: "sid=initial" }]);
    const id = imported.results[0].account!.id;
    expect(await refreshDolaAccountCookieIfVersion(id, "sid=initial", 1)).toEqual({ changed: false });
    expect((await getDolaAccount(id))?.credentialVersion).toBe(1);
    expect(await refreshDolaAccountCookieIfVersion(id, "sid=refreshed", 1)).toEqual({ changed: true });
    expect((await getDolaAccount(id))?.credentialVersion).toBe(2);
    await expect(refreshDolaAccountCookieIfVersion(id, "sid=stale", 1)).rejects.toThrow("cookie_version_conflict");
    expect(await getDolaAccountCookie(id)).toBe("sid=refreshed");
});
