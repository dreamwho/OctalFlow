import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { CanvasNodeType } from "../types";
import { assistantMessageToChatMessage, canvasRunSelectedNodeIds, compactMetadata, compactSnapshot, removeCanvasAssistantSessions, restoreCanvasAssistantConversationMessages } from "./canvas-assistant-elements";

describe("Canvas Agent session deletion", () => {
    const sessions = [
        { id: "active", title: "当前对话", messages: [], createdAt: "2026-08-06T00:00:00.000Z", updatedAt: "2026-08-06T00:00:00.000Z" },
        { id: "history", title: "历史对话", messages: [], createdAt: "2026-08-05T00:00:00.000Z", updatedAt: "2026-08-05T00:00:00.000Z" },
    ];

    it("keeps the current chat when deleting another history entry", () => {
        expect(removeCanvasAssistantSessions(sessions, "active", ["history"])).toMatchObject({ sessions: [{ id: "active" }], activeSessionId: "active" });
    });

    it("selects the next chat when deleting the active entry", () => {
        expect(removeCanvasAssistantSessions(sessions, "active", ["active"])).toMatchObject({ sessions: [{ id: "history" }], activeSessionId: "history" });
    });

    it("keeps a fresh active chat after deleting the final conversation", () => {
        const result = removeCanvasAssistantSessions(
            [
                {
                    id: "only-session",
                    title: "待删除对话",
                    messages: [{ id: "message", role: "user", text: "保留输入区" }],
                    createdAt: "2026-08-06T00:00:00.000Z",
                    updatedAt: "2026-08-06T00:00:00.000Z",
                },
            ],
            "only-session",
            ["only-session"],
        );

        expect(result.sessions).toHaveLength(1);
        expect(result.sessions[0]).toMatchObject({ title: "新对话", messages: [] });
        expect(result.activeSessionId).toBe(result.sessions[0].id);
    });
});

describe("Canvas Agent SQL conversation recovery", () => {
    it("rebuilds the real public user and assistant exchange with stable ids and Skill metadata", () => {
        const restored = restoreCanvasAssistantConversationMessages(
            "conversation-one",
            [
                {
                    id: "message-user",
                    conversationId: "conversation-one",
                    sequence: 1,
                    role: "user",
                    status: "completed",
                    content: "生成一条连贯的真人 Vlog",
                    runId: "run-one",
                    metadata: { selectedSkillIds: ["vlog-director"] },
                    createdAt: Date.parse("2026-09-02T06:00:00.000Z"),
                    updatedAt: Date.parse("2026-09-02T06:00:00.000Z"),
                },
                {
                    id: "message-assistant",
                    conversationId: "conversation-one",
                    sequence: 2,
                    role: "assistant",
                    status: "completed",
                    content: "视频任务已完成。",
                    runId: "run-one",
                    metadata: {},
                    createdAt: Date.parse("2026-09-02T06:01:00.000Z"),
                    updatedAt: Date.parse("2026-09-02T06:01:00.000Z"),
                },
            ],
            new Map([["vlog-director", "真人感 Vlog 导演"]]),
        );

        expect(restored).toEqual([
            expect.objectContaining({ id: "message-user", runId: "run-one", role: "user", text: "生成一条连贯的真人 Vlog", skills: [{ id: "vlog-director", name: "真人感 Vlog 导演" }] }),
            expect.objectContaining({ id: "message-assistant", runId: "run-one", role: "assistant", text: "视频任务已完成。", createdAt: "2026-09-02T06:01:00.000Z" }),
        ]);
    });

    it("waits for the project snapshot before restoring SQL runs and exposes a full history timestamp", async () => {
        const [panelSource, historySource, pageSource] = await Promise.all([
            readFile(resolve(process.cwd(), "src/app/(user)/canvas/components/canvas-assistant-panel.tsx"), "utf8"),
            readFile(resolve(process.cwd(), "src/app/(user)/canvas/components/canvas-assistant-elements.tsx"), "utf8"),
            readFile(resolve(process.cwd(), "src/app/(user)/canvas/[id]/canvas-client-page.tsx"), "utf8"),
        ]);

        expect(panelSource).toContain("if (!projectLoaded || !projectId");
        expect(panelSource.indexOf("restoredProjectRef.current = projectId")).toBeGreaterThan(panelSource.indexOf("await Promise.all"));
        expect(panelSource).toContain("await listCreativeMessages(conversationId, undefined, 100)");
        expect(panelSource).toContain("`agent-conversation:${run.conversationId}`");
        expect(pageSource).toContain("projectLoaded={projectLoaded}");
        expect(historySource).toContain('year: "numeric"');
        expect(historySource).toContain('minute: "2-digit"');
    });
});

