import { describe, expect, it } from "vitest";

import { isCanvasAgentAttachmentFile, isCanvasAgentTextFile } from "./canvas-agent-attachment-files";

describe("Canvas Agent attachment files", () => {
    it.each([
        new File(["# 剧本"], "script.md", { type: "text/markdown" }),
        new File(["台词"], "dialogue.txt", { type: "text/plain" }),
        new File(["# 分镜"], "storyboard.markdown"),
    ])("accepts text script attachment $name", (file) => {
        expect(isCanvasAgentTextFile(file)).toBe(true);
        expect(isCanvasAgentAttachmentFile(file)).toBe(true);
    });

    it("keeps unsupported binary documents out of the Agent composer", () => {
        expect(isCanvasAgentAttachmentFile(new File(["pdf"], "script.pdf", { type: "application/pdf" }))).toBe(false);
    });
});
