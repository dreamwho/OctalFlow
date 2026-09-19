import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { canvasThemes } from "@/lib/canvas-theme";
import { AgentChatComposer, AgentChatMessage, AgentWorkingMessage, insertCanvasAgentSkillToken, stripCanvasAgentSkillTokens } from "./canvas-agent-chat-ui";
import { CanvasAgentMentionPicker } from "./canvas-agent-mention-picker";

const baseProps = {
    prompt: "换成紫毛",
    placeholder: "描述需求",
    theme: canvasThemes.light,
    onPromptChange: vi.fn(),
    onSubmit: vi.fn(),
};

describe("Canvas Agent media attachments", () => {
    it("inserts a Skill token at the active caret and strips it before submission", () => {
        const inserted = insertCanvasAgentSkillToken("先处理", 3, { id: "skill-font", name: "创意字体动画工坊" });

        expect(inserted.value).toContain("[[skill:skill-font]]");
        expect(inserted.cursor).toBeGreaterThan(3);
        expect(stripCanvasAgentSkillTokens(inserted.value)).toBe("先处理");
    });

    it("exposes the expand action in the composer shell", () => {
        const markup = renderToStaticMarkup(<AgentChatComposer {...baseProps} onAddFiles={vi.fn()} expanded={false} onExpandedChange={vi.fn()} />);

        expect(markup).toContain('aria-label="放大输入面板"');
        expect(markup).toContain("position:absolute;top:12px;right:12px");
    });

    it("keeps an inline Skill chip fitted to its visible label instead of its internal token", () => {
        const markup = renderToStaticMarkup(<AgentChatComposer {...baseProps} prompt="请 [[skill:skill-font]] 帮我设计" skills={[{ id: "skill-font", name: "创意字体动画工坊" }]} />);

        expect(markup).toContain("data-canvas-agent-inline-skill");
        expect(markup).toContain("w-max");
        expect(markup).toContain("创意字体动画工坊");
        expect(markup).not.toContain("absolute inset-0 inline-flex");
    });

    it("uses a bounded expanded editor height rather than a full-screen composer", () => {
        const markup = renderToStaticMarkup(<AgentChatComposer {...baseProps} expanded onExpandedChange={vi.fn()} />);

        expect(markup).toContain("height:min(368px, calc(100dvh - 4rem))");
        expect(markup).toContain("h-full min-h-0 max-h-none");
    });

    it("renders the upload slot inside the input row instead of the bottom toolbar", () => {
        const markup = renderToStaticMarkup(<AgentChatComposer {...baseProps} onAddFiles={vi.fn()} />);

        expect(markup).toContain("data-canvas-agent-input-row");
        expect(markup).toContain('aria-label="上传本地素材"');
        expect(markup.indexOf('aria-label="上传本地素材"')).toBeLessThan(markup.indexOf("data-canvas-agent-toolbar"));
        expect(markup.slice(markup.indexOf("data-canvas-agent-toolbar"))).not.toContain('aria-label="上传本地素材"');
    });

    it("allows a selected Skill or reference context to submit without manually entering a prompt", () => {
        const markup = renderToStaticMarkup(<AgentChatComposer {...baseProps} prompt="" canSubmitWithContext />);
        const sendButton = markup.match(/<button[^>]*aria-label="发送"[^>]*>/)?.[0] || "";

        expect(sendButton).not.toContain('disabled=""');
    });

    it("renders compact reference context beneath the selected media strip", () => {
        const markup = renderToStaticMarkup(<AgentChatComposer {...baseProps} attachments={[{ id: "reference", name: "reference.png", url: "blob:reference", status: "ready" }]} beforeInput={<div data-reference-context>图片1 · 脚本成片</div>} />);

        expect(markup.indexOf('aria-label="本轮参考素材"')).toBeLessThan(markup.indexOf("data-reference-context"));
        expect(markup.indexOf("data-reference-context")).toBeLessThan(markup.indexOf("<textarea"));
    });

    it("shows an immediate upload preview and blocks submission until it is ready", () => {
        const markup = renderToStaticMarkup(<AgentChatComposer {...baseProps} attachments={[{ id: "upload", name: "clipboard-image.png", url: "blob:preview", status: "uploading" }]} onAddFiles={vi.fn()} onRemoveAttachment={vi.fn()} />);

        expect(markup).toContain('aria-label="clipboard-image.png 上传中"');
        expect(markup).toContain('aria-label="正在上传参考素材"');
        expect(markup.indexOf('aria-label="clipboard-image.png 上传中"')).toBeLessThan(markup.indexOf("<textarea"));
        expect(markup).toMatch(/aria-label="发送"[^>]*disabled=""/);
    });

    it("keeps a failed preview in place with retry and remove actions", () => {
        const markup = renderToStaticMarkup(
            <AgentChatComposer {...baseProps} attachments={[{ id: "failed", name: "reference.png", url: "blob:failed", status: "failed", error: "上传失败" }]} onAddFiles={vi.fn()} onRetryAttachment={vi.fn()} onRemoveAttachment={vi.fn()} />,
        );

        expect(markup).toContain('aria-label="重试上传参考素材：reference.png"');
        expect(markup).toContain('aria-label="移除参考素材：reference.png"');
        expect(markup).toContain('title="上传失败"');
        expect(markup).toMatch(/aria-label="发送"[^>]*disabled=""/);
    });

    it("renders an uploaded video as a playable media thumbnail", () => {
        const markup = renderToStaticMarkup(<AgentChatComposer {...baseProps} attachments={[{ id: "video", name: "reference.mp4", url: "blob:video", type: "video", status: "ready" }]} onAddFiles={vi.fn()} />);

        expect(markup).toContain('accept="image/*,video/*,text/plain,text/markdown,.md,.markdown,.txt"');
        expect(markup).toContain("<video");
        expect(markup).toContain('aria-label="reference.mp4"');
    });

    it("accepts and renders a Markdown script attachment", () => {
        const markup = renderToStaticMarkup(<AgentChatComposer {...baseProps} attachments={[{ id: "script", name: "分镜脚本.md", type: "text", text: "# 分镜", status: "ready" }]} onAddFiles={vi.fn()} />);

        expect(markup).toContain("text/markdown");
        expect(markup).toContain("分镜脚本.md");
    });

    it.each(["light", "dark"] as const)("uses a compact themed remove badge in %s mode", (themeName) => {
        const theme = canvasThemes[themeName];
        const markup = renderToStaticMarkup(<AgentChatComposer {...baseProps} theme={theme} attachments={[{ id: "ready", name: "reference.png", url: "blob:ready", status: "ready" }]} onRemoveAttachment={vi.fn()} />);

        expect(markup).toContain("-right-1 -top-1");
        expect(markup).toContain("size-7");
        expect(markup).toContain("size-4");
        expect(markup).toContain("rounded-full");
        expect(markup).toContain(`--remove-surface:${theme.node.removeSurface}`);
        expect(markup).toContain(`--remove-border:${theme.node.removeBorder}`);
        expect(markup).toContain(`--remove-text:${theme.node.removeText}`);
        expect(markup).toContain(`--remove-hover-surface:${theme.node.dangerSurface}`);
        expect(markup).toContain("group-hover/remove:bg-[var(--remove-hover-surface)]");
        expect(markup).toContain("group-focus-visible/remove:bg-[var(--remove-hover-surface)]");
    });
});

