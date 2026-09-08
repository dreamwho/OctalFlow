import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CanvasResourceMentionTextarea, deleteReferenceLabelAtCaret, findResourceMentionAtCursor, insertTextAtSelection, referenceMentionLabel, replacePictureTags, resolveMentionMenuPosition } from "./canvas-resource-mention-textarea";

const image = (label: string): Parameters<typeof replacePictureTags>[1][number] => ({ id: `id-${label}`, nodeId: `node-${label}`, kind: "image", label, title: label, active: true, previewUrl: "/reference.png" });

describe("canvas resource mention textarea", () => {
    it("replaces <Picture N> tags with the matching active image label", () => {
        const value = "<Subject 1> 是 <Picture 1> 中的主播，造型以 <Picture 1> 为准，参考 <Picture 2> 的场景。";

        expect(replacePictureTags(value, [image("图片1"), image("图片2")])).toBe("<Subject 1> 是 @图片1 中的主播，造型以 @图片1 为准，参考 @图片2 的场景。");
    });

    it("keeps tags without a matching image reference unchanged", () => {
        expect(replacePictureTags("参考 <Picture 3> 与 <Picture 1>", [image("图片1")])).toBe("参考 <Picture 3> 与 @图片1");
    });

    it("ignores inactive image references", () => {
        expect(replacePictureTags("参考 <Picture 1>", [{ ...image("图片1"), active: false }])).toBe("参考 <Picture 1>");
    });

    it("inserts a reference label at the caret and returns the new caret position", () => {
        expect(insertTextAtSelection("一只小狗在奔跑", 4, 4, "图片1 ")).toEqual({ value: "一只小狗图片1 在奔跑", caret: 8 });
        expect(insertTextAtSelection("", 0, 0, "图片1 ")).toEqual({ value: "图片1 ", caret: 4 });
    });

    it("recognizes @ mentions next to Chinese text and keeps the canonical marker", () => {
        expect(findResourceMentionAtCursor("保持人物@图", 6)).toEqual({ start: 4, query: "图" });
        expect(referenceMentionLabel("图片1")).toBe("@图片1");
        expect(referenceMentionLabel("@图片1")).toBe("@图片1");
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

    it("deletes the whole label only for a collapsed caret and leaves range deletion to the browser", () => {
        expect(deleteReferenceLabelAtCaret("参考 图片1 奔跑", 4, 4, "Backspace", ["图片1"])).toEqual({ value: "参考  奔跑", cursor: 3 });
        expect(deleteReferenceLabelAtCaret("参考 图片1", 4, 5, "Backspace", ["图片1"])).toBeUndefined();
    });

    it("deletes a whole reference label with the delete key at its start", () => {
        expect(deleteReferenceLabelAtCaret("图片1 奔跑", 0, 0, "Delete", ["图片1"])).toEqual({ value: "奔跑", cursor: 0 });
        expect(deleteReferenceLabelAtCaret("图片1 奔跑", 1, 1, "Delete", ["图片1"])).toEqual({ value: " 奔跑", cursor: 0 });
    });

    it("deletes a whole inline camera-motion token in one action", () => {
        expect(deleteReferenceLabelAtCaret("人物【镜头下摇　】随后转身", 9, 9, "Backspace", ["【镜头下摇　】"])).toEqual({ value: "人物随后转身", cursor: 2 });
    });

    it("leaves plain text untouched and prefers the longest label", () => {
        expect(deleteReferenceLabelAtCaret("参考 图片 奔跑", 6, 6, "Backspace", ["图片1"])).toBeUndefined();
        expect(deleteReferenceLabelAtCaret("图片10 图片1", 8, 8, "Backspace", ["图片10", "图片1"])).toEqual({ value: "图片10 ", cursor: 5 });
    });

    it("keeps reference highlights visible above the editor surface without covering the caret", () => {
        const markup = renderToStaticMarkup(<CanvasResourceMentionTextarea value="参考 @图片1 的造型" references={[image("图片1")]} onChange={() => undefined} className="px-3 py-2 text-sm leading-6" style={{ background: "#1a1a1a", color: "#ffffff" }} />);
        const overlayStart = markup.indexOf("<div");
        const textareaStart = markup.indexOf("<textarea");
        const overlaySegment = markup.slice(overlayStart, textareaStart);
        const textareaSegment = markup.slice(textareaStart);
        // 背景由外层承载，高亮层与输入层都保持透明，引用文字与光标可以同时显示。
        expect(markup).toContain('style="background:#1a1a1a"');
        expect(overlaySegment).toContain("background:transparent");
        expect(overlaySegment).toContain("background-color:transparent");
        expect(textareaSegment).toContain("background:transparent");
        expect(textareaSegment).toContain("background-color:transparent");
        expect(textareaSegment).toContain("caret-color:#ffffff");
        expect(markup.match(/px-3 py-2 text-sm leading-6/g)).toHaveLength(2);
        expect(markup).toContain("data-canvas-inline-reference");
        expect(markup).toContain("@图片1");
        expect(markup).not.toContain("invisible");
        expect(markup).not.toContain("min-width");
        expect(markup).not.toContain("inline-block");
    });

    it("anchors a measured mention menu immediately above the caret", () => {
        expect(
            resolveMentionMenuPosition({
                anchor: { left: 220, top: 480, right: 220, bottom: 504 },
                boundary: { left: 0, top: 0, right: 900, bottom: 700 },
                menuWidth: 288,
                menuHeight: 88,
            }),
        ).toEqual({ left: 220, top: 386 });
    });

    it("falls below the caret and stays inside the viewport when there is no room above", () => {
        expect(
            resolveMentionMenuPosition({
                anchor: { left: 780, top: 20, right: 780, bottom: 44 },
                boundary: { left: 0, top: 0, right: 900, bottom: 700 },
                menuWidth: 288,
                menuHeight: 88,
            }),
        ).toEqual({ left: 604, top: 50 });
    });

    it("renders ordinary prompt text directly when no active reference label appears in the value", () => {
        const markup = renderToStaticMarkup(<CanvasResourceMentionTextarea value="镜头缓慢推进" references={[image("图片1")]} onChange={() => undefined} style={{ background: "#1a1a1a", color: "#ffffff" }} />);

        expect(markup).not.toContain('aria-hidden="true"');
        expect(markup).toContain("background:#1a1a1a");
        expect(markup).toContain("color:#ffffff");
    });

    it("renders an inline camera-motion token as a named violet label without its execution prompt", () => {
        const markup = renderToStaticMarkup(
            <CanvasResourceMentionTextarea
                value="人物【镜头下摇　】随后转身"
                references={[]}
                inlineTokens={[{ token: "【镜头下摇　】", label: "镜头下摇", kind: "camera-motion" }]}
                onChange={() => undefined}
                style={{ background: "#1a1a1a", color: "#ffffff" }}
            />,
        );

        expect(markup).toContain("data-canvas-inline-camera-motion");
        expect(markup).toContain("镜头下摇");
        expect(markup).not.toContain("从空间全貌落到主体动作细节");
    });
});
