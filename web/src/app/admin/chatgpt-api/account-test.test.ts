import { afterEach, describe, expect, it, vi } from "vitest";

import { submitChatGptAccountTest } from "./account-test";

afterEach(() => vi.unstubAllGlobals());

describe("submitChatGptAccountTest", () => {
    it("does not call the API for empty input", async () => {
        const fetch = vi.fn();
        vi.stubGlobal("fetch", fetch);
        await expect(submitChatGptAccountTest({ accountId: "acct/1", mode: "chat", model: "", prompt: "x", inFlight: { current: false } })).resolves.toBeNull();
        expect(fetch).not.toHaveBeenCalled();
    });

    it("sends one exact request for the chosen account and parameters", async () => {
        const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ code: 0, data: { status: "success" } }) });
        vi.stubGlobal("fetch", fetch);
        const input = { accountId: "acct/1", mode: "image" as const, model: "gpt-image-2", prompt: "  画苹果  ", inFlight: { current: false } };
        const pending = submitChatGptAccountTest(input);
        const second = await submitChatGptAccountTest(input);
        expect(second).toBeNull();
        await expect(pending).resolves.toEqual({ status: "success" });
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(fetch.mock.calls[0][0]).toBe("/api/admin/chatgpt-api/accounts/acct%2F1/test");
        expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ mode: "image", model: "gpt-image-2", prompt: "画苹果" });
    });

    it("preserves an HTTP 200 failed upstream result as a failure", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ code: 0, data: { status: "failed", error_code: "UPSTREAM_ERROR" } }) }));
        await expect(submitChatGptAccountTest({ accountId: "a", mode: "chat", model: "m", prompt: "test", inFlight: { current: false } })).resolves.toMatchObject({ status: "failed", error_code: "UPSTREAM_ERROR" });
    });
});
