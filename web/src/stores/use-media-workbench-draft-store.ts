import { create } from "zustand";

export type MediaWorkbenchDraft = {
    prompt: string;
    mode: "image" | "video";
    modelId?: string;
    aspectRatio?: string;
    duration?: string;
    referenceFile?: File;
    autoSubmit?: boolean;
};

type MediaWorkbenchDraftStore = {
    draft: MediaWorkbenchDraft | null;
    setDraft: (draft: MediaWorkbenchDraft) => void;
    takeDraft: () => MediaWorkbenchDraft | null;
};

export const useMediaWorkbenchDraftStore = create<MediaWorkbenchDraftStore>((set, get) => ({
    draft: null,
    setDraft: (draft) => set({ draft }),
    takeDraft: () => {
        const draft = get().draft;
        set({ draft: null });
        return draft;
    },
}));
