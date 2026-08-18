import { describe, expect, it } from "vitest";

import { replacePictureTags } from "./canvas-resource-mention-textarea";

const image = (label: string): Parameters<typeof replacePictureTags>[1][number] => ({ id: `id-${label}`, nodeId: `node-${label}`, kind: "image", label, title: label, active: true });

describe("canvas resource mention textarea", () => {
    it("replaces <Picture N> tags with the matching active image label", () => {
        const value = "<Subject 1> 是 <Picture 1> 中的主播，造型以 <Picture 1> 为准，参考 <Picture 2> 的场景。";

        expect(replacePictureTags(value, [image("图片1"), image("图片2")])).toBe("<Subject 1> 是 图片1 中的主播，造型以 图片1 为准，参考 图片2 的场景。");
    });

    it("keeps tags without a matching image reference unchanged", () => {
        expect(replacePictureTags("参考 <Picture 3> 与 <Picture 1>", [image("图片1")])).toBe("参考 <Picture 3> 与 图片1");
    });

    it("ignores inactive image references", () => {
        expect(replacePictureTags("参考 <Picture 1>", [{ ...image("图片1"), active: false }])).toBe("参考 <Picture 1>");
    });
});
