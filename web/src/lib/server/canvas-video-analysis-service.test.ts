import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
    class OperationError extends Error {
        constructor(message: string, readonly status = 400) {
            super(message);
        }
    }
    return {
        OperationError,
        settings: vi.fn(),
        refund: vi.fn(),
        mkdtemp: vi.fn(),
        readFile: vi.fn(),
        rm: vi.fn(),
        runFfmpeg: vi.fn(),
        resolveCandidates: vi.fn(),
        authorize: vi.fn(),
        materialize: vi.fn(),
        probe: vi.fn(),
        preferredProtocol: vi.fn(),
        rank: vi.fn(),
        request: vi.fn(),
    };
});

vi.mock("node:fs/promises", () => ({ mkdtemp: mocks.mkdtemp, readFile: mocks.readFile, rm: mocks.rm }));
vi.mock("@/lib/auth/store", () => ({ getAuthSettings: mocks.settings, refundUserPoints: mocks.refund }));
vi.mock("@/lib/server/ffmpeg", () => ({ runFfmpeg: mocks.runFfmpeg }));
vi.mock("@/lib/server/logical-model-router", () => ({ resolveLogicalModelCandidates: mocks.resolveCandidates }));
vi.mock("@/lib/server/canvas-video-source-service", () => ({
    CanvasVideoOperationError: mocks.OperationError,
    authorizeCanvasVideoSource: mocks.authorize,
    materializeCanvasVideoSource: mocks.materialize,
    probeCanvasVideoSource: mocks.probe,
}));
vi.mock("@/lib/server/text-planning-runtime", () => ({
    preferredTextPlanningProtocol: mocks.preferredProtocol,
    rankTextPlanningCandidates: mocks.rank,
    requestStructuredText: mocks.request,
}));

import { analyzeCanvasVideo } from "./canvas-video-analysis-service";

const structuredAnalysis = {
    structure: { summary: "主角从入口进入空间并抵达前景", rhythm: "由静到动的单段推进", audioEvidence: "轻快音乐和脚步声" },
    overall: {
        style: "低饱和电影纪实风格",
        subjects: "短发女性主角穿深色外套，手持白色手提包",
        environment: "玻璃门入口与暖色走廊相连",
        cameraLanguage: "稳定的中景跟拍，沿人物行进方向推进",
        lighting: "入口冷色环境光与走廊暖光形成对比",
        audio: "轻快音乐和脚步声",
        stableAnchors: ["短发女性、深色外套、白色手提包", "人物始终由左向右进入走廊"],
        negativeConstraints: ["不得改变人物身份、服装或手提包", "不得反转人物行进方向或添加水印"],
    },
    scenes: [
        {
            startMs: 0,
            endMs: 3000,
            label: "入口进入",
            setting: "玻璃门前的入口过渡到暖色走廊",
            stableAnchors: ["玻璃门在人物身后", "白色手提包位于右手"],
            camera: "中景平视，缓慢向右跟拍",
            lighting: "前段冷色，后段逐步叠加暖光",
            action: "主角推门后向右侧走廊前进",
            audio: "轻快音乐和脚步声",
            negativeConstraints: ["不得跳变至其他场景", "不得改变手提包位置"],
        },
    ],
    shots: [
        {
            startMs: 0,
            endMs: 3000,
            sceneLabel: "入口进入",
            framing: "中景，人物位于画面左三分之一并保留右侧行进空间",
            camera: "平视稳定跟拍，轻微向右推进",
            lighting: "玻璃门冷光过渡到走廊暖光",
            action: "主角推门并连续向右行走",
            audio: "轻快音乐和脚步声",
            stableAnchors: ["短发女性深色外套", "白色手提包右手持握"],
            generationPrompt: "保持同一短发女性、深色外套和白色手提包，从玻璃门进入暖色走廊，中景平视稳定跟拍。",
            negativeConstraints: ["不得变形、换脸、换装或改变行进轴线", "不得添加字幕和水印"],
        },
    ],
};