describe("Canvas Agent current-turn references", () => {
    it("renders the current-turn references before the user text", async () => {
        const item = assistantMessageToChatMessage({
            id: "message",
            role: "user",
            text: "修改颜色",
            skills: [{ id: "skill-real-vlog", name: "真人感 Vlog 导演" }],
            references: [{ id: "reference", type: CanvasNodeType.Image, title: "参考图", dataUrl: "/api/reference-assets/reference.webp" }],
        });
        expect(item.attachments).toEqual([{ id: "reference", name: "参考图", type: "image", url: "/api/reference-assets/reference.webp" }]);
        expect(item.skills).toEqual([{ id: "skill-real-vlog", name: "真人感 Vlog 导演" }]);

        const source = await readFile(resolve(process.cwd(), "src/app/(user)/canvas/components/canvas-agent-chat-ui.tsx"), "utf8");
        const userMessageStart = source.indexOf("if (isUser)");
        const messageSource = source.slice(userMessageStart, source.indexOf("return (", source.indexOf("return (", userMessageStart) + 1));

        expect(messageSource.indexOf("<AgentMessageAttachments")).toBeGreaterThanOrEqual(0);
        expect(messageSource.indexOf("<AgentMessageAttachments")).toBeLessThan(messageSource.indexOf("item.text"));
        expect(messageSource).toContain("已调用 · {skill.name}");
        expect(messageSource.indexOf("<AgentUserAvatar")).toBeGreaterThan(messageSource.indexOf("item.text"));
    });

    it("places compact composer thumbnails above the editable prompt", async () => {
        const source = await readFile(resolve(process.cwd(), "src/app/(user)/canvas/components/canvas-agent-chat-ui.tsx"), "utf8");
        const composer = source.slice(source.indexOf("data-canvas-agent-composer"), source.indexOf("export function AgentPanelTabs"));

        expect(composer).toContain("relative size-8");
        expect(composer).toContain('data-canvas-agent-input-row');
        expect(composer).toContain('hasAttachments ? "flex-col" : "items-start"');
        expect(composer).toContain('className={`relative min-w-0 ${hasAttachments ? "w-full" : "min-w-0 flex-1"}`}');
        expect(composer.indexOf('aria-label="本轮参考素材"')).toBeLessThan(composer.indexOf("<Popover"));
        expect(composer.indexOf("<Popover")).toBeLessThan(composer.indexOf("<textarea"));
    });

    it("clips the conversation paint area and keeps the composer outside the scroll flow", async () => {
        const [panelSource, chatSource, surfaceSource] = await Promise.all([
            readFile(resolve(process.cwd(), "src/app/(user)/canvas/components/canvas-assistant-panel.tsx"), "utf8"),
            readFile(resolve(process.cwd(), "src/app/(user)/canvas/components/canvas-agent-chat-ui.tsx"), "utf8"),
            readFile(resolve(process.cwd(), "src/app/(user)/canvas/components/canvas-surface.tsx"), "utf8"),
        ]);

        expect(panelSource).toContain('className="canvas-agent-panel relative flex h-full min-h-0 max-h-full shrink-0 flex-col overflow-hidden border-l"');
        expect(panelSource).toContain('style={{ contain: "paint" }}');
        expect(panelSource).toContain("overflow-x-hidden overflow-y-auto overscroll-contain");
        expect(panelSource).toContain("onWheelCapture={(event) => event.stopPropagation()}");
        expect(panelSource).toContain("data-canvas-agent-expanded-layer");
        expect(panelSource).toContain("z-[1400]");
        expect(surfaceSource).toContain("[data-canvas-agent-scroll]");
        expect(chatSource).toContain('data-canvas-agent-composer className="shrink-0');
    });

    it("resizes the Agent panel with captured pointer input once per animation frame", async () => {
        const source = await readFile(resolve(process.cwd(), "src/app/(user)/canvas/components/canvas-assistant-panel.tsx"), "utf8");

        expect(source).toContain("onPointerDown={startResize}");
        expect(source).toContain("handle.setPointerCapture(pointerId)");
        expect(source).toContain('window.addEventListener("pointermove", move)');
        expect(source).toContain("window.requestAnimationFrame(applyPendingResize)");
    });

    it("uses the Canvas cyan-to-violet flow to reveal the Agent resize boundary", async () => {
        const source = await readFile(resolve(process.cwd(), "src/app/(user)/canvas/components/canvas-assistant-panel.tsx"), "utf8");

        expect(source).toContain("data-canvas-agent-resize-indicator");
        expect(source).toContain("onPointerEnter={() => setResizeHandleHovered(true)}");
        expect(source).toContain("resizeHandleHovered || resizing");
        expect(source).toContain("#67e8f9 18%, #818cf8 50%, #c084fc 82%");
    });

    it("uses the same flowing cyan-to-violet treatment for selected nodes and active connections", async () => {
        const [nodeSource, surfaceSource, styles] = await Promise.all([
            readFile(resolve(process.cwd(), "src/app/(user)/canvas/components/canvas-node.tsx"), "utf8"),
            readFile(resolve(process.cwd(), "src/app/(user)/canvas/components/canvas-surface.tsx"), "utf8"),
            readFile(resolve(process.cwd(), "src/app/styles/global-canvas-overrides.css"), "utf8"),
        ]);

        expect(nodeSource).toContain("data-canvas-node-selection-flow");
        expect(surfaceSource).toContain('id="canvas-edge-flow-gradient"');
        expect(surfaceSource).toContain('spreadMethod="repeat"');
        expect(surfaceSource).toContain('attributeName="gradientTransform"');
        expect(surfaceSource).toContain("data-canvas-edge-flowing");
        expect(styles).toContain(".canvas-edge-flowing");
        expect(styles).toContain("canvas-edge-flow-glow 2.4s ease-in-out infinite alternate");
        expect(styles).not.toContain("stroke-dasharray: 2 15");
    });

    it("keeps typed @ asset mentions without rendering a dedicated mention button", async () => {
        const source = await readFile(resolve(process.cwd(), "src/app/(user)/canvas/components/canvas-agent-chat-ui.tsx"), "utf8");
        const composer = source.slice(source.indexOf("data-canvas-agent-composer"), source.indexOf("export function AgentPanelTabs"));

        expect(composer).not.toContain('aria-label="引用画布图片或视频"');
        expect(source).toContain("canvasAgentMentionDraftAtCursor");
        expect(composer).toContain("<CanvasAgentMentionPicker");
        expect(source).toContain("onSelectReference?.(asset.id)");
    });

    it("keeps reference upload in the input row and consolidates the single model into the flat preference control", async () => {
        const chatSource = await readFile(resolve(process.cwd(), "src/app/(user)/canvas/components/canvas-agent-chat-ui.tsx"), "utf8");
        const controlsSource = await readFile(resolve(process.cwd(), "src/components/agent/creative-agent-controls.tsx"), "utf8");
        const assistantSource = await readFile(resolve(process.cwd(), "src/app/(user)/canvas/components/canvas-assistant-panel.tsx"), "utf8");
        const settingsSource = await readFile(resolve(process.cwd(), "src/components/agent/compact-agent-generation-settings.tsx"), "utf8");
        const inputRow = chatSource.slice(chatSource.indexOf("data-canvas-agent-input-row"), chatSource.indexOf("data-canvas-agent-toolbar"));
        const toolbar = chatSource.slice(chatSource.indexOf('className="mt-2 flex min-w-0'), chatSource.indexOf("export function AgentPanelTabs"));
        const controls = controlsSource.slice(controlsSource.indexOf("const mutedStyle"), controlsSource.indexOf("function capabilityLabel"));

        expect(inputRow).toContain('aria-label={canvasReferencePicking ? "正在从画布选择素材" : "从画布选择"}');
        expect(inputRow).toContain('aria-label={uploading ? "正在上传参考素材" : "上传本地素材"}');
        expect(chatSource).toContain('accept="image/*,video/*,text/plain,text/markdown,.md,.markdown,.txt"');
        expect(inputRow.indexOf('aria-label="本轮参考素材"')).toBeLessThan(inputRow.indexOf("<textarea"));
        expect(toolbar).toContain("data-canvas-agent-toolbar");
        expect(toolbar).not.toContain("添加参考素材");
        expect(inputRow).toContain("min-h-16");
        expect(controls).toContain('compact ? "flex w-full min-w-0 items-center gap-1"');
        expect(controls).toContain('compact && "ml-auto pl-1"');
        expect(settingsSource).toContain('triggerIcon={<SlidersHorizontal className={emphasizedTrigger ? "size-4" : "size-3.5"} strokeWidth={1.7} />}');
        expect(settingsSource).toContain('emphasizedTrigger ? "!size-9 !min-w-9 !rounded-lg"');
        expect(settingsSource).toContain('panelClassName="!w-[680px] max-w-[calc(100vw-24px)]"');
        expect(settingsSource).toContain("listHeight={416}");
        expect(settingsSource).toContain("showPreferenceFields={Boolean(activeModel)}");
        expect(settingsSource).toContain("iconOnly");
        expect(settingsSource).toContain("tabless");
        expect(settingsSource).toContain("showCount={false}");
        expect(settingsSource).toContain("由 Agent 自动匹配");
        expect(settingsSource).toContain('aria-label={`切换${capability === "image" ? "图片" : "视频"}模型`}');
        expect(toolbar.indexOf("{left}")).toBeLessThan(toolbar.indexOf('aria-label="发送"'));
        expect(assistantSource.indexOf("<CanvasAgentGenerationSettings")).toBeLessThan(assistantSource.indexOf("<CreativeAgentControls"));
        expect(assistantSource).toContain("showPlanningControl={false}");
        expect(assistantSource).toContain("showModelPicker={false}");
        expect(assistantSource).toContain("emphasizedCompactControls");
        expect(assistantSource).toContain("onSelectModel={selectModel}");
        expect(assistantSource).toContain("selectSingleCanvasAgentModel(model, models.filter");
        expect(assistantSource).toContain("selectedModels.map((model) => model.id)");
    });

    it("offers a separate canvas picker and keeps selected Skill names readable", async () => {
        const [chatSource, controlsSource, assistantSource, surfaceSource, pageSource] = await Promise.all([
            readFile(resolve(process.cwd(), "src/app/(user)/canvas/components/canvas-agent-chat-ui.tsx"), "utf8"),
            readFile(resolve(process.cwd(), "src/components/agent/creative-agent-controls.tsx"), "utf8"),
            readFile(resolve(process.cwd(), "src/app/(user)/canvas/components/canvas-assistant-panel.tsx"), "utf8"),
            readFile(resolve(process.cwd(), "src/app/(user)/canvas/components/canvas-surface.tsx"), "utf8"),
            readFile(resolve(process.cwd(), "src/app/(user)/canvas/[id]/canvas-client-page.tsx"), "utf8"),
        ]);

        expect(chatSource).toContain('<MousePointer2 className="size-3.5" strokeWidth={1.7} />');
        expect(chatSource).toContain("onClick={canvasReferencePicking ? onCancelCanvasReferencePicker : onPickCanvasReference}");
        expect(chatSource).toContain('"从画布选择"');
        expect(chatSource).toContain("onPickCanvasReference");
        expect(chatSource).toContain("onCancelCanvasReferencePicker");
        expect(chatSource).toContain("canvasReferencePicking ? onCancelCanvasReferencePicker : onPickCanvasReference");
        expect(chatSource).not.toContain("canvasAgentMentionDeletionAtKey");
        expect(chatSource).not.toContain("removeMentionReference");
        expect(chatSource).toContain("canSubmitWithContext");
        expect(controlsSource).toContain('break-words leading-4">Skill · {skill.name}');
        expect(controlsSource).toContain('variant = "card"');
        expect(controlsSource).toContain('variant === "inline"');
        expect(controlsSource).toContain("data-creative-agent-skill-picker");
        expect(controlsSource).toContain("data-creative-agent-skill-preview");
        expect(controlsSource).toContain("onMouseEnter={() => setPreviewSkillId(skill.id)}");
        expect(assistantSource).toContain("const selectedMentionAssets");
        expect(assistantSource).toContain("mentionAssets={selectedMentionAssets}");
        expect(assistantSource).toContain("canSubmitWithContext={Boolean(selectedSkill || selectedReferences.length)}");
        expect(assistantSource).toContain("composerSkillInserterRef.current(skill)");
        expect(chatSource).toContain("insertCanvasAgentSkillToken");
        expect(assistantSource).toContain("onCancelCanvasReferencePicker");
        expect(assistantSource).toContain("请基于当前参考素材执行");
        expect(surfaceSource).toContain("data-canvas-agent-reference-picker");
        expect(surfaceSource).toContain("CANVAS_AGENT_REFERENCE_LIMIT = 5");
        expect(surfaceSource).toContain("onCancelAgentReferencePicker");
        expect(pageSource).toContain("startCanvasAgentReferencePicker");
        expect(pageSource).toContain("pickCanvasAgentReference");
        expect(pageSource).toContain("onCancelCanvasReferencePicker={() => setAgentReferencePicking(false)}");
    });

    it("uses the settings icon for Canvas image and video parameter triggers", async () => {
        const [imageSettings, videoSettings] = await Promise.all([
            readFile(resolve(process.cwd(), "src/app/(user)/canvas/components/canvas-image-settings-popover.tsx"), "utf8"),
            readFile(resolve(process.cwd(), "src/app/(user)/canvas/components/canvas-video-settings-popover.tsx"), "utf8"),
        ]);

        expect(imageSettings).toContain('triggerIcon={<SlidersHorizontal className="size-4" />}');
        expect(videoSettings).toContain('triggerIcon={<SlidersHorizontal className="size-4" />}');
        expect(imageSettings).toContain("canvasImagePreferenceSummary(preferences, fixedSizeLabel, geminiAi, dreamina?.qualities)");
        expect(imageSettings).toContain('triggerLabelClassName="min-w-0 truncate whitespace-nowrap text-left"');
        expect(imageSettings).toContain('count > 1 ? ` · ${count}张` : ""');
        expect(videoSettings).toContain("canvasVideoPreferenceSummary(preferences)");
        expect(videoSettings).toContain('triggerLabelClassName="min-w-0 truncate whitespace-nowrap text-left"');
    });

    it("clears submitted references before creating the backend run", async () => {
        const source = await readFile(resolve(process.cwd(), "src/app/(user)/canvas/components/canvas-assistant-panel.tsx"), "utf8");
        const sendSource = source.slice(source.indexOf("const sendMessage"), source.indexOf("const waitForBackendAgent"));

        expect(sendSource.indexOf("setRemovedReferenceIds")).toBeGreaterThanOrEqual(0);
        expect(sendSource.indexOf("setRemovedReferenceIds")).toBeLessThan(sendSource.indexOf("createCreativeAgentRun"));
    });

    it("uses each Canvas chat's persisted backend conversation identity", async () => {
        const source = await readFile(resolve(process.cwd(), "src/app/(user)/canvas/components/canvas-assistant-panel.tsx"), "utf8");

        expect(source).toContain("conversationId: session.conversationId");
        expect(source).toContain("preferences: generationPreferences.mode ? generationPreferences : undefined");
        expect(source).toContain("<CanvasAgentGenerationSettings");
        expect(source).toContain("preferences={generationPreferences}");
        expect(source).toContain("models={models}");
        expect(source).toContain("controlCreativeAgentRun(run.runId, action, session.conversationId)");
        expect(source).toContain("retryCreativeAgentTaskWithState(runId, taskId, session.conversationId)");
        expect(source).toContain("conversationId: run.conversationId");
    });

    it("keeps an uploaded canvas image as a stable Run reference URL", () => {
        expect(
            compactMetadata(CanvasNodeType.Image, {
                content: "/api/reference-assets/permanent/2026/07/28/images/person.png",
                storageKey: "permanent/2026/07/28/images/person.png",
                mimeType: "image/png",
            }),
        ).toMatchObject({ url: "/api/reference-assets/permanent/2026/07/28/images/person.png" });
    });

    it("preserves the generation-media scope instead of rebuilding the image as a reference upload", () => {
        expect(
            compactMetadata(CanvasNodeType.Image, {
                content: "/api/generation-log-assets/permanent/2026/07/28/images/person.png",
                storageKey: "permanent/2026/07/28/images/person.png",
            }),
        ).toMatchObject({ url: "/api/generation-log-assets/permanent/2026/07/28/images/person.png" });
    });

    it("keeps media prompts but never serializes data or blob media bodies", () => {
        const largePayload = `data:image/png;base64,${"canvas-binary-marker".repeat(40_000)}`;
        const large = compactMetadata(CanvasNodeType.Image, { content: largePayload, prompt: "保留人物并改成夜景", status: "success", model: "image-model" });
        const small = compactMetadata(CanvasNodeType.Image, { content: "data:image/png;base64,short", prompt: "保留人物并改成夜景", status: "success", model: "image-model" });

        expect(large).toEqual(small);
        expect(large).toEqual({ content: "保留人物并改成夜景", size: undefined, naturalWidth: undefined, naturalHeight: undefined, url: undefined });
        expect(JSON.stringify(large)).not.toContain("canvas-binary-marker");
        expect(compactMetadata(CanvasNodeType.Video, { content: "blob:http://localhost/video", prompt: "镜头缓慢推进" })).toMatchObject({ content: "镜头缓慢推进", url: undefined });
    });

    it("keeps text and exact config content while removing unused scene fields", () => {
        const snapshot = compactSnapshot({
            projectId: "canvas-one",
            title: "画布",
            imageSize: "1:1",
            nodes: [
                { id: "text", type: CanvasNodeType.Text, title: "文案", position: { x: 120, y: 240 }, width: 320, height: 180, metadata: { content: "完整文本内容", status: "success", model: "text-model" } },
                { id: "config", type: CanvasNodeType.Config, title: "生成配置", position: { x: 480, y: 240 }, width: 340, height: 220, metadata: { composerContent: "生成电影感海报", size: "1824x1024", generationMode: "image" } },
            ],
            connections: [],
            selectedNodeIds: ["text"],
            viewport: { x: 100, y: 200, k: 0.75 },
        });

        expect(snapshot.nodes).toEqual([
            { id: "text", type: CanvasNodeType.Text, title: "文案", position: { x: 120, y: 240 }, width: 320, height: 180, metadata: { content: "完整文本内容", size: undefined, naturalWidth: undefined, naturalHeight: undefined, url: undefined } },
            { id: "config", type: CanvasNodeType.Config, title: "生成配置", position: { x: 480, y: 240 }, width: 340, height: 220, metadata: { content: "生成电影感海报", size: "1824x1024", naturalWidth: undefined, naturalHeight: undefined, url: undefined } },
        ]);
        expect(snapshot).not.toHaveProperty("viewport");
        expect(snapshot.nodes[0]).toHaveProperty("position", { x: 120, y: 240 });
        expect(snapshot.nodes[0].metadata).not.toHaveProperty("status");
        expect(snapshot.nodes[0].metadata).not.toHaveProperty("model");
        expect(snapshot.nodes[1].metadata).not.toHaveProperty("generationMode");
    });

    it("keeps the current custom image dimensions in the backend Run snapshot", () => {
        expect(
            compactSnapshot({
                projectId: "canvas-one",
                title: "画布",
                imageSize: "1824x1024",
                nodes: [],
                connections: [],
                selectedNodeIds: [],
                viewport: { x: 0, y: 0, k: 1 },
            }),
        ).toMatchObject({ imageSize: "1824x1024" });
    });

    it("keeps selected config nodes while replacing stale media references", () => {
        const snapshot = {
            projectId: "canvas-one",
            title: "画布",
            nodes: [
                { id: "config", type: CanvasNodeType.Config, title: "生成配置", position: { x: 0, y: 0 }, width: 320, height: 240, metadata: { size: "1824x1024" } },
                { id: "old-image", type: CanvasNodeType.Image, title: "旧参考图", position: { x: 0, y: 0 }, width: 320, height: 240, metadata: { content: "/old.webp" } },
                { id: "current-image", type: CanvasNodeType.Image, title: "本轮参考图", position: { x: 0, y: 0 }, width: 320, height: 240, metadata: { content: "/current.webp" } },
            ],
            connections: [],
            selectedNodeIds: ["config", "old-image"],
            viewport: { x: 0, y: 0, k: 1 },
        };

        expect(canvasRunSelectedNodeIds(snapshot, new Set(["current-image"]))).toEqual(["config", "current-image"]);
    });
});
