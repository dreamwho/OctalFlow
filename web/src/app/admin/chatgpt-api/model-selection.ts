import type { ChatGptModelCatalog } from "@/services/api/chatgpt-api";

export function unavailableChatGptModels(selected: string[], catalog: ChatGptModelCatalog | null) {
    if (!catalog) return [];
    const available = new Set([...catalog.chat_models, ...catalog.image_models]);
    return selected.filter((model) => !available.has(model));
}

export function removeChatGptModelSelection(selected: string[], model: string) {
    return selected.filter((item) => item !== model);
}

export function canSyncChatGptModels(selectionChanged: boolean, unavailableModels: string[]) {
    return selectionChanged && unavailableModels.length === 0;
}
