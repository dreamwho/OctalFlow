import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CanvasResourceMentionTextarea, deleteReferenceLabelAtCaret, insertTextAtSelection, replacePictureTags } from "./canvas-resource-mention-textarea";

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

    it("inserts a reference label at the caret and returns the new caret position", () => {
        expect(insertTextAtSelection("一只小狗在奔跑", 4, 4, "图片1 ")).toEqual({ value: "一只小狗图片1 在奔跑", caret: 8 });
        expect(insertTextAtSelection("", 0, 0, "图片1 ")).toEqual({ value: "图片1 ", caret: 4 });
    });

    it("replaces the selected range and clamps out-of-bounds positions", () => {
        expect(insertTextAtSelection("abc", 1, 2, "图片1 ")).toEqual({ value: "a图片1 c", caret: 5 });
        expect(insertTextAtSelection("abc", 99, 99, "图片1 ")).toEqual({ value: "abc图片1 ", caret: 7 });
    });

    it("deletes a whole reference label with one backspace at its end", () => {
        expect(deleteReferenceLabelAtCaret("参考 图片1", 6, 6, "Backspace", ["图片1"])).toEqual({ value: "参考 ", cursor: 3 });
        expect(deleteReferenceLabelAtCaret("参考 图片1 奔跑", 6, 6, "Backspace", ["图片1"])).toEqual({ value: "参考 奔跑", cursor: 3 });
        expect(deleteReferenceLabelAtCaret("参考 图片1 ", 7, 7, "Backspace", ["图片1"])).toEqual({ value: "参考 ", cursor: 3 });
    });

    it("deletes the label when the caret or selection is inside it", () => {
        expect(deleteReferenceLabelAtCaret("参考 图片1 奔跑", 4, 4, "Backspace", ["图片1"])).toEqual({ value: "参考  奔跑", cursor: 3 });
        expect(deleteReferenceLabelAtCaret("参考 图片1", 4, 5, "Backspace", ["图片1"])).toEqual({ value: "参考 ", cursor: 3 });
    });

    it("deletes a whole reference label with the delete key at its start", () => {
        expect(deleteReferenceLabelAtCaret("图片1 奔跑", 0, 0, "Delete", ["图片1"])).toEqual({ value: "奔跑", cursor: 0 });
        expect(deleteReferenceLabelAtCaret("图片1 奔跑", 1, 1, "Delete", ["图片1"])).toEqual({ value: " 奔跑", cursor: 0 });
    });

    it("leaves plain text untouched and prefers the longest label", () => {
        expect(deleteReferenceLabelAtCaret("参考 图片 奔跑", 6, 6, "Backspace", ["图片1"])).toBeUndefined();
        expect(deleteReferenceLabelAtCaret("图片10 图片1", 8, 8, "Backspace", ["图片10", "图片1"])).toEqual({ value: "图片10 ", cursor: 5 });
    });

    it("keeps the textarea caret visible under the mention highlight overlay", () => {
        const markup = renderToStaticMarkup(<CanvasResourceMentionTextarea value="参考 图片1 的造型" references={[image("图片1")]} onChange={() => undefined} style={{ background: "#1a1a1a", color: "#ffffff" }} />);
        const overlayStart = markup.indexOf("<div");
        const textareaStart = markup.indexOf("<textarea");
        const overlaySegment = markup.slice(overlayStart, textareaStart);
        // 高亮层不携带背景，避免盖住底层 textarea 绘制的光标
        expect(overlaySegment).toContain("background:transparent");
        expect(overlaySegment).toContain("background-color:transparent");
        expect(overlaySegment).not.toContain("background:#1a1a1a");
        // textarea 保留背景并显式光标颜色
        expect(markup).toContain("background:#1a1a1a");
        expect(markup).toContain("caret-color:#ffffff");
    });
});
