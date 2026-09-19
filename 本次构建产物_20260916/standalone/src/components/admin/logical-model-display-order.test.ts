import { describe, expect, it } from "vitest";

import type { LogicalModel } from "@/lib/auth/store";
import { moveLogicalModel, reorderLogicalModels, setLogicalModelPickerVisibility } from "./logical-model-display-order";

const models = [model("image-a", "image"), model("text-a", "text"), model("image-b", "image"), model("video-a", "video"), model("image-c", "image")];

describe("logical model display order", () => {
    it("reorders one node capability without moving other capability slots", () => {
        expect(reorderLogicalModels(models, "image", "image-c", "image-a").map((item) => item.id)).toEqual(["image-c", "text-a", "image-a", "video-a", "image-b"]);
    });

    it("supports keyboard-accessible single-step ordering", () => {
        expect(moveLogicalModel(models, "image", "image-b", -1).map((item) => item.id)).toEqual(["image-b", "text-a", "image-a", "video-a", "image-c"]);
        expect(moveLogicalModel(models, "image", "image-a", -1)).toBe(models);
    });

    it("hides a model from node pickers without disabling its route", () => {
        const result = setLogicalModelPickerVisibility(models, "image-b", false);
        expect(result.find((item) => item.id === "image-b")).toMatchObject({ enabled: true, pickerVisible: false });
    });
});

function model(id: string, capability: LogicalModel["capability"]): LogicalModel {
    return { id, name: id, capability, enabled: true, bindings: [{ id: `${id}-binding`, channelId: "channel", upstreamModel: id, enabled: true, priority: 1 }] };
}
