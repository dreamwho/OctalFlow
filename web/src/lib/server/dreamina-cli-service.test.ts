import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getAuthSettings } from "@/lib/auth/store";

import { getDreaminaCliOverview, getDreaminaCliPublicStatus, refreshDreaminaCliRuntime, saveDreaminaCliModelSelection, submitDreaminaCliTaskWithCreditObservation } from "./dreamina-cli-service";
import { acquireDreaminaCliSubmitLease, listDreaminaCliRequestLogs, releaseDreaminaCliSubmitLease, updateDreaminaCliAccountState } from "./dreamina-cli-store";

describe("Dreamina CLI service", () => {
    let directory = "";

    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), "octal-dreamina-service-"));
        vi.stubEnv("OCTALAICANVAS_DATABASE_PROVIDER", "file");
        vi.stubEnv("OCTALAICANVAS_DATA_DIR", directory);
    });

    afterEach(async () => {
        vi.unstubAllEnvs();
        await rm(directory, { recursive: true, force: true });
    });

    it("returns a persisted overview without invoking the local CLI", async () => {
        await updateDreaminaCliAccountState({ status: "authorized", userId: "109589671187480", vipLevel: "maestro", totalCredit: 5401, cliVersion: "673dd28-dirty", lastCreditCheckedAt: "2026-08-31T00:00:00.000Z" });
        await saveDreaminaCliModelSelection({ modelIds: ["dreamina-seedream-5-0", "dreamina-seedance-2-5", "dreamina-image-upscale"] });

        await expect(getDreaminaCliOverview()).resolves.toMatchObject({
            runtime: { installed: true, authorized: true, account: { userIdMasked: "10****80", vipLevel: "maestro", totalCredit: 5401 } },
            models: { enabledModelIds: ["dreamina-seedream-5-0", "dreamina-seedance-2-5", "dreamina-image-upscale"] },
        });
        await expect(getDreaminaCliPublicStatus()).resolves.toEqual({ enabled: true, authorized: true, vipLevel: "maestro", checkedAt: "2026-08-31T00:00:00.000Z" });
    });

    it("refreshes only through an injected server runner and persists a safe snapshot", async () => {
        vi.stubEnv("OCTALAICANVAS_DREAMINA_CLI_PATH", process.execPath);
        const runner = vi.fn().mockImplementation(async (_executable: string, args: readonly string[]) => {
            if (args[0] === "version") return { stdout: '{"version":"673dd28-dirty","commit":"673dd28"}', stderr: "", exitCode: 0 };
            if (args[0] === "user_credit") return { stdout: '{"total_credit":5401,"user_id":"109589671187480","vip_level":"maestro"}', stderr: "", exitCode: 0 };
            return { stdout: "", stderr: "unexpected", exitCode: 1 };
        });

        const overview = await refreshDreaminaCliRuntime({ runner });
        expect(runner.mock.calls.map((call) => call[1][0])).toEqual(["version", "user_credit"]);
        expect(overview.runtime).toMatchObject({ installed: true, authorized: true, version: "673dd28-dirty", account: { totalCredit: 5401 } });
    });

    it("syncs only enabled CLI models into logical models and removes disabled bindings", async () => {
        await updateDreaminaCliAccountState({ status: "authorized", userId: "account", totalCredit: 100 });
        await saveDreaminaCliModelSelection({ modelIds: ["dreamina-seedream-4-0", "dreamina-seedream-5-0-pro", "dreamina-seedance-2-0"] });

        let settings = await getAuthSettings();
        expect(settings.systemChannels.find((channel) => channel.id === "dreamina-cli")?.models).toEqual(["dreamina-seedream-4-0", "dreamina-seedream-5-0-pro", "dreamina-seedance-2-0"]);
        expect(settings.logicalModels.filter((model) => model.bindings.some((binding) => binding.channelId === "dreamina-cli")).map((model) => model.id)).toEqual(["dreamina-seedream-4-0", "dreamina-seedream-5-0-pro", "dreamina-seedance-2-0"]);
        expect(settings.logicalModels.find((model) => model.id === "dreamina-seedream-5-0-pro")?.name).toBe("Seedream 5.0 Pro");

        await saveDreaminaCliModelSelection({ modelIds: ["dreamina-seedream-5-0-pro"] });
        settings = await getAuthSettings();
        expect(settings.logicalModels.filter((model) => model.bindings.some((binding) => binding.channelId === "dreamina-cli")).map((model) => model.id)).toEqual(["dreamina-seedream-5-0-pro"]);
    });

    it("allows clearing models while unauthorized but blocks enabling them", async () => {
        await expect(saveDreaminaCliModelSelection({ modelIds: ["dreamina-seedream-5-0"] })).rejects.toMatchObject({ status: 409 });
        await expect(saveDreaminaCliModelSelection({ modelIds: [] })).resolves.toMatchObject({ enabledModelIds: [] });
    });

    it("records the official submit credit_count without querying account balance per task", async () => {
        await updateDreaminaCliAccountState({ status: "authorized", userId: "account", vipLevel: "maestro", totalCredit: 100 });
        const runner = vi.fn().mockResolvedValue({ stdout: '{"submit_id":"official-task","credit_count":6}', stderr: "", exitCode: 0 });

        await expect(submitDreaminaCliTaskWithCreditObservation({ command: "text2image", modelId: "dreamina-seedream-5-0", prompt: "测试", resolutionType: "2k" }, { taskId: "task", runner })).resolves.toMatchObject({
            submitId: "official-task",
            creditCost: 6,
            creditObservation: { kind: "official", delta: 6 },
        });
        expect(runner).toHaveBeenCalledTimes(1);
        expect(runner.mock.calls[0]?.[1][0]).toBe("text2image");
        await expect(listDreaminaCliRequestLogs()).resolves.toMatchObject({
            items: [expect.objectContaining({ status: "started", creditObservation: "official", observedCreditDelta: 6, submissionSummary: { accepted: true, submitId: "official-task", officialCreditCost: 6 }, resultSummary: {} })],
        });
    });

    it("marks a confirmed account submit lease collision as safely deferred", async () => {
        await updateDreaminaCliAccountState({ status: "authorized", userId: "account", vipLevel: "maestro", totalCredit: 100 });
        const held = await acquireDreaminaCliSubmitLease({ owner: "another-submit", taskId: "other-task", leaseUntil: new Date(Date.now() + 30_000) });

        await expect(submitDreaminaCliTaskWithCreditObservation({ command: "text2image", modelId: "dreamina-seedream-5-0", prompt: "测试", resolutionType: "2k" }, { taskId: "waiting-task", runner: vi.fn() })).rejects.toMatchObject({ status: 409, retryAfterAt: expect.any(Number) });
        await releaseDreaminaCliSubmitLease(held!.owner);
    });
});
