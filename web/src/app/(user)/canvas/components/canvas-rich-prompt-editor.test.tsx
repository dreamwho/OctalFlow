import { describe, expect, it } from "vitest";

import { canvasPromptTokenText, parseCanvasPromptDocument, serializeCanvasPromptDocument } from "./canvas-rich-prompt-editor";

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
});
