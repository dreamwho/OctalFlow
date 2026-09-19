export type GenerationTaskExecutionState = {
    needsReview?: boolean;
    executionPhase?: string;
    reviewReason?: string;
    verificationId?: string;
};

export const GENERATION_TASK_NEEDS_REVIEW_MESSAGE = "上游创建状态待确认，系统已停止重复创建，请联系管理员处理";

export class GenerationTaskNeedsReviewError extends Error {
    readonly verificationId?: string;
    readonly taskId?: string;

    constructor(reason?: string, verificationId?: string, taskId?: string) {
        super(reason?.trim() || GENERATION_TASK_NEEDS_REVIEW_MESSAGE);
        this.name = "GenerationTaskNeedsReviewError";
        this.verificationId = verificationId;
        this.taskId = taskId;
    }
}

export function isGenerationTaskNeedsReviewError(error: unknown) {
    return error instanceof GenerationTaskNeedsReviewError || (error instanceof Error && error.message === GENERATION_TASK_NEEDS_REVIEW_MESSAGE);
}
