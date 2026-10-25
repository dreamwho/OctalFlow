import { generationLogPublicPrompt } from "@/lib/generation-log-snapshot";
import type { GenerationLogRequestSnapshot, GenerationLogSlotSnapshot } from "@/lib/generation-log-snapshot";

type WorkbenchDraftLog = Parameters<typeof generationLogPublicPrompt>[0] & {
    kind: "image" | "video";
    model: string;
    requestSnapshot?: Pick<GenerationLogRequestSnapshot, "parameters" | "references" | "interiorDesign">;
};

export function restoreWorkbenchDraft(log: WorkbenchDraftLog, slot: GenerationLogSlotSnapshot) {
    const parameters = slot.parameters || log.requestSnapshot?.parameters;
    const referenceIds = new Set(slot.referenceIds || []);
    return {
        prompt: generationLogPublicPrompt(log),
        model: slot.taskModel || log.model,
        kind: log.kind,
        references: (log.requestSnapshot?.references || []).filter((reference) => !referenceIds.size || referenceIds.has(reference.id)),
        size: parameters?.size || log.requestSnapshot?.parameters.size,
        quality: parameters?.quality || log.requestSnapshot?.parameters.quality,
        seconds: parameters?.seconds || log.requestSnapshot?.parameters.seconds,
        count: log.requestSnapshot?.parameters.count,
        generateAudio: log.requestSnapshot?.parameters.generateAudio,
        watermark: log.requestSnapshot?.parameters.watermark,
        runningHubAppId: parameters?.runningHubAppId || log.requestSnapshot?.parameters.runningHubAppId,
        taskKind: slot.taskKind,
        interiorDesign: log.requestSnapshot?.interiorDesign,
    };
}
