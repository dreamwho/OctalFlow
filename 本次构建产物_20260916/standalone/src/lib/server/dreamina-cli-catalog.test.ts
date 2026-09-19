import { describe, expect, it } from "vitest";

import { DREAMINA_CLI_MODELS, DreaminaCliCatalogError, buildDreaminaCliSubmitArgs, dreaminaCliVideoCapabilities, dreaminaCliRequiresVip, isDreaminaCliOperationOnlyModel, normalizeDreaminaCliVideoParameters } from "./dreamina-cli-catalog";

describe("Dreamina CLI catalog", () => {
    it("keeps every public generation command in the controlled catalog", () => {
        const commands = new Set(DREAMINA_CLI_MODELS.flatMap((model) => model.commands));
        expect(commands).toEqual(new Set(["text2image", "image2image", "image_upscale", "text2video", "image2video", "frames2video", "multiframe2video", "multimodal2video"]));
        expect(isDreaminaCliOperationOnlyModel("dreamina-image-upscale")).toBe(true);
        expect(isDreaminaCliOperationOnlyModel("dreamina-seedream-5-0")).toBe(false);
    });

    it("maps a canonical Seedream model into fixed argv without a shell command", () => {
        expect(buildDreaminaCliSubmitArgs({ command: "text2image", modelId: "dreamina-seedream-5-0", prompt: "一只橘猫", ratio: "1:1", resolutionType: "2k", generateNum: 2 })).toEqual([
            "text2image",
            "--prompt=一只橘猫",
            "--ratio=1:1",
            "--resolution_type=2k",
            "--model_version=5.0",
            "--generate_num=2",
            "--poll=0",
        ]);
        expect(buildDreaminaCliSubmitArgs({ command: "image2image", modelId: "dreamina-seedream-5-0-pro", images: ["/safe/a.png", "/safe/b.png"], prompt: "统一为水彩风格", width: 1536, height: 1536, resolutionType: "4k", generateNum: 3 })).toEqual([
            "image2image",
            "--images=/safe/a.png,/safe/b.png",
            "--prompt=统一为水彩风格",
            "--width=1536",
            "--height=1536",
            "--resolution_type=4k",
            "--model_version=5.0Pro",
            "--generate_num=3",
            "--poll=0",
        ]);
    });

    it("rejects incompatible image model and dimensions before a process can start", () => {
        expect(() => buildDreaminaCliSubmitArgs({ command: "image2image", modelId: "dreamina-seedream-3-0", prompt: "编辑", images: ["/safe/source.png"], resolutionType: "2k" })).toThrow(DreaminaCliCatalogError);
        expect(() => buildDreaminaCliSubmitArgs({ command: "text2image", modelId: "dreamina-seedream-5-0", prompt: "测试", ratio: "1:1", width: 1024, height: 1024, resolutionType: "2k" })).toThrow("自定义宽高不能与比例同时使用");
        expect(() => buildDreaminaCliSubmitArgs({ command: "text2image", modelId: "dreamina-seedream-3-0", prompt: "测试", width: 1024, height: 1024, resolutionType: "1k" })).toThrow("仅支持 2K");
    });

    it("uses the fixed upscale operation and marks 4K/8K as VIP", () => {
        expect(buildDreaminaCliSubmitArgs({ command: "image_upscale", images: ["/safe/source.png"], resolutionType: "4k" })).toEqual(["image_upscale", "--image=/safe/source.png", "--resolution_type=4k", "--poll=0"]);
        expect(dreaminaCliRequiresVip({ command: "image_upscale", resolutionType: "4k" })).toBe(true);
        expect(dreaminaCliRequiresVip({ command: "image_upscale", resolutionType: "2k" })).toBe(false);
        expect(() => buildDreaminaCliSubmitArgs({ command: "image_upscale", images: ["/safe/source.png", "/safe/other.png"], resolutionType: "2k" })).toThrow(DreaminaCliCatalogError);
    });

    it("uses role-specific video arguments and prevents first/last frame reuse", () => {
        expect(
            buildDreaminaCliSubmitArgs({
                command: "frames2video",
                modelId: "dreamina-seedance-2-0-vip",
                first: "/safe/first.png",
                last: "/safe/last.png",
                prompt: "四季交替",
                duration: 5,
                videoResolution: "1080p",
            }),
        ).toEqual(["frames2video", "--first=/safe/first.png", "--last=/safe/last.png", "--prompt=四季交替", "--video_resolution=1080p", "--model_version=seedance2.0_vip", "--duration=5", "--poll=0"]);
        expect(() => buildDreaminaCliSubmitArgs({ command: "frames2video", modelId: "dreamina-seedance-2-0", first: "/safe/same.png", last: "/safe/same.png", prompt: "测试", videoResolution: "720p" })).toThrow("首帧和尾帧不能使用同一素材");
        expect(buildDreaminaCliSubmitArgs({ command: "text2video", modelId: "dreamina-seedance-2-5", prompt: "奔跑的橘猫", duration: 8, ratio: "21:9", videoResolution: "1080p" })).toEqual([
            "text2video",
            "--prompt=奔跑的橘猫",
            "--video_resolution=1080p",
            "--model_version=seedance2.5",
            "--duration=8",
            "--ratio=21:9",
            "--poll=0",
        ]);
        expect(buildDreaminaCliSubmitArgs({ command: "image2video", modelId: "dreamina-seedance-1-0-fast", images: ["/safe/first.png"], prompt: "镜头推进", duration: 5, videoResolution: "720p" })).toEqual([
            "image2video",
            "--image=/safe/first.png",
            "--prompt=镜头推进",
            "--video_resolution=720p",
            "--model_version=seedance1.0fast",
            "--duration=5",
            "--poll=0",
        ]);
    });

    it("normalizes a resolved Seedance model to its executable quality and duration contract", () => {
        expect(dreaminaCliVideoCapabilities("seedance2.0mini")).toEqual({ resolutions: ["720p"], minDurationSeconds: 4, maxDurationSeconds: 15, maxReferenceImages: 9 });
        expect(normalizeDreaminaCliVideoParameters("dreamina-seedance-2-0-mini", { videoResolution: "1080", duration: 60 })).toEqual({ videoResolution: "720p", duration: 15 });
        expect(normalizeDreaminaCliVideoParameters("dreamina-multiframe-video", { videoResolution: "4k", duration: 15 })).toEqual({ videoResolution: "720p", duration: 8 });
        expect(normalizeDreaminaCliVideoParameters("seedance2.0_vip", { videoResolution: "2160", duration: 4 })).toEqual({ videoResolution: "4k", duration: 4 });
        expect(normalizeDreaminaCliVideoParameters("seedance2.5", { videoResolution: "480p", duration: 31 })).toEqual({ videoResolution: "480p", duration: 30 });
    });

    it("keeps duration and reference bounds in the catalog for every selectable Seedance generation family", () => {
        expect(dreaminaCliVideoCapabilities("seedance1.0fast")).toMatchObject({ minDurationSeconds: 5, maxDurationSeconds: 10, maxReferenceImages: 1 });
        expect(dreaminaCliVideoCapabilities("seedance1.5pro")).toMatchObject({ minDurationSeconds: 5, maxDurationSeconds: 12, maxReferenceImages: 1 });
        expect(dreaminaCliVideoCapabilities("seedance2.0")).toMatchObject({ minDurationSeconds: 4, maxDurationSeconds: 15, maxReferenceImages: 9 });
        expect(dreaminaCliVideoCapabilities("seedance2.5")).toMatchObject({ minDurationSeconds: 4, maxDurationSeconds: 30, maxReferenceImages: 30 });
    });

    it("enforces multiframe transition structure and multimodal input limits", () => {
        expect(
            buildDreaminaCliSubmitArgs({
                command: "multiframe2video",
                modelId: "dreamina-multiframe-video",
                images: ["/safe/a.png", "/safe/b.png", "/safe/c.png"],
                videoResolution: "1080p",
                transitionPrompts: ["A 到 B", "B 到 C"],
                transitionDurations: [2, 3],
            }),
        ).toEqual(["multiframe2video", "--images=/safe/a.png,/safe/b.png,/safe/c.png", "--video_resolution=1080p", "--transition-prompt=A 到 B", "--transition-prompt=B 到 C", "--transition-duration=2", "--transition-duration=3", "--poll=0"]);
        expect(() => buildDreaminaCliSubmitArgs({ command: "multimodal2video", modelId: "dreamina-seedance-2-0", videoResolution: "720p" })).toThrow("至少需要一项");
        expect(
            buildDreaminaCliSubmitArgs({
                command: "multimodal2video",
                modelId: "dreamina-seedance-2-5",
                images: ["/safe/image.png"],
                videos: ["/safe/reference.mp4"],
                audios: ["/safe/music.mp3"],
                prompt: "保持主体一致",
                duration: 10,
                ratio: "16:9",
                videoResolution: "1080p",
            }),
        ).toEqual(["multimodal2video", "--image=/safe/image.png", "--video=/safe/reference.mp4", "--audio=/safe/music.mp3", "--prompt=保持主体一致", "--duration=10", "--ratio=16:9", "--video_resolution=1080p", "--model_version=seedance2.5", "--poll=0"]);
    });
});
