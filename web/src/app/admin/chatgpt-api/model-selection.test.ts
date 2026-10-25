import { describe, expect, it } from "vitest";

import { canSyncChatGptModels, removeChatGptModelSelection, unavailableChatGptModels } from "./model-selection";

describe("GPTAPI catalog selections", () => {
    const catalog = { chat_models: ["chat-a"], image_models: ["image-a"], source: { chat: "upstream", image: "upstream" } };

    it("keeps saved IDs absent from the refreshed catalog visible as unavailable", () => {
        expect(unavailableChatGptModels(["chat-a", "legacy-model", "old-image"], catalog)).toEqual(["legacy-model", "old-image"]);
    });

    it("does not mutate selections while explicitly removing one unavailable ID", () => {
        const selected = ["chat-a", "legacy-model"];
        expect(removeChatGptModelSelection(selected, "legacy-model")).toEqual(["chat-a"]);
        expect(selected).toEqual(["chat-a", "legacy-model"]);
    });

    it("blocks syncing until missing IDs are removed but allows an intentional empty selection", () => {
        expect(canSyncChatGptModels(true, ["legacy-model"])).toBe(false);
        expect(canSyncChatGptModels(false, [])).toBe(false);
        expect(canSyncChatGptModels(true, [])).toBe(true);
    });
});
