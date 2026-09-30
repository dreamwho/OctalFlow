import { describe, expect, it } from "vitest";
import { reconcileWorkbenchReferenceTokens } from "./image-video-workbench-prompt";

describe("reconcileWorkbenchReferenceTokens", () => {
    it("removes a deleted image token and renumbers the remaining image", () => {
        const value = "参考 @图片1 和 @图片2 生成";
        const tokens = [
            { token: { type: "reference" as const, id: "first", label: "图片1", title: "第一张", kind: "image" as const }, start: 3, end: 7 },
            { token: { type: "reference" as const, id: "second", label: "图片2", title: "第二张", kind: "image" as const }, start: 10, end: 14 },
        ];
        const result = reconcileWorkbenchReferenceTokens(value, tokens, [{ id: "second", nodeId: "second", label: "图片1", title: "第二张", kind: "image", active: true }]);
        expect(result.value).toBe("参考  和 @图片1 生成");
        expect(result.tokens).toEqual([{ token: { ...tokens[1].token, label: "图片1", previewUrl: undefined }, start: 6, end: 10 }]);
    });
});
