import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Canvas media preview", () => {
    it("offers an original-file download for image and video previews", () => {
        const source = readFileSync(new URL("../[id]/canvas-client-page.tsx", import.meta.url), "utf8");

        expect(source).toContain('previewNode.type === CanvasNodeType.Video ? "视频详情" : "图片详情"');
        expect(source).toContain('aria-label={previewNode.type === CanvasNodeType.Video ? "下载视频" : "下载图片"}');
        expect(source).toContain("onClick={() => downloadNodeImage(previewNode)}");
        expect(source).toContain('aria-label="截取当前帧"');
        expect(source).toContain("capturePreviewVideoFrame");
        expect(source).toContain("<video ref={previewVideoRef} src={previewNode.metadata.content} controls autoPlay");
        expect(source).toContain("<CanvasImageComparison sourceUrl={previewUpscaleSourceNode.metadata.content}");
    });

    it("routes image, panorama and video double clicks into the media preview", () => {
        const source = readFileSync(new URL("./canvas-node.tsx", import.meta.url), "utf8");

        expect(source).toContain("(isCanvasImageNodeType(data.type) && hasImageContent) || (data.type === CanvasNodeType.Video && hasVideoContent)");
        expect(source).toContain('target?.closest("button,input,textarea,select,audio,[data-canvas-no-drag]")');
    });
});
