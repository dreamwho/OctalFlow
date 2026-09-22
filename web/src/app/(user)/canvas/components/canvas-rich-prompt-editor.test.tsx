import { describe, expect, it } from "vitest";

import { findResourceMentionAtCursor } from "./canvas-resource-mention-textarea";
import { canvasPromptTokenText, parseCanvasPromptDocument, plainOffsetAtPosition, positionAtPlainOffset, serializeCanvasPromptDocument } from "./canvas-rich-prompt-editor";

const image = (label: string) => ({
    id: `id-${label}`,
    nodeId: `node-${label}`,
    kind: "image" as const,
    label,
    title: label,
    active: true,
    previewUrl: "/reference.png",
});

describe("canvas rich prompt editor token document", () => {
    it("recognizes both half-width @ and full-width ＠ at cursor", () => {
        expect(findResourceMentionAtCursor("参考 @", 4)).toEqual({ start: 3, query: "" });
        expect(findResourceMentionAtCursor("参考 ＠", 4)).toEqual({ start: 3, query: "" });
        expect(findResourceMentionAtCursor("第一行\n参考 @图片", 10)).toEqual({ start: 7, query: "图片" });
        expect(findResourceMentionAtCursor("第一行\n参考 ＠图", 9)).toEqual({ start: 7, query: "图" });
        expect(findResourceMentionAtCursor("第一行\n参考 @", 8)).toEqual({ start: 7, query: "" });
    });

    it("accurately computes plain offset across multiline paragraphs", () => {
        const text = "第一行测试\n第二行 @图片1 内容";
        const doc = parseCanvasPromptDocument(text, [image("图片1")], [], [], []);
        expect(serializeCanvasPromptDocument(doc)).toBe(text);
        // Position at start of line 2
        const posLine2 = positionAtPlainOffset(doc, 6);
        expect(plainOffsetAtPosition(doc, posLine2)).toBe(6);
        // Position at '@' in line 2
        const posMention = positionAtPlainOffset(doc, 10);
        expect(plainOffsetAtPosition(doc, posMention)).toBe(10);
    });

    it("keeps Skill tokens out of the public prompt while preserving their inline position", () => {
        const skill = { type: "skill" as const, id: "skill-1", label: "室内设计" };
        const doc = parseCanvasPromptDocument("参考 @图片1 后", [image("图片1")], [], [{ id: skill.id, name: skill.label, description: "测试 Skill" }], [skill.id], [{ token: skill, start: 7, end: 7 }]);
        const content = doc.content[0].content || [];
        expect(content.map((item) => item.type)).toEqual(["text", "referenceToken", "skillToken", "text"]);
        expect(canvasPromptTokenText(skill)).toBe("");
        expect(canvasPromptTokenText({ type: "reference", id: "id-图片1", label: "图片1", title: "图片1", kind: "image" })).toBe("@图片1");
    });

    it("removes a stale Skill atom when selectedSkillIds no longer contains it", () => {
        const skill = { type: "skill" as const, id: "skill-1", label: "室内设计" };
        const doc = parseCanvasPromptDocument("参考 @图片1 后", [image("图片1")], [], [{ id: skill.id, name: skill.label, description: "测试 Skill" }], [], [{ token: skill, start: 7, end: 7 }]);
        expect((doc.content[0].content || []).some((item) => item.type === "skillToken")).toBe(false);
    });

    it("serializes reference and camera atoms through the existing public string protocol", () => {
        const skill = { type: "skill" as const, id: "skill-1", label: "室内设计" };
        const doc = parseCanvasPromptDocument(
            "参考 @图片1 后【镜头下摇　】",
            [image("图片1")],
            [{ token: "【镜头下摇　】", label: "镜头下摇", kind: "camera-motion" }],
            [{ id: skill.id, name: skill.label, description: "测试 Skill" }],
            [skill.id],
            [{ token: skill, start: 7, end: 7 }],
        );
        expect(serializeCanvasPromptDocument(doc)).toBe("参考 @图片1 后【镜头下摇　】");
        expect(serializeCanvasPromptDocument(doc)).not.toContain("skill-1");
    });

    it("restores reference, camera and Skill tokens from a serialized prompt snapshot", () => {
        const skill = { type: "skill" as const, id: "skill-1", label: "电影画幅" };
        const camera = { type: "camera-motion" as const, token: "【镜头下摇　】", label: "镜头下摇" };
        const doc = parseCanvasPromptDocument(
            "人物 @图片1 【镜头下摇　】",
            [image("图片1")],
            [{ token: camera.token, label: camera.label, kind: "camera-motion" }],
            [{ id: skill.id, name: skill.label, description: "测试 Skill" }],
            [skill.id],
            [{ token: skill, start: 19, end: 19 }],
        );
        const content = doc.content[0].content || [];
        expect(content.some((item) => item.type === "referenceToken")).toBe(true);
        expect(content.some((item) => item.type === "cameraMotionToken")).toBe(true);
        expect(content.some((item) => item.type === "skillToken" && (item.attrs as { id: string }).id === skill.id)).toBe(true);
    });

    it("refreshes a persisted Skill token label after the Skill catalog loads", () => {
        const skill = { id: "skill-1", name: "自然美颜精修", description: "测试 Skill" };
        const doc = parseCanvasPromptDocument("生成温馨客厅", [], [], [skill], [skill.id], [{ token: { type: "skill", id: skill.id, label: skill.id }, start: 6, end: 6 }]);
        const token = (doc.content[0].content || []).find((item) => item.type === "skillToken");
        expect(token?.attrs).toMatchObject({ id: skill.id, label: skill.name });
    });

    it("converts legacy node reference markers into the same inline reference atom", () => {
        const reference = image("图片1");
        const doc = parseCanvasPromptDocument(`开始 @[node:${reference.id}] 结束`, [reference], [], [], []);
        const content = doc.content[0].content || [];
        expect(content.map((item) => item.type)).toEqual(["text", "referenceToken", "text"]);
        expect(serializeCanvasPromptDocument(doc)).toBe("开始 @图片1 结束");
    });

    it("correctly identifies subject/character reference nodes via isSubjectReference", async () => {
        const { isSubjectReference } = await import("../utils/canvas-resource-references");
        expect(isSubjectReference({ ...image("图1"), title: "女性人物肖像" })).toBe(true);
        expect(isSubjectReference({ ...image("图2"), title: "游戏角色三视图" })).toBe(true);
        expect(isSubjectReference({ ...image("图3"), title: "产品主体图" })).toBe(true);
        expect(isSubjectReference({ ...image("图4"), title: "自然风景" })).toBe(false);
        expect(isSubjectReference({ ...image("图5"), kind: "video", title: "角色视频" })).toBe(false);
    });
});