describe("Canvas Agent @ references", () => {
    it("uses a single-line suggestion list with compact edge-free thumbnails", () => {
        const markup = renderToStaticMarkup(
            <CanvasAgentMentionPicker
                theme={canvasThemes.dark}
                selectedNodeIds={[]}
                assets={[
                    { id: "one", title: "图片1", type: "image", url: "/api/reference-assets/one.webp" },
                    { id: "two", title: "图片2", type: "image", url: "/api/reference-assets/two.webp" },
                ]}
                onSelect={vi.fn()}
            />,
        );

        expect(markup).toContain("可能的内容");
        expect(markup).toContain('data-testid="canvas-agent-mention-image-list"');
        expect(markup).toContain("size-10");
        expect(markup).toContain("block size-full bg-transparent object-cover");
        expect(markup).not.toContain("grid-cols-4");
    });
});

describe("Canvas Agent execution timing", () => {
    it("uses the Canvas cyan-to-violet flow for dark error feedback", () => {
        const markup = renderToStaticMarkup(<AgentChatMessage item={{ id: "error", role: "error", text: "规划结果未包含所选模型" }} theme={canvasThemes.dark} user={null} />);

        expect(markup).toContain("linear-gradient(90deg, #67e8f9 0%, #818cf8 48%, #c084fc 100%)");
        expect(markup).not.toContain("text-red-600");
    });

    it("shows the timestamp for each persisted chat message", () => {
        const createdAt = "2026-08-27T08:30:00.000Z";
        const markup = renderToStaticMarkup(<AgentChatMessage item={{ id: "message", role: "user", text: "生成三组分镜", createdAt }} theme={canvasThemes.light} user={null} />);

        expect(markup).toContain(`<time dateTime="${createdAt}"`);
        expect(markup).toContain("data-canvas-agent-message-time");
        expect(markup).toContain("2026");
    });

    it("shows multi-task start time and elapsed duration while the Agent is running", () => {
        const markup = renderToStaticMarkup(
            <AgentWorkingMessage
                theme={canvasThemes.light}
                stage={{ key: "executing", text: "正在执行生成任务" }}
                startedAt={1_000}
                tasks={[
                    { id: "one", title: "分镜一", status: "running", startedAt: 2_000 },
                    { id: "two", title: "分镜二", status: "ready" },
                ]}
            />,
        );

        expect(markup).toContain("子任务进度 0/2");
        expect(markup).toContain("分镜一");
        expect(markup).toContain("执行中");
        expect(markup).toContain("已运行");
        expect(markup).toContain("分镜二");
        expect(markup).toContain("等待开始");
    });

    it("shows the failed storyboard reason directly in the task progress card", () => {
        const markup = renderToStaticMarkup(<AgentWorkingMessage theme={canvasThemes.dark} stage={{ key: "executing", text: "正在执行生成任务" }} tasks={[{ id: "failed", title: "分镜四", status: "failed", error: "上游模型拒绝当前请求" }]} />);

        expect(markup).toContain("失败原因：");
        expect(markup).toContain("上游模型拒绝当前请求");
        expect(markup).toContain("data-agent-task-error");
        expect(markup).toContain("whitespace-pre-wrap break-words");
    });

    it("keeps a deferred provider submission visible as an animated, locatable warning", () => {
        const markup = renderToStaticMarkup(
            <AgentWorkingMessage
                theme={canvasThemes.dark}
                stage={{ key: "executing", text: "正在执行生成任务" }}
                runId="run-one"
                onLocateNode={vi.fn()}
                tasks={[{ id: "video", title: "分镜视频", type: "video", status: "ready", retryAfterAt: Date.now() + 10_000, error: "即梦 CLI 正在处理其他提交，系统会自动继续", submittedParameters: { model: "Seedance 2.0 Mini", duration: 8 } }]}
            />,
        );

        expect(markup).toContain("等待账号释放");
        expect(markup).toContain("data-agent-task-waiting");
        expect(markup).toContain('data-agent-task-node-id="output-run-one-0-0"');
        expect(markup).toContain("animate-spin");
    });

    it("shows the safe submitted video parameters beside a provider failure", () => {
        const markup = renderToStaticMarkup(
            <AgentWorkingMessage
                theme={canvasThemes.dark}
                stage={{ key: "executing", text: "正在执行生成任务" }}
                tasks={[{ id: "failed", title: "分镜视频", type: "video", status: "failed", submittedParameters: { model: "Seedance 2.0 Mini", ratio: "9:16", quality: "720p", duration: 8, referenceMode: "单分镜图" }, error: "上游生成失败" }]}
            />,
        );

        expect(markup).toContain("实际提交参数：");
        expect(markup).toContain("时长 8 秒");
        expect(markup).toContain("单分镜图");
    });

    it.each(["completed", "failed", "cancelled"] as const)("keeps a %s run as a static saved progress card", (status) => {
        const markup = renderToStaticMarkup(
            <AgentWorkingMessage
                theme={canvasThemes.dark}
                stage={{ key: "executing", text: "正在执行生成任务" }}
                status={status}
                startedAt={1_000}
                completedAt={3_000}
                tasks={[{ id: "failed", title: "分镜四", status: "failed", error: "上游模型拒绝当前请求" }]}
                onRetryTask={vi.fn()}
            />,
        );

        expect(markup).toContain(`data-canvas-agent-run-status="${status}"`);
        expect(markup).not.toContain("已持续");
        expect(markup).toContain("失败原因：");
        expect(markup).toContain("重新尝试");
    });
});
