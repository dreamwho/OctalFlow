import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ execute: vi.fn(), copy: vi.fn(), verify: vi.fn(), read: vi.fn() }));
vi.mock("node:child_process", () => ({ execFileSync: mocks.execute }));
vi.mock("node:fs/promises", () => ({ readFile: mocks.read }));
vi.mock("./restore-private-files.mjs", () => ({ restorePrivateFiles: mocks.copy, verifyPrivateSnapshot: mocks.verify }));
afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
});
it("does not overwrite changed runtime media or account files after a matching receipt", async () => {
    vi.stubEnv("OCTALAICANVAS_ENCRYPTION_KEY", "a".repeat(64));
    mocks.verify.mockResolvedValue({ version: 1, id: "snapshot" });
    mocks.read.mockResolvedValue(`OCTALAICANVAS_ENCRYPTION_KEY='${"a".repeat(64)}'`);
    mocks.execute.mockReturnValue(JSON.stringify({ status: "alreadyImported", counts: { users: 2 } }));
    vi.spyOn(console, "log").mockImplementation(() => {});
    await import("./restore-private-migration.mjs");
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    expect(mocks.copy).not.toHaveBeenCalled();
});
