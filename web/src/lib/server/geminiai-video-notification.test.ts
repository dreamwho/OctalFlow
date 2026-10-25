import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ wake: vi.fn(), recover: vi.fn() }));
vi.mock("./generation-task-scheduler", () => ({ wakeGeminiAiVideoTask: mocks.wake }));
vi.mock("./generation-task-recovery-service", () => ({ runGenerationTaskRecoveryBatch: mocks.recover }));
import { authorizedGeminiAiVideoNotification, recoverNotifiedGeminiAiVideo } from "./geminiai-video-notification";

afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetAllMocks();
});
describe("Omni completion notifications", () => {
    it("requires the independent sidecar credential", () => {
        vi.stubEnv("DREAMYO_GEMINIAI_API_KEY", "fixture-sidecar-key");
        const request = (key: string) => new Request("http://app/notify", { headers: { authorization: `Bearer ${key}` } });
        expect(authorizedGeminiAiVideoNotification(request("wrong-key"))).toBe(false);
        expect(authorizedGeminiAiVideoNotification(request("fixture-sidecar-key"))).toBe(true);
        vi.stubEnv("DREAMYO_GEMINIAI_API_KEY", "");
        expect(authorizedGeminiAiVideoNotification(request("fixture-sidecar-key"))).toBe(false);
    });
    it("queries the saved identity then persists a ready result", async () => {
        mocks.wake.mockResolvedValue([{ id: "local-one" }]);
        mocks.recover.mockResolvedValueOnce({ claimed: 1, resultReady: 1 }).mockResolvedValueOnce({ completed: 1 });
        expect(await recoverNotifiedGeminiAiVideo("vt_one", "http://app")).toBe(1);
        expect(mocks.recover).toHaveBeenCalledTimes(2);
        expect(mocks.recover.mock.calls).toEqual([[{ origin: "http://app", taskIds: ["local-one"], limit: 1 }], [{ origin: "http://app", taskIds: ["local-one"], limit: 1 }]]);
    });
    it("leaves a busy lease to its current owner", async () => {
        mocks.wake.mockResolvedValue([{ id: "local-one" }]);
        mocks.recover.mockResolvedValue({ claimed: 0, resultReady: 0 });
        await recoverNotifiedGeminiAiVideo("vt_one", "http://app");
        expect(mocks.recover).toHaveBeenCalledTimes(1);
    });
    it("does not resurrect an unmatched or terminal task", async () => {
        mocks.wake.mockResolvedValue([]);
        expect(await recoverNotifiedGeminiAiVideo("vt_one", "http://app")).toBe(0);
        expect(mocks.recover).not.toHaveBeenCalled();
    });
});
