import { describe, expect, it } from "vitest";
import { accountOperationOutcome } from "./account-operation-result";

describe("native account operation response", () => {
    it("accepts synchronous import completion without a progress ID", () => {
        expect(accountOperationOutcome({ added: 10, skipped: 0, errors: [] })).toEqual({ kind: "complete", failed: 0, message: "新增 10 个，更新/跳过 0 个，失败 0 个" });
    });
    it("accepts repeated imports that only update or skip existing accounts", () => {
        expect(accountOperationOutcome({ added: 0, skipped: 10, errors: [] }).kind).toBe("complete");
    });
    it("reports partial failure without exposing raw error details", () => {
        expect(accountOperationOutcome({ added: 9, skipped: 0, errors: [{ access_token: "private" }] })).toEqual({ kind: "complete", failed: 1, message: "新增 9 个，更新/跳过 0 个，失败 1 个" });
    });
    it("keeps asynchronous operations pending", () => {
        expect(accountOperationOutcome({ progress_id: "fixture-id" })).toEqual({ kind: "pending", progressId: "fixture-id" });
    });
    it.each([{}, { added: -1, skipped: 0, errors: [] }, { added: 10, skipped: 0 }])("does not assume unknown responses succeeded", (result) => {
        expect(() => accountOperationOutcome(result)).toThrow("勿重复提交");
    });
});
