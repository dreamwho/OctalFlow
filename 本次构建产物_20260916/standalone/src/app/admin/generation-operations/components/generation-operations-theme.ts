export const generationOperationThemeClasses = {
    neutralTag: "admin-generation-neutral-tag m-0",
    reviewTag: "admin-generation-review-tag m-0",
    reviewPanel: "admin-generation-review-panel rounded-lg px-3 py-2.5 text-sm",
    selectedAction: "admin-generation-selected-action",
    idleAction: "admin-generation-idle-action",
    textarea: "admin-generation-textarea",
    primaryButton: "admin-generation-primary-button",
    secondaryButton: "admin-generation-secondary-button",
} as const;

const statusClasses: Record<string, string> = {
    running: "admin-generation-status-tag admin-generation-status-running m-0",
    error: "admin-generation-status-tag admin-generation-status-error m-0",
    success: "admin-generation-status-tag admin-generation-status-success m-0",
};

export function generationOperationStatusTagClass(status: string) {
    return statusClasses[status] || generationOperationThemeClasses.neutralTag;
}
