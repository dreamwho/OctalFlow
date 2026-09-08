export type AccountOperationResult = {
    progress_id?: string;
    added?: number;
    skipped?: number;
    errors?: unknown[];
};

export function accountOperationOutcome(result: AccountOperationResult) {
    if (typeof result.progress_id === "string" && result.progress_id.trim()) return { kind: "pending" as const, progressId: result.progress_id };
    // Native POST /api/accounts returns a completed mutation, not a progress ID.
    if (Number.isInteger(result.added) && result.added! >= 0 && Number.isInteger(result.skipped) && result.skipped! >= 0 && Array.isArray(result.errors)) {
        return { kind: "complete" as const, failed: result.errors.length, message: `新增 ${result.added} 个，更新/跳过 ${result.skipped} 个，失败 ${result.errors.length} 个` };
    }
    throw new Error("无法确认账号操作结果，请先刷新账号列表核对，勿重复提交");
}