describe("Canvas video analysis", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.settings.mockResolvedValue({ generationDefaults: { videoAnalysisModel: "selected-video-analysis" }, defaultModels: { textModel: "fallback-text" } });
        mocks.mkdtemp.mockResolvedValue("/tmp/canvas-analysis");
        mocks.readFile.mockResolvedValue(Buffer.from("evidence"));
        mocks.rm.mockResolvedValue(undefined);
        mocks.runFfmpeg.mockResolvedValue({ stdout: "", stderr: "" });
        mocks.authorize.mockResolvedValue({ storageKey: "permanent/2026/09/08/videos/generated.mp4", registration: { scope: "generation", mimeType: "video/mp4" } });
        mocks.materialize.mockResolvedValue("/data/generation-assets/permanent/2026/09/08/videos/generated.mp4");
        mocks.probe.mockResolvedValue({ durationMs: 4000, width: 854, height: 480, audio: { present: true, codec: "aac", channels: 2, sampleRate: 48000 } });
        const candidate = {
            logicalModelId: "selected-video-analysis",
            channelId: "channel-one",
            upstreamModel: "analysis-upstream",
            channel: { id: "channel-one", apiFormat: "gemini" },
            capabilityProfile: { supportsReferenceVideo: true, supportsReferenceImage: true, supportsReferenceAudio: false },
        };
        mocks.resolveCandidates.mockReturnValue([candidate]);
        mocks.rank.mockImplementation((items: unknown[]) => items);
        mocks.preferredProtocol.mockReturnValue("gemini");
    });

    it("uses generationDefaults.videoAnalysisModel, retries native-video through sampled frames, and never invents unsupported audio", async () => {
        mocks.request.mockRejectedValueOnce(new Error("native video upload failed")).mockResolvedValueOnce({ arguments: JSON.stringify(structuredAnalysis), headers: new Headers({ "x-octalaicanvas-points-remaining": "87" }) });

        const result = await analyzeCanvasVideo({ ownerUserId: "owner-one", storageKey: "permanent/2026/09/08/videos/generated.mp4", requestId: "request-one", origin: "http://localhost", cookie: "session=test" });

        expect(mocks.resolveCandidates).toHaveBeenCalledWith(expect.anything(), "text", "selected-video-analysis");
        expect(mocks.request).toHaveBeenCalledTimes(2);
        const nativeMessage = mocks.request.mock.calls[0]?.[0].messages[1].content;
        const fallbackMessage = mocks.request.mock.calls[1]?.[0].messages[1].content;
        expect(nativeMessage).toEqual(expect.arrayContaining([expect.objectContaining({ type: "video_url" })]));
        expect(fallbackMessage).toEqual(expect.arrayContaining([expect.objectContaining({ type: "image_url" })]));
        expect(fallbackMessage).not.toEqual(expect.arrayContaining([expect.objectContaining({ type: "audio_url" })]));
        expect(mocks.request.mock.calls[1]?.[0].messages[0].content).toContain("未传入可听音频证据");
        expect(mocks.runFfmpeg).toHaveBeenCalledTimes(5);
        expect(result).toMatchObject({ model: "selected-video-analysis", pointsRemaining: 87 });
        expect(result.analysisText.match(/【[一二三四]、[^】]+】/g)).toEqual(["【一、视频结构摘要】", "【二、全片设定】", "【三、分场设定】", "【四、分镜生成稿】"]);
        expect(result.analysisText).toContain("【角色固定锚点】");
        expect(result.analysisText).toContain("【场景固定锚点】");
        expect(result.analysisText).toContain("【视觉风格锚点】");
        expect(result.analysisText).toContain("【声音锚点】");
        expect(result.analysisText).toContain("【场景01：入口进入｜00:00.0—00:03.0｜总时长3.0秒】");
        expect(result.analysisText).toContain("【镜头01｜00:00.0—00:03.0｜3.0秒】");
        expect(result.analysisText).toContain("音频未传递，无法判断");
        expect(result.analysisText).not.toContain("轻快音乐和脚步声");
        expect(result.analysisText).not.toContain("模型选择");
    });

    it("falls back to the default text logical model only when the video-analysis setting is empty", async () => {
        mocks.settings.mockResolvedValue({ generationDefaults: { videoAnalysisModel: "" }, defaultModels: { textModel: "fallback-text" } });
        mocks.resolveCandidates.mockReturnValue([
            {
                logicalModelId: "fallback-text",
                channelId: "channel-one",
                upstreamModel: "analysis-upstream",
                channel: { id: "channel-one", apiFormat: "gemini" },
                capabilityProfile: { supportsReferenceImage: true, supportsReferenceAudio: false },
            },
        ]);
        mocks.request.mockResolvedValue({ arguments: JSON.stringify(structuredAnalysis), headers: new Headers() });

        await analyzeCanvasVideo({ ownerUserId: "owner-one", storageKey: "permanent/source.mp4", requestId: "request-two", origin: "http://localhost", cookie: "" });

        expect(mocks.resolveCandidates).toHaveBeenCalledWith(expect.anything(), "text", "fallback-text");
    });
});
