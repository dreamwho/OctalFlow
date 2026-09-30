import type { CanvasPromptTokenSnapshot } from "@/app/(user)/canvas/components/canvas-rich-prompt-editor";
import type { CanvasResourceReference } from "@/app/(user)/canvas/utils/canvas-resource-references";

export function reconcileWorkbenchReferenceTokens(value: string, tokens: readonly CanvasPromptTokenSnapshot[], references: readonly CanvasResourceReference[]) {
    const byId = new Map(references.map((reference) => [reference.id, reference]));
    const nextTokens: CanvasPromptTokenSnapshot[] = [];
    let nextValue = "";
    let cursor = 0;
    for (const entry of [...tokens].sort((left, right) => left.start - right.start)) {
        if (entry.token.type !== "reference" || entry.start < cursor || value.slice(entry.start, entry.end) !== `@${entry.token.label}`) continue;
        nextValue += value.slice(cursor, entry.start);
        const reference = byId.get(entry.token.id);
        if (reference) {
            const start = nextValue.length;
            nextValue += `@${reference.label}`;
            nextTokens.push({ token: { ...entry.token, label: reference.label, title: reference.title, previewUrl: reference.previewUrl }, start, end: nextValue.length });
        }
        cursor = entry.end;
    }
    return { value: nextValue + value.slice(cursor), tokens: nextTokens };
}
