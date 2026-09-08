import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";

test.describe.configure({ mode: "serial" });

for (const outcome of ["success-50", "success-70", "failure", "reduced"] as const)
    test(`confirmed ${outcome} handles estimated mid-progress without an abrupt successful result`, async ({ page, request }) => {
        const url = "/animations/generation-loading-animation.mp4";
        const project = await createCanvasProject(request, {
            title: "完成进度收尾回归",
            viewport: { x: 0, y: 0, k: 1 },
            nodes: [node("completion-source", "video", 20, 140, 340, 191, { status: "success", content: url, serverUrl: url, storageKey: "completion-fixture.mp4" })],
            connections: [],
        });
        let finish!: () => void;
        const ready = new Promise<void>((resolve) => {
            finish = resolve;
        });
        await page.route("**/api/canvas/video-depth", async (route) => {
            await ready;
            await route.fulfill({
                contentType: "application/x-ndjson",
                body: `${JSON.stringify(outcome === "failure" ? { code: 502, msg: "完成进度测试失败" } : { code: 0, data: { video: { serverUrl: url, storageKey: "completed-fixture.mp4", mimeType: "video/mp4", bytes: 1, width: 480, height: 480 } } })}\n`,
            });
        });
        try {
            await page.clock.install();
            if (outcome === "reduced") await page.emulateMedia({ reducedMotion: "reduce" });
            await page.goto(`/canvas/${project.id}`);
            await page.locator('[data-node-id="completion-source"]').click({ button: "right", position: { x: 100, y: 80 } });
            await page.getByRole("menuitem", { name: "深度提取", exact: true }).click();
            const result = page.locator('[data-node-id^="video-depth-"]');
            const loading = result.locator("[data-canvas-node-loading]");
            await expect(loading).toHaveAttribute("aria-label", /生成中 预计/);
            await page.clock.fastForward(outcome === "success-70" ? 68_000 : 42_000);
            await expect(loading).toHaveAttribute("aria-label", outcome === "success-70" ? /生成中 预计 7\d%/ : /生成中 预计 [45]\d%/);
            finish();
            if (outcome.startsWith("success")) {
                await expect(loading).toHaveAttribute("aria-label", /生成完成 \d+%/);
                await page.clock.runFor(360);
                await expect(loading).toHaveAttribute("aria-label", "生成完成 100%");
                await page.screenshot({ path: `.e2e-artifacts/completion-${outcome}-100.png` });
                await page.clock.runFor(150);
            }
            await expect(loading).toHaveCount(0);
            if (outcome === "failure") await expect(result.getByRole("alert")).toContainText("完成进度测试失败");
            else await expect(result.locator("video")).toHaveAttribute("src", url);
            await page.clock.runFor(1000);
            await expectCanvasSaved(page);
            await page.reload();
            await expect(page.locator("[data-canvas-node-loading]")).toHaveCount(0);
        } finally {
            finish();
            await deleteCanvasProject(request, project.id);
        }
    });

test("estimated generation progress advances and survives reload without claiming completion", async ({ page, request }) => {
    const startedAt = Date.now() - 180_000;
    const project = await createCanvasProject(request, {
        title: "预计进度回归",
        viewport: { x: 0, y: 0, k: 1 },
        nodes: [node("estimated-progress", "image", 20, 140, 340, 191, { status: "loading", generationStartedAt: startedAt }), node("fresh-progress", "text", 420, 140, 340, 191, { status: "loading" })],
        connections: [],
    });
    try {
        await page.goto(`/canvas/${project.id}`);
        const loading = page.locator('[data-node-id="estimated-progress"] [data-canvas-node-loading]');
        await expect(loading).toHaveAttribute("aria-label", /生成中 预计 9\d%/);
        await expect(loading).toContainText("已等待 3:");
        await expect(loading).toContainText("等待结果");
        const fresh = page.locator('[data-node-id="fresh-progress"] [data-canvas-node-loading]');
        const initial = await fresh.getAttribute("aria-label");
        await expect(fresh).not.toHaveAttribute("aria-label", initial!);
        const before = Number((await loading.getAttribute("aria-label"))!.match(/\d+/)![0]);
        await page.reload();
        await expect(loading).toHaveAttribute("aria-label", /生成中 预计 9\d%/);
        expect(Number((await loading.getAttribute("aria-label"))!.match(/\d+/)![0])).toBeGreaterThanOrEqual(before);
        for (const width of [1440, 390, 430]) {
            await page.setViewportSize({ width, height: 900 });
            const parent = (await loading.boundingBox())!;
            const status = (await loading.locator(":scope > span").boundingBox())!;
            expect(status.y + status.height).toBeLessThan(parent.y + parent.height);
            expect(status.x + status.width).toBeLessThanOrEqual(parent.x + parent.width);
            await page.screenshot({ path: `.e2e-artifacts/estimated-progress-${width}.png` });
        }
    } finally {
        await deleteCanvasProject(request, project.id);
    }
});

test("local depth extraction streams real frame progress and appears in generation operations", async ({ page, request }) => {
    test.skip(!existsSync("../services/video-depth/models/depth-anything-v2-small-hf/config.json"), "local depth model is not installed");
    const directory = await mkdtemp(join(tmpdir(), "canvas-depth-e2e-"));
    let projectId: string | undefined;
    try {
        const source = join(directory, "source.mp4");
        execFileSync(process.env.FFMPEG_PATH || "ffmpeg", ["-y", "-f", "lavfi", "-i", "testsrc2=size=160x96:rate=2", "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", source], { stdio: "ignore" });
        const upload = await request.post("/api/reference-assets", { data: { dataUrl: `data:video/mp4;base64,${(await readFile(source)).toString("base64")}`, type: "video", persistent: true, originalName: "depth-e2e.mp4" } });
        expect(upload.ok(), await upload.text()).toBe(true);
        const asset = await upload.json();
        const project = await createCanvasProject(request, {
            title: "深度提取端到端回归",
            viewport: { x: 0, y: 0, k: 1 },
            nodes: [node("depth-source", "video", 100, 180, 340, 204, { storageKey: asset.key, serverUrl: asset.url, content: asset.url, status: "success" })],
            connections: [],
        });
        projectId = project.id;
        await page.goto(`/canvas/${project.id}`);
        const started = Date.now();
        const sourceNode = page.locator('[data-node-id="depth-source"]');
        await sourceNode.click({ button: "right", position: { x: 100, y: 80 } });
        const completed = page.waitForResponse((response) => response.url().endsWith("/api/canvas/video-depth") && response.request().method() === "POST");
        await page.getByRole("menuitem", { name: "深度提取", exact: true }).click();
        const response = await completed;
        expect(response.ok()).toBe(true);
        const events = (await response.text())
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
        expect(events.filter((event) => event.progress?.stage.startsWith("深度推理")).map((event) => event.progress.percent)).toEqual([25, 50, 75, 100]);
        expect(events.at(-1).data.video).toMatchObject({ width: 160, height: 96 });
        await expect(page.locator('[data-node-id^="video-depth-"] video')).toHaveAttribute("src", events.at(-1).data.video.serverUrl);
        const operations = await request.get("/api/admin/generation-operations?type=render&surface=canvas");
        expect(operations.ok()).toBe(true);
        const task = (await operations.json()).data.items.find((item: { createdAt: number }) => item.createdAt >= started);
        expect(task).toMatchObject({ prompt: "深度提取", status: "success", provider: "local-depth", lastUpstreamStatus: "完成 100%" });
        await page.goto("/admin/generation-operations");
        await expect(page.getByText("深度提取", { exact: true }).first()).toBeVisible();
        await expect(page.getByText("执行进度：完成 100%", { exact: true }).first()).toBeVisible();
    } finally {
        if (projectId) await deleteCanvasProject(request, projectId);
        await rm(directory, { recursive: true, force: true });
    }
});

test("canvas generation progress stays in the top-left on desktop and mobile", async ({ page, request }) => {
    const project = await createCanvasProject(request, {
        title: `生成进度回归 ${randomUUID().slice(0, 8)}`,
        viewport: { x: 0, y: 0, k: 1 },
        nodes: [node("depth-progress", "video", 20, 140, 340, 191, { status: "loading", generationProgress: 6, generationStage: "深度推理" })],
        connections: [],
    });
    try {
        for (const width of [1440, 390, 430]) {
            await page.setViewportSize({ width, height: 900 });
            await page.goto(`/canvas/${project.id}`, { waitUntil: "domcontentloaded" });
            const loading = page.locator('[data-node-id="depth-progress"] [data-canvas-node-loading]');
            await expect(loading).toBeVisible();
            await expect(loading).toHaveAttribute("aria-label", "生成中 6%");
            const label = loading.locator("span");
            const containerBox = (await loading.boundingBox())!;
            const labelBox = (await label.boundingBox())!;
            expect(labelBox.x).toBeGreaterThan(containerBox.x);
            expect(labelBox.y).toBeGreaterThan(containerBox.y);
            expect(labelBox.y - containerBox.y).toBeLessThan(containerBox.height / 3);
            expect(labelBox.x + labelBox.width).toBeLessThanOrEqual(containerBox.x + containerBox.width);
            await expect(page.locator("body")).toHaveJSProperty("scrollWidth", width);
            await page.screenshot({ path: `.e2e-artifacts/generation-progress-${width}.png` });
        }
    } finally {
        await deleteCanvasProject(request, project.id);
    }
});

test("canvas keeps editing, selection, linking and persistence fluid", async ({ page, request }) => {
    test.setTimeout(180_000);
    const project = await createCanvasProject(request, {
        title: `Canvas 交互回归 ${randomUUID().slice(0, 8)}`,
        viewport: { x: 100, y: 110, k: 1 },
        nodes: [node("text-source", "text", 60, 100, 240, 170, { content: "创作方向" }), node("config-target", "config", 380, 100, 280, 210, { size: "1280x720", composerContent: "" }), node("image-target", "image", 200, 360, 260, 200, {})],
        connections: [],
    });

    try {
        const projectPath = `/api/canvas/projects/${project.id}`;
        const patchRequests: number[] = [];
        page.on("request", (request) => {
            if (request.method() === "PATCH" && new URL(request.url()).pathname === projectPath) patchRequests.push(Date.now());
        });

        await page.goto(`/canvas/${project.id}`, { waitUntil: "domcontentloaded" });
        const surface = page.locator("[data-canvas-surface]");
        await expect(surface).toBeVisible({ timeout: 20_000 });
        await expect(surface).toHaveCSS("background-color", "rgb(255, 255, 255)");

        const configNode = page.locator('[data-node-id="config-target"]');
        await expect.poll(async () => (await configNode.boundingBox())!.height).toBeLessThanOrEqual(182);
        const initialConfigBox = await configNode.boundingBox();
        expect(initialConfigBox).not.toBeNull();
        const generationModeButton = configNode.getByRole("button", { name: "切换生成类型，当前生图" });
        await expect(generationModeButton).toBeVisible();
        await generationModeButton.click();
        await expect(page.getByRole("menuitem", { name: "视频" })).toBeVisible();
        await page.getByRole("menuitem", { name: "视频" }).click();
        await expect(configNode.getByRole("button", { name: "切换生成类型，当前视频" })).toBeVisible();
        await expect(configNode.locator(".canvas-composer-model-picker")).not.toHaveAttribute("title", "gpt-image-2");
        const configDetailsToggle = configNode.getByRole("button", { name: "展开输入与镜头" });
        await expect(configDetailsToggle).toBeVisible();
        await expect(configNode.locator("[data-canvas-config-details]")).toHaveCount(0);
        await configDetailsToggle.click();
        await expect(configNode.getByRole("button", { name: "收起输入与镜头" })).toBeVisible();
        await expect(configNode.locator("[data-canvas-config-details]")).toBeVisible();
        await expect.poll(async () => (await configNode.boundingBox())!.height).toBeGreaterThan(initialConfigBox!.height + 40);
        await configNode.getByRole("button", { name: "收起输入与镜头" }).click();
        await expect(configNode.locator("[data-canvas-config-details]")).toHaveCount(0);
        await expect.poll(async () => (await configNode.boundingBox())!.height).toBeLessThanOrEqual(182);
        await configNode.click({ position: { x: 36, y: 36 } });
        const composer = page.locator('[contenteditable="true"]');
        await expect(composer).toBeVisible();
        await expect.poll(() => composer.evaluate((element) => document.activeElement === element)).toBe(true);
        const composerPatchCount = patchRequests.length;
        await composer.fill("单击即可输入并保存");
        await expect.poll(() => patchRequests.length).toBeGreaterThan(composerPatchCount);
        await expectCanvasSaved(page);

        await page.reload({ waitUntil: "domcontentloaded" });
        const restoredConfigNode = page.locator('[data-node-id="config-target"]');
        await expect.poll(async () => (await restoredConfigNode.boundingBox())!.height).toBeLessThanOrEqual(182);
        await restoredConfigNode.click({ position: { x: 36, y: 36 } });
        await expect(composer).toHaveText("单击即可输入并保存");
        await expect.poll(() => composer.evaluate((element) => document.activeElement === element)).toBe(true);
        await page.getByRole("button", { name: "关闭提示词组装" }).click();

        const imageNode = page.locator('[data-node-id="image-target"]');
        await imageNode.click({ position: { x: 36, y: 36 } });
        const nodePrompt = page.getByRole("textbox", { name: "节点提示词" });
        await expect(nodePrompt).toBeVisible();
        await expect.poll(() => nodePrompt.evaluate((element) => document.activeElement === element)).toBe(true);
        await nodePrompt.fill("放大编辑后仍然同步");
        await page.getByRole("button", { name: "放大提示词输入" }).click();
        const promptDialog = page.getByRole("dialog", { name: "编辑提示词" });
        const expandedPrompt = promptDialog.getByRole("textbox", { name: "提示词编辑器" });
        await expect(promptDialog).toBeVisible();
        await expect(promptDialog.locator(".ant-modal-body")).toHaveCSS("background-color", "rgb(255, 255, 255)");
        await expect(promptDialog.locator('[data-canvas-prompt-editor="expanded"]')).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
        await expect(expandedPrompt).toHaveCSS("background-color", "rgb(238, 246, 251)");
        await expect(promptDialog.locator(".ant-modal-footer")).toHaveCount(0);
        await expect(expandedPrompt).toHaveValue("放大编辑后仍然同步");
        await expect.poll(() => expandedPrompt.evaluate((element) => document.activeElement === element)).toBe(true);
        await expandedPrompt.fill("弹窗中的长提示词会实时回写原输入框");
        await promptDialog.getByRole("button", { name: "收起提示词输入" }).click();
        await expect(promptDialog).toBeHidden();
        await expect(nodePrompt).toHaveValue("弹窗中的长提示词会实时回写原输入框");

        await page.getByRole("button", { name: "切换到框选模式" }).click();
        await expect(surface).toHaveAttribute("data-canvas-interaction-mode", "select");
        await dragSelectionBox(page, page.locator("[data-node-id]"));
        await expectSelectedNodeCount(page, 3);

        const temporaryPanNodeBox = await configNode.boundingBox();
        const temporaryPanViewport = await readCanvasViewport(request, projectPath);
        expect(temporaryPanNodeBox).not.toBeNull();
        await surface.focus();
        await page.keyboard.down("Space");
        await expect(surface).toHaveAttribute("data-canvas-temporary-pan", "true");
        await page.mouse.move(temporaryPanNodeBox!.x + 80, temporaryPanNodeBox!.y + 60);
        await page.mouse.down();
        await page.mouse.move(temporaryPanNodeBox!.x + 140, temporaryPanNodeBox!.y + 95, { steps: 6 });
        await page.mouse.up();
        await page.keyboard.up("Space");
        await expect(surface).toHaveAttribute("data-canvas-temporary-pan", "false");
        await expect(surface).toHaveAttribute("data-canvas-interaction-mode", "select");
        await expect.poll(async () => (await readCanvasViewport(request, projectPath)).x).toBeGreaterThan(temporaryPanViewport.x + 40);
        const temporaryPanNodeAfter = await configNode.boundingBox();
        expect(temporaryPanNodeAfter!.x - temporaryPanNodeBox!.x).toBeGreaterThan(40);
        expect(temporaryPanNodeAfter!.x - temporaryPanNodeBox!.x).toBeLessThan(80);

        const sourceNode = page.locator('[data-node-id="text-source"]');
        await sourceNode.click();
        await page.keyboard.down("Control");
        await page.locator('[data-node-id="config-target"]').click({ position: { x: 36, y: 36 } });
        await page.keyboard.up("Control");
        await expectSelectedNodeCount(page, 2);

        await dragConnection(page, sourceNode, sourceNode);
        await expect(page.locator("[data-connection-create-menu]")).toHaveCount(0);

        await dragConnection(page, sourceNode, page.locator('[data-node-id="config-target"]'));
        await expect(page.locator("[data-connection-id]")).toHaveCount(1);

        const surfaceBounds = await surface.boundingBox();
        expect(surfaceBounds).not.toBeNull();
        await dragConnectionToPoint(page, sourceNode, surfaceBounds!.x + surfaceBounds!.width - 70, surfaceBounds!.y + surfaceBounds!.height - 70);
        const createMenu = page.locator("[data-connection-create-menu]");
        await expect(createMenu).toBeVisible();
        await createMenu.getByRole("button", { name: /图片生成/ }).click();
        await expect(page.locator("[data-connection-id]")).toHaveCount(2);
        await expect(page.locator("[data-node-id]")).toHaveCount(4);
        await page.waitForTimeout(500);
        await expectCanvasSaved(page);

        patchRequests.length = 0;
        const beforeDrag = await sourceNode.boundingBox();
        expect(beforeDrag).not.toBeNull();
        const dragStart = { x: beforeDrag!.x + beforeDrag!.width / 2, y: beforeDrag!.y + beforeDrag!.height - 28 };
        await page.mouse.move(dragStart.x, dragStart.y);
        await page.mouse.down();
        await page.mouse.move(dragStart.x + 90, dragStart.y + 45, { steps: 8 });
        await page.waitForTimeout(400);
        expect(patchRequests).toHaveLength(0);
        await page.mouse.up();
        await expect.poll(() => patchRequests.length).toBe(1);
        await expectCanvasSaved(page);
        const afterDrag = await sourceNode.boundingBox();
        expect(afterDrag!.x).toBeGreaterThan(beforeDrag!.x + 70);

        const resizeHandle = sourceNode.locator('[data-canvas-resize-corner="bottom-right"]');
        const handleBounds = await resizeHandle.boundingBox();
        const beforeResize = await sourceNode.boundingBox();
        expect(handleBounds).not.toBeNull();
        await page.mouse.move(handleBounds!.x + handleBounds!.width / 2, handleBounds!.y + handleBounds!.height / 2);
        await page.mouse.down();
        await page.mouse.move(handleBounds!.x + 75, handleBounds!.y + 45, { steps: 6 });
        await page.mouse.up();
        await expect.poll(async () => (await sourceNode.boundingBox())!.width).toBeGreaterThan(beforeResize!.width + 40);
        await expect.poll(() => patchRequests.length).toBeGreaterThan(1);
        await expectCanvasSaved(page);

        await page.keyboard.down("Control");
        await imageNode.click({ position: { x: 36, y: 36 } });
        await page.keyboard.up("Control");
        await expectSelectedNodeCount(page, 2);
        await page.getByRole("button", { name: "切换到小手模式" }).click();
        await expect(surface).toHaveAttribute("data-canvas-interaction-mode", "pan");
        await expectSelectedNodeCount(page, 2);
        const copyPatchCount = patchRequests.length;
        await page.keyboard.press("Control+c");
        await page.keyboard.press("Control+v");
        await expect.poll(() => patchRequests.length).toBeGreaterThan(copyPatchCount);
        await expectCanvasSaved(page);
        await expect.poll(() => readCanvasNodeCount(request, projectPath)).toBe(6);
    } finally {
        await deleteCanvasProject(request, project.id);
    }
});

test("canvas arranges a right-clicked selection, closes prompts on blank space, and creates an interior design node", async ({ page, request }, testInfo) => {
    test.setTimeout(120_000);
    page.setDefaultTimeout(10_000);
    const project = await createCanvasProject(request, {
        title: `Canvas 室内设计 ${randomUUID().slice(0, 8)}`,
        viewport: { x: 60, y: 100, k: 1 },
        nodes: [
            node("text-filled", "text", 40, 90, 240, 160, { content: "空间改造说明" }),
            node("config-empty", "config", 360, 120, 280, 180, { composerContent: "" }),
            node("image-source", "image", 190, 360, 260, 180, {
                content: "https://cdn.example.com/canvas-interior-source.webp",
                remoteUrl: "https://cdn.example.com/canvas-interior-source.webp",
            }),
        ],
        connections: [],
    });
    const projectPath = `/api/canvas/projects/${project.id}`;

    try {
        await page.addInitScript(() => {
            if (!localStorage.getItem("octalaicanvas:theme_store")) localStorage.setItem("octalaicanvas:theme_store", JSON.stringify({ state: { theme: "light" }, version: 0 }));
        });
        await page.goto(`/canvas/${project.id}`, { waitUntil: "domcontentloaded" });
        const surface = page.locator("[data-canvas-surface]");
        const imageNode = page.locator('[data-node-id="image-source"]');
        await expect(surface).toBeVisible({ timeout: 20_000 });
        await expect(imageNode).toBeVisible();
        await page.getByRole("button", { name: "切换到框选模式" }).click();
        await expect(surface).toHaveAttribute("data-canvas-interaction-mode", "select");

        await imageNode.click({ position: { x: 32, y: 32 } });
        await expect(page.getByRole("textbox", { name: "节点提示词" })).toBeVisible();
        await page.getByRole("button", { name: /^Skill(?: · \d+)?$/ }).click();
        const skillDialog = page.locator("[data-canvas-skill-dialog]");
        await expect(skillDialog).toBeVisible();
        await expect(skillDialog.getByRole("searchbox", { name: "搜索 Skill" })).toBeVisible();
        await expect(skillDialog.getByRole("tab", { name: "全部技能" })).toBeVisible();
        const skillToolbar = await skillDialog.locator("[data-canvas-skill-toolbar]").boundingBox();
        expect(skillToolbar?.height).toBeLessThanOrEqual(72);
        const skillDialogBounds = await skillDialog.boundingBox();
        expect(skillDialogBounds?.height).toBeLessThan(620);
        await expect(page.locator(".ant-modal").last()).not.toHaveClass(/ant-zoom-appear/);
        await page.mouse.move(20, 20);
        await expect(page.locator(".agent-skill-preview-popover:visible")).toHaveCount(0);
        await page.screenshot({ path: testInfo.outputPath("skill-selector.png"), animations: "disabled" });
        await page.getByRole("button", { name: "Close" }).click();
        await expect(skillDialog).toBeHidden();
        const surfaceBox = await surface.boundingBox();
        expect(surfaceBox).not.toBeNull();
        await page.mouse.click(surfaceBox!.x + surfaceBox!.width - 80, surfaceBox!.y + 300);
        await expect(page.getByRole("textbox", { name: "节点提示词" })).toBeHidden();
        await page.getByRole("button", { name: "重置视图" }).click();
        await expect(page.locator('[data-node-id="text-filled"]')).toBeInViewport();

        await page.locator('[data-node-id="text-filled"]').click({ position: { x: 24, y: 24 } });
        await page.keyboard.down("Control");
        await page.locator('[data-node-id="config-empty"]').click({ position: { x: 24, y: 24 } });
        await imageNode.click({ position: { x: 24, y: 24 } });
        await page.keyboard.up("Control");
        await expectSelectedNodeCount(page, 3);

        await imageNode.click({ button: "right", position: { x: 40, y: 40 } });
        await expectSelectedNodeCount(page, 3);
        const menu = page.getByRole("menu");
        await expect(menu.getByRole("menuitem", { name: "一键整理" })).toBeVisible();
        await expect(menu.getByRole("menuitem", { name: "室内设计" })).toBeVisible();
        await menu.getByRole("menuitem", { name: "一键整理" }).click();
        await expectCanvasSaved(page);
        await expect
            .poll(async () => {
                const stored = await readCanvasProject(request, projectPath);
                const image = stored.nodes.find((item) => item.id === "image-source")!;
                const text = stored.nodes.find((item) => item.id === "text-filled")!;
                const config = stored.nodes.find((item) => item.id === "config-empty")!;
                return {
                    x: [image.position.x, text.position.x, config.position.x],
                    top: image.position.y,
                    imageToTextGap: text.position.y - image.position.y - image.height,
                    textToConfigGap: config.position.y - text.position.y - text.height,
                };
            })
            .toEqual({ x: [40, 40, 40], top: 90, imageToTextGap: 66, textToConfigGap: 66 });

        await page.locator('[data-node-id="image-source"]').click({ button: "right", position: { x: 40, y: 40 } });
        await page.getByRole("menuitem", { name: "室内设计" }).click();
        const dialog = page.getByRole("dialog", { name: "室内设计" });
        await expect(dialog).toBeVisible();
        await expect(dialog.getByRole("tab", { name: "功能广场" })).toBeVisible();
        await expect(dialog.getByRole("searchbox", { name: "搜索室内设计功能" })).toBeVisible();
        const catalogToolbar = await dialog.locator("[data-canvas-interior-catalog-toolbar]").boundingBox();
        expect(catalogToolbar?.height).toBeLessThanOrEqual(72);
        await expect(dialog.getByRole("button", { name: /SU直出摄影级照片/ })).toBeVisible();
        await expect(dialog).not.toHaveClass(/ant-zoom-appear/);
        await page.screenshot({ path: testInfo.outputPath("interior-catalog.png"), animations: "disabled" });
        await dialog.getByRole("button", { name: /SU直出摄影级照片/ }).click();
        await expect(page.getByRole("dialog", { name: "SU直出摄影级照片" })).toBeVisible();
        for (const tab of ["生图模式", "场景", "光影氛围", "摄影设备", "AI约束"]) await expect(page.getByRole("tab", { name: tab })).toBeVisible();
        await expect(page.getByRole("tab", { name: "出图比例" })).toHaveCount(0);
        await expect(page.getByRole("combobox", { name: "画面比例" })).toBeVisible();
        await expect(page.getByRole("combobox", { name: "目标精度" })).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath("interior-config.png"), animations: "disabled" });

        for (const width of [390, 430]) {
            await page.setViewportSize({ width, height: width === 390 ? 844 : 932 });
            await expect
                .poll(async () => {
                    const bounds = await page.getByRole("dialog", { name: "SU直出摄影级照片" }).boundingBox();
                    return Boolean(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width + 1);
                })
                .toBe(true);
            await expectNoHorizontalOverflow(page, `Canvas 室内设计 ${width}px`);
        }

        await page.setViewportSize({ width: 1280, height: 900 });
        await page.getByRole("button", { name: /^确\s*认$/ }).click();
        const interiorNode = page.locator("[data-canvas-interior-design-node]");
        await expect(interiorNode).toBeVisible();
        const interiorNodeElement = interiorNode.locator("xpath=ancestor::*[@data-node-id][1]");
        const interiorNodeBox = await interiorNodeElement.boundingBox();
        expect(interiorNodeBox?.width).toBeCloseTo(interiorNodeBox?.height || 0, 0);
        const modelControl = interiorNode.getByRole("combobox");
        const photographyControl = interiorNode.getByRole("button", { name: "摄影参数" });
        const generateControl = interiorNode.getByRole("button", { name: "生成" });
        await expect(modelControl).toBeVisible();
        await expect(photographyControl).toBeVisible();
        await expect(generateControl).toBeVisible();
        const modelControlBox = await modelControl.boundingBox();
        const photographyControlBox = await photographyControl.boundingBox();
        const actionGroupBox = await interiorNode.locator("[data-canvas-interior-actions]").boundingBox();
        const generateControlBox = await generateControl.boundingBox();
        expect(photographyControlBox?.y).toBeGreaterThan((modelControlBox?.y || 0) + (modelControlBox?.height || 0));
        expect((actionGroupBox?.y || 0) - ((photographyControlBox?.y || 0) + (photographyControlBox?.height || 0))).toBeGreaterThanOrEqual(10);
        expect((generateControlBox?.y || 0) - ((photographyControlBox?.y || 0) + (photographyControlBox?.height || 0))).toBeGreaterThanOrEqual(10);
        await expect(interiorNode.getByText("原图比例")).toHaveCount(0);
        await expect(generateControl).toBeDisabled();
        await expect(interiorNode.getByText("请先配置 Gemini Nano Banana 生图模型")).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath("interior-node.png"), animations: "disabled" });
        await expectCanvasSaved(page);

        const stored = await readCanvasProject(request, projectPath);
        const source = stored.nodes.find((item) => item.id === "image-source");
        const config = stored.nodes.find((item) => item.metadata?.configKind === "interior-design");
        expect(source).toBeDefined();
        expect(config).toMatchObject({ type: "config", width: 240, height: 240, metadata: { sourcePrompt: "SU直出摄影级照片", status: "idle" } });
        expect(config!.position.x).toBeGreaterThanOrEqual(source!.position.x + source!.width + 66);
        expect(stored.connections).toContainEqual(expect.objectContaining({ fromNodeId: "image-source", toNodeId: config!.id }));

        await page.getByRole("button", { name: "切换到深色主题" }).click();
        await expect(page.locator("html")).toHaveClass(/dark/);
        await page.reload({ waitUntil: "domcontentloaded" });
        await expect(page.locator("html")).toHaveClass(/dark/);
        const restoredInteriorNode = page.locator("[data-canvas-interior-design-node]");
        await expect(restoredInteriorNode).toBeVisible();
        await restoredInteriorNode.getByRole("button", { name: "摄影参数" }).click();
        const darkConfigDialog = page.getByRole("dialog", { name: "SU直出摄影级照片" });
        await expect(darkConfigDialog).toBeVisible();
        await expect(darkConfigDialog.locator(".ant-modal-container")).toHaveCSS("background-color", "rgb(15, 17, 21)");
        await expect(darkConfigDialog).not.toHaveClass(/ant-zoom-appear/);
        await page.screenshot({ path: testInfo.outputPath("interior-config-dark.png"), animations: "disabled" });
        await darkConfigDialog.getByRole("button", { name: "关闭摄影参数" }).click();
        await expect(darkConfigDialog).toBeHidden();

        await imageNode.click({ button: "right", position: { x: 40, y: 40 } });
        await page.getByRole("menuitem", { name: "室内设计" }).click();
        const darkCatalogDialog = page.getByRole("dialog", { name: "室内设计" });
        await expect(darkCatalogDialog).toBeVisible();
        await expect(darkCatalogDialog).not.toHaveClass(/ant-zoom-appear/);
        await page.screenshot({ path: testInfo.outputPath("interior-catalog-dark.png"), animations: "disabled" });
        await darkCatalogDialog.getByRole("button", { name: "关闭室内设计" }).click();
    } finally {
        await deleteCanvasProject(request, project.id).catch(() => undefined);
    }
});

test("canvas video first and last frame roles persist and retry from the output snapshot", async ({ page, request }) => {
    test.setTimeout(120_000);
    const project = await createCanvasProject(request, {
        title: `Canvas 首尾帧 ${randomUUID().slice(0, 8)}`,
        viewport: { x: 36, y: 110, k: 1 },
        nodes: [
            { ...node("first-frame", "image", 430, 60, 220, 150, { content: "https://cdn.example.com/canvas-first.webp", remoteUrl: "https://cdn.example.com/canvas-first.webp", naturalWidth: 1280, naturalHeight: 720 }), title: "首帧图片" },
            { ...node("last-frame", "image", 430, 260, 220, 150, { content: "https://cdn.example.com/canvas-last.webp", remoteUrl: "https://cdn.example.com/canvas-last.webp", naturalWidth: 1280, naturalHeight: 720 }), title: "尾帧图片" },
            node("video-config", "config", 20, 90, 300, 180, { generationMode: "video", composerContent: "让画面从清晨平滑过渡到黄昏", size: "1280x720", seconds: "5", vquality: "720" }),
        ],
        connections: [
            { id: "first-frame-edge", fromNodeId: "first-frame", toNodeId: "video-config" },
            { id: "last-frame-edge", fromNodeId: "last-frame", toNodeId: "video-config" },
        ],
    });
    const submitted: Array<{ prompt: string; references: Array<{ type: string; role: string; url: string }>; clientRequestId: string }> = [];

    await page.addInitScript(() => {
        if (!localStorage.getItem("octalaicanvas:theme_store")) localStorage.setItem("octalaicanvas:theme_store", JSON.stringify({ state: { theme: "light" }, version: 0 }));
    });
    await page.route("**/api/video-generation-tasks", async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        const body = route.request().postDataJSON() as { prompt: string; references: Array<{ type: string; role: string; url: string }>; config?: { model?: string } };
        submitted.push({ prompt: body.prompt, references: body.references, clientRequestId: route.request().headers()["x-octalaicanvas-client-request-id"] || "" });
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ task: { id: `canvas-video-task-${submitted.length}`, model: body.config?.model || "video-v1", durationSeconds: 5 } }) });
    });
    await page.route("**/api/video-tasks/**", async (route) => {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ task: { status: "error", error: "E2E 视频上游失败", canRetry: true } }) });
    });

    try {
        await page.setViewportSize({ width: 1280, height: 900 });
        await page.goto(`/canvas/${project.id}`, { waitUntil: "domcontentloaded" });
        await expect(page.locator("[data-canvas-surface]")).toBeVisible({ timeout: 20_000 });
        const configNode = page.locator('[data-node-id="video-config"]');
        await expect(configNode).toBeVisible();

        let settingsTrigger = configNode.getByRole("button", { name: /^视频设置：/ });
        await settingsTrigger.click();
        let settings = page.locator("[data-canvas-video-reference-settings]");
        await expect(settings).toBeVisible();
        await settings.getByRole("button", { name: "视频参考模式：首尾帧" }).click();
        await settings.getByRole("button", { name: "设为视频首帧：首帧图片" }).click();
        await settings.getByRole("button", { name: "选择视频尾帧" }).click();
        await settings.getByRole("button", { name: "设为视频尾帧：尾帧图片" }).click();
        await expect(settings.getByText("首帧图片", { exact: true })).toBeVisible();
        await expect(settings.getByText("尾帧图片", { exact: true })).toBeVisible();
        settingsTrigger = configNode.getByRole("button", { name: /^视频设置：首尾帧/ });
        await settingsTrigger.click();
        await expect(settings).toBeHidden();

        await expect
            .poll(async () => {
                const stored = await readCanvasProject(request, `/api/canvas/projects/${project.id}`);
                return stored.nodes.find((item) => item.id === "video-config")?.metadata;
            })
            .toMatchObject({ videoReferenceMode: "first_last", videoFirstFrame: { nodeId: "first-frame" }, videoLastFrame: { nodeId: "last-frame" } });

        const collapseAgentPanel = page.getByRole("button", { name: "收起 Agent 面板" });
        if (await collapseAgentPanel.isVisible().catch(() => false)) {
            await collapseAgentPanel.click();
            await expect(collapseAgentPanel).toBeHidden();
        }

        for (const width of [390, 430]) {
            await page.setViewportSize({ width, height: width === 390 ? 844 : 932 });
            await settingsTrigger.click();
            await expect(settings).toBeVisible();
            const bounds = await settings.boundingBox();
            expect(bounds).not.toBeNull();
            expect(bounds!.x).toBeGreaterThanOrEqual(0);
            expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width + 1);
            await expectNoHorizontalOverflow(page, `Canvas 首尾帧 ${width}px`);
            await settingsTrigger.click();
            await expect(settings).toBeHidden();
        }

        await page.setViewportSize({ width: 1280, height: 900 });
        await page.evaluate(() => localStorage.setItem("octalaicanvas:theme_store", JSON.stringify({ state: { theme: "dark" }, version: 0 })));
        await page.reload({ waitUntil: "domcontentloaded" });
        await expect(page.locator("html")).toHaveClass(/dark/);
        settingsTrigger = page.locator('[data-node-id="video-config"]').getByRole("button", { name: /^视频设置：首尾帧/ });
        await settingsTrigger.click();
        settings = page.locator("[data-canvas-video-reference-settings]");
        await expect(settings).toBeVisible();
        await expectNoHorizontalOverflow(page, "Canvas 首尾帧深色主题");
        await settingsTrigger.click();

        await page.locator('[data-node-id="video-config"]').getByRole("button", { name: "开始生成" }).click();
        await expect.poll(() => submitted.length).toBe(1);
        expect(submitted[0].references).toEqual([
            { type: "image", role: "first_frame", url: "https://cdn.example.com/canvas-first.webp" },
            { type: "image", role: "last_frame", url: "https://cdn.example.com/canvas-last.webp" },
        ]);
        const retryButton = page.getByRole("button", { name: "重试" });
        await expect(retryButton).toBeVisible({ timeout: 20_000 });

        settingsTrigger = page.locator('[data-node-id="video-config"]').getByRole("button", { name: /^视频设置：首尾帧/ });
        await settingsTrigger.click();
        settings = page.locator("[data-canvas-video-reference-settings]");
        await settings.getByRole("button", { name: "视频参考模式：普通参考" }).click();
        settingsTrigger = page.locator('[data-node-id="video-config"]').getByRole("button", { name: /^视频设置：普通参考/ });
        await settingsTrigger.click();
        await expect(settings).toBeHidden();

        await retryButton.click();
        await expect.poll(() => submitted.length).toBe(2);
        expect(submitted[1].prompt).toBe(submitted[0].prompt);
        expect(submitted[1].references).toEqual(submitted[0].references);
        expect(submitted[1].clientRequestId).not.toBe(submitted[0].clientRequestId);
        await expect
            .poll(async () => {
                const stored = await readCanvasProject(request, `/api/canvas/projects/${project.id}`);
                return stored.nodes.find((item) => item.type === "video")?.metadata?.videoReferences?.map((reference) => reference.role);
            })
            .toEqual(["first_frame", "last_frame"]);
    } finally {
        await deleteCanvasProject(request, project.id);
    }
});

test("canvas opens the Agent rail at the intended width and keeps a fresh chat after deletion", async ({ page, request }) => {
    const project = await createCanvasProject(request, {
        title: `Canvas Agent 面板 ${randomUUID().slice(0, 8)}`,
        nodes: [],
        connections: [],
        chatSessions: [
            {
                id: "agent-session",
                title: "待删除对话",
                messages: [{ id: "agent-message", role: "user", text: "删除后继续输入" }],
                createdAt: "2026-08-06T00:00:00.000Z",
                updatedAt: "2026-08-06T00:00:00.000Z",
            },
            {
                id: "agent-session-two",
                conversationId: "conversation-agent-two",
                title: "第二条对话",
                messages: [{ id: "agent-message-two", role: "user", text: "用于批量删除" }],
                createdAt: "2026-08-05T00:00:00.000Z",
                updatedAt: "2026-08-05T00:00:00.000Z",
            },
            {
                id: "agent-session-three",
                conversationId: "conversation-agent-three",
                title: "第三条对话",
                messages: [{ id: "agent-message-three", role: "user", text: "用于批量删除" }],
                createdAt: "2026-08-04T00:00:00.000Z",
                updatedAt: "2026-08-04T00:00:00.000Z",
            },
        ],
        activeChatId: "agent-session",
    });
    const deletedConversationIds: string[][] = [];
    let persistedAssistantSessions = project.chatSessions;

    try {
        const projectPath = `/api/canvas/projects/${project.id}`;
        await page.route(`**${projectPath}/assistant-conversations`, async (route) => {
            const body = route.request().postDataJSON() as { conversationIds: string[] };
            deletedConversationIds.push(body.conversationIds);
            const removed = new Set(body.conversationIds);
            persistedAssistantSessions = persistedAssistantSessions.filter((session) => !session.conversationId || !removed.has(session.conversationId));
            if (!persistedAssistantSessions.length) {
                persistedAssistantSessions = [{ id: "server-empty-session", title: "新对话", messages: [], createdAt: "2026-08-11T00:00:00.000Z", updatedAt: "2026-08-11T00:00:00.000Z" }];
            }
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({ code: 0, data: { deleted: body.conversationIds.length, chatSessions: persistedAssistantSessions, activeChatId: persistedAssistantSessions[0].id }, msg: "OK" }),
            });
        });
        await page.setViewportSize({ width: 1474, height: 900 });
        await page.goto(`/canvas/${project.id}`, { waitUntil: "domcontentloaded" });

        const panel = page.getByLabel("Canvas Agent 对话面板");
        await expect(panel).toBeVisible({ timeout: 20_000 });
        await expect.poll(async () => Math.round((await panel.boundingBox())?.width || 0)).toBe(404);
        await expect(page.getByRole("button", { name: "打开 Agent", exact: true })).toHaveCount(0);

        await page.getByRole("tab", { name: /历史/ }).click();
        await page.getByRole("button", { name: "修改标题：待删除对话" }).click();
        await page.getByRole("textbox", { name: "编辑对话标题" }).fill("已修改标题");
        await page.getByRole("textbox", { name: "编辑对话标题" }).press("Enter");
        await expect(page.getByText("已修改标题", { exact: true })).toBeVisible();
        await expect.poll(async () => (await readCanvasProject(request, projectPath)).chatSessions.find((session) => session.id === "agent-session")?.title).toBe("已修改标题");

        await page.getByRole("checkbox", { name: "选择对话：第二条对话" }).check();
        await page.getByRole("checkbox", { name: "选择对话：第三条对话" }).check();
        await page.getByRole("button", { name: "删除所选 (2)" }).click();
        let deleteDialog = page.getByRole("dialog", { name: "删除对话记录？" });
        await deleteDialog.getByRole("button", { name: /删\s*除/ }).click();
        await expect(page.getByText("第二条对话", { exact: true })).toHaveCount(0);
        await expect(page.getByText("第三条对话", { exact: true })).toHaveCount(0);
        expect(deletedConversationIds).toEqual([["conversation-agent-two", "conversation-agent-three"]]);
        await expect.poll(() => readCanvasChatState(request, projectPath)).toEqual({ sessions: 1, messages: 1 });

        await page.getByRole("button", { name: "删除对话：已修改标题" }).click();
        deleteDialog = page.getByRole("dialog", { name: "删除对话记录？" });
        await deleteDialog.getByRole("button", { name: /删\s*除/ }).click();

        await expect(page.getByRole("tab", { name: "对话", exact: true })).toHaveAttribute("aria-selected", "true");
        await expect(page.getByPlaceholder("描述你想让 Agent 如何操作画布")).toBeVisible();
        await expect(page.getByText("你好，我是你的画布助手", { exact: true })).toBeVisible();
        await expect.poll(() => page.locator("[data-canvas-agent-scroll]").evaluate((element) => element.scrollTop)).toBe(0);
        await expect.poll(() => readCanvasChatState(request, projectPath)).toEqual({ sessions: 1, messages: 0 });

        const generationPreferencesTrigger = panel.getByRole("button", { name: /生成参数：/ });
        await expect
            .poll(() => panel.locator("[data-canvas-agent-toolbar] button").evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label") || "")))
            .toEqual([expect.stringMatching(/^(选择创作 Skill|当前 Skill：)/), expect.stringMatching(/^智能规划.*点击/), expect.stringMatching(/^(选择生成模型|已选择 \d+ 个模型)$/), expect.stringMatching(/^生成参数：/), "发送"]);
        await expect.poll(async () => Math.round((await generationPreferencesTrigger.boundingBox())?.width || 0)).toBeLessThanOrEqual(116);
        await generationPreferencesTrigger.click();
        const generationPreferencesPanel = page.locator("[data-creative-generation-preferences]");
        await expect(generationPreferencesPanel).toBeVisible();
        await expect.poll(async () => Math.round((await generationPreferencesPanel.boundingBox())?.width || 0)).toBe(280);
        await expect
            .poll(async () => {
                const bounds = await generationPreferencesPanel.boundingBox();
                return bounds ? bounds.x >= 0 && bounds.x + bounds.width <= 1475 : false;
            })
            .toBe(true);
        await generationPreferencesTrigger.click();

        await page.getByRole("button", { name: "收起 Agent 面板" }).click();
        await expect(page.getByRole("button", { name: "打开 Agent", exact: true })).toBeVisible();
    } finally {
        await deleteCanvasProject(request, project.id);
    }
});

test("canvas Agent toolbar stays ordered and its generation settings fit narrow viewports", async ({ page, request }) => {
    const project = await createCanvasProject(request, { title: `Canvas 参数布局 ${randomUUID().slice(0, 8)}`, nodes: [], connections: [] });

    try {
        await page.addInitScript(() => localStorage.setItem("octalaicanvas:theme_store", JSON.stringify({ state: { theme: "light" }, version: 0 })));

        for (const width of [390, 430]) {
            await page.setViewportSize({ width, height: width === 390 ? 844 : 932 });
            await page.goto(`/canvas/${project.id}`, { waitUntil: "domcontentloaded" });
            await page.getByRole("button", { name: "打开 Agent", exact: true }).click();
            const panel = page.getByLabel("Canvas Agent 对话面板");
            const textarea = panel.getByRole("textbox", { name: "描述你想让 Agent 如何操作画布" });
            const trigger = panel.getByRole("button", { name: /生成参数：/ });
            await expect(panel).toBeVisible({ timeout: 20_000 });
            await expect.poll(async () => Math.round((await textarea.boundingBox())?.height || 0)).toBeGreaterThanOrEqual(80);
            await expect.poll(async () => Math.round((await trigger.boundingBox())?.width || 0)).toBeLessThanOrEqual(116);
            await expect
                .poll(() => panel.locator("[data-canvas-agent-toolbar] button").evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label") || "")))
                .toEqual([expect.stringMatching(/^(选择创作 Skill|当前 Skill：)/), expect.stringMatching(/^智能规划.*点击/), expect.stringMatching(/^(选择生成模型|已选择 \d+ 个模型)$/), expect.stringMatching(/^生成参数：/), "发送"]);
            await expect
                .poll(async () => {
                    const controls = panel.locator("[data-creative-agent-controls='compact']");
                    const toolBoxes = await controls.locator(":scope > button, :scope > * > button").evaluateAll((buttons) =>
                        buttons.slice(0, 4).map((button) => {
                            const bounds = button.getBoundingClientRect();
                            return { left: bounds.left, right: bounds.right };
                        }),
                    );
                    const triggerBox = await trigger.boundingBox();
                    return {
                        leftToolGaps: toolBoxes.slice(1).map((box, index) => Math.round(box.left - toolBoxes[index].right)),
                        parameterAfterModel: toolBoxes[3] && toolBoxes[2] ? Math.round(toolBoxes[3].left - toolBoxes[2].right) : null,
                        parameterX: triggerBox ? Math.round(triggerBox.x) : null,
                    };
                })
                .toMatchObject({ leftToolGaps: [4, 4, 8], parameterAfterModel: 8 });
            await expect
                .poll(() =>
                    trigger
                        .locator("span")
                        .first()
                        .evaluate((element) => ({
                            text: element.textContent || "",
                            clipped: element.scrollWidth > element.clientWidth,
                            overflow: getComputedStyle(element).overflow,
                            textOverflow: getComputedStyle(element).textOverflow,
                        })),
                )
                .toMatchObject({ clipped: false, overflow: "visible", textOverflow: "clip" });

            await trigger.click();
            const visiblePreferencesPanel = page.locator("[data-creative-generation-preferences]:visible");
            await expect(visiblePreferencesPanel).toBeVisible();
            await expect.poll(async () => Math.round((await visiblePreferencesPanel.boundingBox())?.width || 0)).toBe(280);
            await expect
                .poll(async () => {
                    const bounds = await visiblePreferencesPanel.boundingBox();
                    return bounds ? bounds.x >= 0 && bounds.x + bounds.width <= width + 1 : false;
                })
                .toBe(true);
            await expectNoHorizontalOverflow(page, `Canvas Agent 参数 ${width}px`);
            await trigger.click();
            await expect(trigger).toHaveAttribute("aria-expanded", "false");
            await expect(page.locator("[data-creative-generation-preferences]:visible")).toHaveCount(0);
        }

        await page.getByRole("button", { name: "收起 Agent 面板" }).click();
        await page.getByRole("button", { name: "切换到深色主题" }).click();
        await expect(page.locator("html")).toHaveClass(/dark/);
        await page.getByRole("button", { name: "打开 Agent", exact: true }).click();
        const darkTrigger = page.getByLabel("Canvas Agent 对话面板").getByRole("button", { name: /生成参数：/ });
        await darkTrigger.click();
        const darkPanel = page.locator("[data-creative-generation-preferences]:visible");
        await expect(darkPanel).toBeVisible();
        await expect.poll(async () => Math.round((await darkPanel.boundingBox())?.width || 0)).toBe(280);
        await expectNoHorizontalOverflow(page, "Canvas Agent 参数深色主题");
    } finally {
        await deleteCanvasProject(request, project.id);
    }
});

test("canvas keeps project chat state isolated during client-side project navigation", async ({ page, request }) => {
    const project = await createCanvasProject(request, {
        title: `Canvas 会话隔离 ${randomUUID().slice(0, 8)}`,
        nodes: [],
        connections: [],
        chatSessions: [
            {
                id: "source-session",
                title: "只属于原画布",
                messages: [{ id: "source-message", role: "user", text: "这条消息不能进入新画布" }],
                createdAt: "2026-08-11T00:00:00.000Z",
                updatedAt: "2026-08-11T00:00:00.000Z",
            },
        ],
        activeChatId: "source-session",
    });
    let createdProjectId = "";

    try {
        await page.goto(`/canvas/${project.id}`, { waitUntil: "domcontentloaded" });
        await expect(page.getByText("这条消息不能进入新画布", { exact: true })).toBeVisible({ timeout: 20_000 });
        await page.getByRole("button", { name: "打开资产面板" }).click();
        await page.getByRole("button", { name: "新建画布" }).click();
        await expect.poll(() => new URL(page.url()).pathname.split("/").pop()).not.toBe(project.id);
        createdProjectId = new URL(page.url()).pathname.split("/").pop() || "";

        await expect(page.getByText("你好，我是你的画布助手", { exact: true })).toBeVisible({ timeout: 20_000 });
        await expect(page.getByText("这条消息不能进入新画布", { exact: true })).toHaveCount(0);
        await expect.poll(async () => (await readCanvasProject(request, `/api/canvas/projects/${createdProjectId}`)).chatSessions).toEqual([]);
    } finally {
        await deleteCanvasProject(request, project.id);
        if (createdProjectId) await deleteCanvasProject(request, createdProjectId);
    }
});

test("canvas separates project management from the command menu and keeps assets in a four-column rail", async ({ page, request }) => {
    const targetTitle = `Canvas 切换目标 ${randomUUID().slice(0, 8)}`;
    const target = await createCanvasProject(request, { title: targetTitle, nodes: [], connections: [] });
    const project = await createCanvasProject(request, {
        title: `Canvas 资产侧栏 ${randomUUID().slice(0, 8)}`,
        nodes: Array.from({ length: 5 }, (_, index) => node(`asset-${index + 1}`, "image", index * 180, 120, 160, 120, { content: "/logo.svg", naturalWidth: 160, naturalHeight: 120 })),
        connections: [],
    });

    try {
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.goto(`/canvas/${project.id}`, { waitUntil: "domcontentloaded" });
        const surface = page.locator("[data-canvas-surface]");
        await expect(surface).toBeVisible({ timeout: 20_000 });
        await expectCanvasSaved(page);
        await expect(page.getByLabel("画布已保存")).toHaveCount(0);

        await page.getByRole("button", { name: "打开画布菜单" }).click();
        await expect(page.getByRole("menuitem", { name: "导入素材" })).toBeVisible();
        await expect(page.getByRole("menuitem", { name: "资产面板" })).toHaveCount(0);
        await expect(page.getByRole("menuitem", { name: "删除画布" })).toBeVisible();
        await expect(page.getByRole("menuitem", { name: "新建画布" })).toHaveCount(0);
        await expect(page.getByRole("menuitem", { name: "我的画布" })).toHaveCount(0);
        await page.getByRole("button", { name: "打开画布菜单" }).click();

        const closedWidth = (await surface.boundingBox())?.width || 0;
        await page.getByRole("button", { name: "打开资产面板" }).click();
        const panel = page.getByLabel("Canvas 资产面板");
        await expect(panel).toBeVisible();
        await expect.poll(async () => closedWidth - ((await surface.boundingBox())?.width || 0)).toBeGreaterThan(300);

        const cards = panel.locator('[data-testid="canvas-current-assets-grid"] > article');
        await expect(cards).toHaveCount(5);
        const cardBoxes = await cards.evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect()).map(({ left, top, width }) => ({ left, top, width })));
        expect(new Set(cardBoxes.slice(0, 4).map((box) => Math.round(box.top))).size).toBe(1);
        expect(cardBoxes.slice(0, 4).map((box) => Math.round(box.left))).toEqual([...cardBoxes.slice(0, 4).map((box) => Math.round(box.left))].sort((a, b) => a - b));
        expect(cardBoxes[4].top).toBeGreaterThan(cardBoxes[0].top + cardBoxes[0].width);
        await expect(panel.getByText("asset-1", { exact: true })).toHaveCount(0);
        await expect(panel.getByRole("button", { name: "定位asset-1" })).toBeVisible();

        await panel.getByRole("button", { name: "切换画布" }).click();
        await page.getByRole("menuitem").filter({ hasText: targetTitle }).click();
        await expect.poll(() => new URL(page.url()).pathname).toBe(`/canvas/${target.id}`);

        for (const width of [390, 430]) {
            await page.setViewportSize({ width, height: width === 390 ? 844 : 932 });
            await page.goto(`/canvas/${project.id}`, { waitUntil: "domcontentloaded" });
            await expect(surface).toBeVisible({ timeout: 20_000 });
            const topbarGeometry = await page.locator(".canvas-topbar").evaluate((topbar) => {
                const title = topbar.querySelector<HTMLElement>(".canvas-topbar-title");
                const assets = topbar.querySelector<HTMLElement>('[aria-label="打开资产面板"], [aria-label="关闭资产面板"]');
                const actions = topbar.querySelector<HTMLElement>(".canvas-topbar-actions");
                const controls = actions ? Array.from(actions.querySelectorAll<HTMLElement>("button, a")).filter((control) => getComputedStyle(control).display !== "none") : [];
                const bounds = (element: Element | null) => {
                    if (!element) return null;
                    const rect = element.getBoundingClientRect();
                    return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
                };
                return {
                    viewportWidth: window.innerWidth,
                    documentWidth: document.documentElement.scrollWidth,
                    title: bounds(title),
                    assets: bounds(assets),
                    actions: bounds(actions),
                    controls: controls.map((control) => bounds(control)),
                };
            });
            expect(topbarGeometry.documentWidth).toBeLessThanOrEqual(width + 1);
            expect(topbarGeometry.title).not.toBeNull();
            expect(topbarGeometry.assets).not.toBeNull();
            expect(topbarGeometry.actions).not.toBeNull();
            expect(topbarGeometry.title!.width).toBeGreaterThanOrEqual(80);
            expect(topbarGeometry.assets!.width).toBeGreaterThanOrEqual(30);
            expect(topbarGeometry.title!.right).toBeLessThanOrEqual(topbarGeometry.assets!.left + 1);
            expect(topbarGeometry.title!.right).toBeLessThanOrEqual(topbarGeometry.actions!.left + 1);
            expect(topbarGeometry.controls.every((control) => control && control.left >= -1 && control.right <= topbarGeometry.viewportWidth + 1)).toBe(true);

            if (width === 390) {
                await page.getByRole("button", { name: "打开资产面板" }).click();
                const mobilePanel = page.getByLabel("Canvas 资产面板");
                await expect(mobilePanel).toBeVisible();
                await expect.poll(async () => (await mobilePanel.boundingBox())?.x ?? Number.NEGATIVE_INFINITY, { timeout: 3_000 }).toBeGreaterThanOrEqual(-1);
                const mobileBounds = await mobilePanel.boundingBox();
                expect(mobileBounds).not.toBeNull();
                expect(mobileBounds!.x).toBeGreaterThanOrEqual(0);
                expect(mobileBounds!.x + mobileBounds!.width).toBeLessThanOrEqual(width + 1);
                await expectNoHorizontalOverflow(page, "Canvas 资产侧栏 390px");
            }
        }
    } finally {
        await deleteCanvasProject(request, project.id);
        await deleteCanvasProject(request, target.id);
    }
});

test("canvas Agent keeps simultaneous runs bound to separate chats", async ({ page, request }) => {
    const project = await createCanvasProject(request, { title: `Canvas Agent 运行隔离 ${randomUUID().slice(0, 8)}`, nodes: [], connections: [] });
    const createBodies: Array<Record<string, unknown>> = [];
    const runs = new Map<string, Record<string, unknown>>();

    await page.route("**/api/agent/runs?**", async (route) => {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ code: 0, data: { runs: [] }, msg: "OK" }) });
    });
    await page.route("**/api/agent/runs", async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        const body = route.request().postDataJSON() as Record<string, unknown>;
        createBodies.push(body);
        const index = createBodies.length;
        const run = {
            id: `run-${index}`,
            conversationId: `conversation-${index}`,
            inputMessageId: `input-${index}`,
            assistantMessageId: `assistant-${index}`,
            status: "running",
            surface: "canvas",
            projectId: project.id,
            assetIds: [],
            tasks: [],
        };
        runs.set(run.id, run);
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ code: 0, data: { run, created: true }, msg: "OK" }) });
    });
    await page.route(/\/api\/agent\/runs\/run-\d+$/, async (route) => {
        const runId = new URL(route.request().url()).pathname.split("/").pop() || "";
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ code: 0, data: { run: runs.get(runId) }, msg: "OK" }) });
    });
    await page.route(/\/api\/agent\/runs\/run-\d+\/events$/, async (route) => {
        await route.fulfill({ status: 200, contentType: "text/event-stream", body: 'event: run.planning\ndata: {"data":{}}\n\n' });
    });

    try {
        await page.goto(`/canvas/${project.id}`, { waitUntil: "domcontentloaded" });
        const composer = page.getByPlaceholder("描述你想让 Agent 如何操作画布");
        await expect(composer).toBeVisible({ timeout: 20_000 });
        await composer.fill("第一条后台任务");
        await page.getByRole("button", { name: "发送" }).click();
        await expect.poll(() => createBodies.length).toBe(1);

        await page.getByRole("button", { name: "新建对话" }).click();
        await expect(composer).toBeEnabled();
        await composer.fill("第二条后台任务");
        await page.getByRole("button", { name: "发送" }).click();
        await expect.poll(() => createBodies.length).toBe(2);

        expect(createBodies.map((body) => body.conversationId)).toEqual([undefined, undefined]);
        await expect
            .poll(async () => {
                const sessions = (await readCanvasProject(request, `/api/canvas/projects/${project.id}`)).chatSessions;
                return sessions
                    .map((session) => session.conversationId)
                    .filter(Boolean)
                    .sort();
            })
            .toEqual(["conversation-1", "conversation-2"]);

        await page.getByRole("tab", { name: /历史/ }).click();
        await page.getByRole("button", { name: "进入对话：第一条后台任务" }).click();
        await expect(page.getByText(/正在理解需求并分析当前画布|任务仍在后台运行/)).toBeVisible();
        await expect(page.getByText("第一条后台任务", { exact: true })).toBeVisible();
    } finally {
        await deleteCanvasProject(request, project.id);
    }
});

test("canvas remains operable with 2000 nodes and 5000 connections", async ({ page, request }, testInfo) => {
    test.setTimeout(120_000);
    const nodes = Array.from({ length: 2_000 }, (_, index) => node(`perf-node-${index}`, index % 9 === 0 ? "config" : "text", (index % 50) * 320, Math.floor(index / 50) * 240, 240, 160, { content: `节点 ${index}` }));
    const connections = Array.from({ length: 5_000 }, (_, index) => {
        const sourceIndex = (index * 17) % 2_000;
        let targetIndex = (index * 37 + 1) % 2_000;
        if (targetIndex === sourceIndex) targetIndex = (targetIndex + 1) % 2_000;
        return { id: `perf-edge-${index}`, fromNodeId: `perf-node-${sourceIndex}`, toNodeId: `perf-node-${targetIndex}` };
    });
    const project = await createCanvasProject(request, { title: `Canvas 性能回归 ${randomUUID().slice(0, 8)}`, viewport: { x: 80, y: 100, k: 1 }, nodes, connections });

    try {
        const startedAt = Date.now();
        await page.goto(`/canvas/${project.id}`, { waitUntil: "domcontentloaded" });
        await expect(page.locator("[data-canvas-surface]")).toBeVisible({ timeout: 20_000 });
        await expect(page.locator('[data-node-id="perf-node-0"]')).toBeVisible();
        const interactiveMs = Date.now() - startedAt;
        const renderedNodeCount = await page.locator("[data-node-id]").count();
        expect(renderedNodeCount).toBeGreaterThan(0);
        expect(renderedNodeCount).toBeLessThan(2_000);

        const surface = page.locator("[data-canvas-surface]");
        const bounds = await surface.boundingBox();
        expect(bounds).not.toBeNull();
        const navigationStartedAt = Date.now();
        await page.mouse.move(bounds!.x + bounds!.width - 35, bounds!.y + bounds!.height - 35);
        await page.mouse.down();
        await page.mouse.move(bounds!.x + bounds!.width - 155, bounds!.y + bounds!.height - 95, { steps: 8 });
        await page.mouse.up();
        await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        const navigationMs = Date.now() - navigationStartedAt;
        await page.waitForTimeout(500);
        await expectCanvasSaved(page);

        const saveStartedAt = Date.now();
        const firstNode = page.locator('[data-node-id="perf-node-0"]');
        const firstBounds = await firstNode.boundingBox();
        expect(firstBounds).not.toBeNull();
        const patchRequest = page.waitForRequest((request) => request.method() === "PATCH" && new URL(request.url()).pathname === `/api/canvas/projects/${project.id}`);
        await page.mouse.move(firstBounds!.x + 80, firstBounds!.y + 16);
        await page.mouse.down();
        await page.mouse.move(firstBounds!.x + 125, firstBounds!.y + 41, { steps: 6 });
        await page.mouse.up();
        await patchRequest;
        await expectCanvasSaved(page, 10_000);
        const saveMs = Date.now() - saveStartedAt;

        const metrics = { nodes: nodes.length, connections: connections.length, interactiveMs, navigationMs, saveMs, renderedNodeCount };
        await testInfo.attach("canvas-performance.json", { body: JSON.stringify(metrics, null, 2), contentType: "application/json" });
        expect(interactiveMs).toBeLessThan(20_000);
        expect(navigationMs).toBeLessThan(1_500);
        expect(saveMs).toBeLessThan(10_000);
    } finally {
        await deleteCanvasProject(request, project.id);
    }
});

test("canvas restores all nine node types and opens text editing on a single click", async ({ page, request }, testInfo) => {
    const project = await createCanvasProject(request, {
        title: `Canvas 节点矩阵 ${randomUUID().slice(0, 8)}`,
        viewport: { x: 90, y: 80, k: 0.75 },
        nodes: [
            node("matrix-image", "image", 40, 80, 240, 180, { content: "/logo.svg", naturalWidth: 240, naturalHeight: 180 }),
            node("matrix-panorama", "panorama", 340, 80, 300, 150, { content: "/logo.svg", naturalWidth: 300, naturalHeight: 150 }),
            node("matrix-text", "text", 700, 80, 260, 180, { content: Array.from({ length: 18 }, (_, index) => `第${index + 1}段完整文本`).join("\n") }),
            node("matrix-config", "config", 1020, 80, 300, 180, { generationMode: "image", model: "" }),
            node("matrix-video", "video", 40, 360, 260, 170, { content: "/logo.svg", mimeType: "video/mp4" }),
            node("matrix-audio", "audio", 340, 360, 260, 150, { content: "/logo.svg", mimeType: "audio/mpeg" }),
            node("matrix-brief", "brief", 700, 340, 320, 210, { agentBrief: { objective: "节点矩阵目标", deliverables: [{ type: "image", title: "主视觉", count: 1 }] } }),
            node("matrix-task", "task", 40, 640, 300, 180, { prompt: "任务恢复内容", agentTaskStatus: "completed", agentTaskAttempts: 1 }),
            node("matrix-brand", "brand-kit", 420, 620, 320, 200, { brandKit: { summary: "品牌方向恢复", keywords: ["电影感"] } }),
        ],
        connections: [],
    });
    const nodeTypes = new Map([
        ["matrix-image", "image"],
        ["matrix-panorama", "panorama"],
        ["matrix-text", "text"],
        ["matrix-config", "config"],
        ["matrix-video", "video"],
        ["matrix-audio", "audio"],
        ["matrix-brief", "brief"],
        ["matrix-task", "task"],
        ["matrix-brand", "brand-kit"],
    ]);
    const expectNodeTheme = async (theme: "light" | "dark") => {
        const colors =
            theme === "light"
                ? { fill: "rgb(246, 247, 251)", panel: "rgb(255, 255, 255)", stroke: "rgb(226, 229, 239)", text: "rgb(32, 37, 50)", subtle: "rgb(248, 248, 251)", subtleText: "rgb(82, 88, 102)" }
                : { fill: "rgb(17, 19, 24)", panel: "rgb(15, 17, 21)", stroke: "rgb(48, 54, 66)", text: "rgb(248, 250, 252)", subtle: "rgb(26, 31, 39)", subtleText: "rgb(203, 213, 225)" };

        for (const [id, type] of nodeTypes) {
            const frame = page.locator(`[data-node-id="${id}"] > div`).first();
            const expectedBackground = type === "image" || type === "panorama" || type === "video" ? "rgba(0, 0, 0, 0)" : type === "config" ? colors.panel : colors.fill;
            await expect(frame, `${type} ${theme} border`).toHaveCSS("border-color", colors.stroke);
            await expect(frame, `${type} ${theme} background`).toHaveCSS("background-color", expectedBackground);
            await expect(frame, `${type} ${theme} text`).toHaveCSS("color", colors.text);
        }

        for (const chip of [page.locator('[data-node-id="matrix-brief"]').getByText("主视觉", { exact: true }), page.locator('[data-node-id="matrix-brand"]').getByText("电影感", { exact: true })]) {
            await expect(chip).toHaveCSS("background-color", colors.subtle);
            await expect(chip).toHaveCSS("border-color", colors.stroke);
            await expect(chip).toHaveCSS("color", colors.subtleText);
        }
    };

    try {
        await page.addInitScript(() => localStorage.setItem("octalaicanvas:theme_store", JSON.stringify({ state: { theme: "light" }, version: 0 })));
        await page.goto(`/canvas/${project.id}`, { waitUntil: "domcontentloaded" });
        await expect(page.locator("[data-canvas-surface]")).toBeVisible({ timeout: 20_000 });
        await expect.poll(async () => readCanvasViewport(request, `/api/canvas/projects/${project.id}`)).toEqual({ x: 90, y: 80, k: 0.75 });
        await expect(page.locator("[data-node-id]")).toHaveCount(9);
        await expect(page.locator('[data-node-id="matrix-brief"]').getByText("创作目标")).toBeVisible();
        await expect(page.locator('[data-node-id="matrix-brief"]').getByText("节点矩阵目标")).toBeVisible();
        await expect(page.locator('[data-node-id="matrix-task"]').getByText("任务恢复内容")).toBeVisible();
        await expect(page.locator('[data-node-id="matrix-brand"]').getByText("灵感与视觉方向")).toBeVisible();
        await expect(page.locator('[data-node-id="matrix-video"] video')).toBeVisible();
        await expect(page.locator('[data-node-id="matrix-audio"] audio')).toBeVisible();
        await expectNodeTheme("light");

        const textNode = page.locator('[data-node-id="matrix-text"]');
        await textNode.click({ position: { x: 50, y: 80 } });
        const textEditor = textNode.locator("textarea");
        await expect(textEditor).toBeVisible();
        await expect.poll(() => textEditor.evaluate((element) => document.activeElement === element)).toBe(true);
        await expect(textEditor).toHaveValue(/第1段完整文本[\s\S]*第18段完整文本/);
        expect(await textEditor.evaluate((element) => element.scrollTop)).toBe(0);
        const textNodeBounds = await textNode.boundingBox();
        const textEditorMetrics = await textEditor.evaluate((element) => {
            const wrapper = element.parentElement;
            const rect = element.getBoundingClientRect();
            const wrapperRect = wrapper?.getBoundingClientRect();
            return {
                height: rect.height,
                wrapperHeight: wrapperRect?.height ?? 0,
                clientHeight: element.clientHeight,
                scrollHeight: element.scrollHeight,
            };
        });
        expect(textNodeBounds).not.toBeNull();
        expect(textEditorMetrics.height).toBeGreaterThan(textNodeBounds!.height * 0.75);
        expect(textEditorMetrics.wrapperHeight).toBeGreaterThan(textNodeBounds!.height * 0.75);
        expect(textEditorMetrics.scrollHeight).toBeGreaterThan(textEditorMetrics.clientHeight);
        await textEditor.evaluate((element) => {
            element.scrollTop = element.scrollHeight;
        });
        await expect.poll(() => textEditor.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
        await textEditor.fill("单击后立即可编辑");

        await page.getByRole("button", { name: "文本操作菜单", exact: true }).click();
        await expect(page.getByRole("menuitem", { name: "编辑文本", exact: true })).toBeVisible();
        await expect(page.getByRole("menuitem", { name: "复制全文", exact: true })).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(page.getByRole("menuitem", { name: "编辑文本", exact: true })).toBeHidden();
        await textNode.getByRole("button", { name: "一键复制全文", exact: true }).click();
        await expect(page.getByText("文本已复制", { exact: true })).toBeVisible();
        await textNode.getByRole("button", { name: "展开文本", exact: true }).click();
        const expandedTextDialog = page.getByRole("dialog", { name: "展开编辑文本", exact: true });
        await expect(expandedTextDialog).toBeVisible();
        const expandedEditor = expandedTextDialog.getByRole("textbox", { name: "展开文本编辑器", exact: true });
        await expect(expandedEditor).toHaveValue("单击后立即可编辑");
        await expandedEditor.fill("展开编辑后保存完整内容");
        await expect.poll(() => expandedTextDialog.evaluate((element) => getComputedStyle(element).opacity)).toBe("1");
        await page.screenshot({ path: testInfo.outputPath("text-node-expanded-desktop.png") });
        await page.setViewportSize({ width: 390, height: 844 });
        await expect
            .poll(async () => {
                const bounds = await expandedTextDialog.boundingBox();
                return bounds ? bounds.x + bounds.width : Number.POSITIVE_INFINITY;
            })
            .toBeLessThanOrEqual(391);
        const mobileDialogBounds = await expandedTextDialog.boundingBox();
        expect(mobileDialogBounds).not.toBeNull();
        expect(mobileDialogBounds!.x).toBeGreaterThanOrEqual(0);
        expect(mobileDialogBounds!.x + mobileDialogBounds!.width).toBeLessThanOrEqual(391);
        await expectNoHorizontalOverflow(page, "文本节点展开编辑器 390px");
        await page.screenshot({ path: testInfo.outputPath("text-node-expanded-390.png") });
        await page.setViewportSize({ width: 1280, height: 720 });
        await expandedTextDialog.getByRole("button", { name: "收起", exact: true }).click();
        await expect(expandedTextDialog).toBeHidden();
        await expect(textNode.getByText("展开编辑后保存完整内容", { exact: true })).toBeVisible();
        await textNode.click({ position: { x: 28, y: 120 } });
        const selectedBorder = textNode.locator("[data-canvas-node-selection-flow] rect");
        await expect(selectedBorder).toHaveAttribute("x", "0.8");
        await expect(selectedBorder).toHaveAttribute("width", "98.4");
        await textNode.screenshot({ path: testInfo.outputPath("text-node-selected.png") });

        await page.reload({ waitUntil: "domcontentloaded" });
        await expect(page.locator('[data-node-id="matrix-text"]').getByText("展开编辑后保存完整内容")).toBeVisible();
        await page.getByRole("button", { name: "切换到深色主题" }).click();
        await expect(page.locator("html")).toHaveClass(/dark/);
        await expectNodeTheme("dark");
    } finally {
        await deleteCanvasProject(request, project.id);
    }
});

test("canvas Agent attachment remove badge stays compact and theme readable", async ({ page, request }) => {
    const project = await createCanvasProject(request, { title: `Canvas 删除角标 ${randomUUID().slice(0, 8)}`, nodes: [], connections: [] });

    try {
        await page.addInitScript(() => localStorage.setItem("octalaicanvas:theme_store", JSON.stringify({ state: { theme: "light" }, version: 0 })));
        await page.goto(`/canvas/${project.id}`, { waitUntil: "domcontentloaded" });
        const panel = page.getByRole("complementary", { name: "Canvas Agent 对话面板" });
        await expect(panel).toBeVisible({ timeout: 20_000 });
        await panel.locator('input[type="file"][multiple]').setInputFiles({
            name: "reference.png",
            mimeType: "image/png",
            buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl3kgAAAABJRU5ErkJggg==", "base64"),
        });

        const removeButton = panel.getByRole("button", { name: "移除参考素材：reference.png" });
        const badge = removeButton.locator(":scope > span");
        await expect(removeButton).toBeVisible({ timeout: 20_000 });
        await expect.poll(async () => (await removeButton.boundingBox())?.width).toBe(28);
        await expect.poll(async () => (await removeButton.boundingBox())?.height).toBe(28);
        await expect.poll(async () => (await badge.boundingBox())?.width).toBe(16);
        await expect.poll(async () => (await badge.boundingBox())?.height).toBe(16);
        const badgeGeometry = await removeButton.evaluate((button) => {
            const badgeElement = button.firstElementChild;
            const preview = button.parentElement;
            if (!badgeElement || !preview) return null;
            const badgeBounds = badgeElement.getBoundingClientRect();
            const previewBounds = preview.getBoundingClientRect();
            return {
                left: badgeBounds.left,
                top: badgeBounds.top,
                right: badgeBounds.right,
                bottom: badgeBounds.bottom,
                previewLeft: previewBounds.left,
                previewTop: previewBounds.top,
                previewRight: previewBounds.right,
                previewBottom: previewBounds.bottom,
            };
        });
        expect(badgeGeometry).not.toBeNull();
        expect(badgeGeometry!.left).toBeGreaterThanOrEqual(badgeGeometry!.previewLeft);
        expect(badgeGeometry!.top).toBeGreaterThanOrEqual(badgeGeometry!.previewTop);
        expect(badgeGeometry!.right).toBeLessThanOrEqual(badgeGeometry!.previewRight);
        expect(badgeGeometry!.bottom).toBeLessThanOrEqual(badgeGeometry!.previewBottom);
        await expect(badge).toHaveCSS("background-color", "rgba(255, 255, 255, 0.94)");
        await expect(badge).toHaveCSS("border-color", "rgba(15, 23, 42, 0.16)");
        await expect(badge).toHaveCSS("color", "rgb(71, 85, 105)");
        await expect.poll(() => badge.evaluate((element) => Number.parseFloat(getComputedStyle(element).borderRadius))).toBeGreaterThanOrEqual(10);

        await removeButton.hover();
        await expect(badge).toHaveCSS("background-color", "rgb(255, 241, 242)");
        await expect(badge).toHaveCSS("color", "rgb(220, 38, 38)");
        await panel.getByRole("textbox", { name: "描述你想让 Agent 如何操作画布" }).click();
        await page.getByRole("button", { name: "切换到深色主题" }).click();
        await expect(page.locator("html")).toHaveClass(/dark/);
        await expect(badge).toHaveCSS("background-color", "rgba(15, 23, 42, 0.88)");
        await expect(badge).toHaveCSS("border-color", "rgba(255, 255, 255, 0.2)");
        await removeButton.press("ArrowDown");
        await expect.poll(() => removeButton.evaluate((element) => element.matches(":focus-visible"))).toBe(true);
        await expect(badge).toHaveCSS("background-color", "rgb(42, 18, 21)");
        await expect(badge).toHaveCSS("border-color", "rgb(127, 29, 29)");
        await expect(badge).toHaveCSS("color", "rgb(248, 113, 113)");

        for (const width of [390, 430]) {
            await page.setViewportSize({ width, height: width === 390 ? 844 : 932 });
            await removeButton.scrollIntoViewIfNeeded();
            const bounds = await removeButton.boundingBox();
            expect(bounds).not.toBeNull();
            expect(bounds!.x).toBeGreaterThanOrEqual(0);
            expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width + 1);
            await expectNoHorizontalOverflow(page, `Canvas 删除角标 ${width}px`);
        }

        await removeButton.click();
        await expect(removeButton).toHaveCount(0);
    } finally {
        await deleteCanvasProject(request, project.id);
    }
});

function node(id: string, type: string, x: number, y: number, width: number, height: number, metadata: Record<string, unknown>) {
    return { id, type, title: id, position: { x, y }, width, height, metadata };
}

async function createCanvasProject(request: APIRequestContext, project: Record<string, unknown>) {
    const response = await request.post("/api/canvas/projects", { data: { title: project.title, project } });
    expect(response.ok(), await response.text()).toBe(true);
    return ((await response.json()) as { data: { project: { id: string } } }).data.project;
}

async function deleteCanvasProject(request: APIRequestContext, id: string) {
    const response = await request.delete("/api/canvas/projects", { data: { ids: [id] } });
    expect(response.ok(), await response.text()).toBe(true);
}

async function readCanvasNodeCount(request: APIRequestContext, path: string) {
    const response = await request.get(path);
    expect(response.ok(), await response.text()).toBe(true);
    return ((await response.json()) as { data: { project: { nodes: unknown[] } } }).data.project.nodes.length;
}

async function readCanvasViewport(request: APIRequestContext, path: string) {
    const response = await request.get(path);
    expect(response.ok(), await response.text()).toBe(true);
    return ((await response.json()) as { data: { project: { viewport: { x: number; y: number; k: number } } } }).data.project.viewport;
}

async function readCanvasProject(request: APIRequestContext, path: string) {
    const response = await request.get(path);
    expect(response.ok(), await response.text()).toBe(true);
    return (
        (await response.json()) as {
            data: {
                project: {
                    nodes: Array<{
                        id: string;
                        type: string;
                        position: { x: number; y: number };
                        width: number;
                        height: number;
                        metadata?: {
                            configKind?: string;
                            sourcePrompt?: string;
                            status?: string;
                            videoReferenceMode?: string;
                            videoFirstFrame?: { nodeId?: string };
                            videoLastFrame?: { nodeId?: string };
                            videoReferences?: Array<{ role: string }>;
                        };
                    }>;
                    connections: Array<{ id: string; fromNodeId: string; toNodeId: string }>;
                };
            };
        }
    ).data.project;
}

async function readCanvasChatState(request: APIRequestContext, path: string) {
    const response = await request.get(path);
    expect(response.ok(), await response.text()).toBe(true);
    const sessions = ((await response.json()) as { data: { project: { chatSessions: { messages: unknown[] }[] } } }).data.project.chatSessions;
    return { sessions: sessions.length, messages: sessions.reduce((count, session) => count + session.messages.length, 0) };
}

async function dragConnection(page: Page, sourceNode: Locator, targetNode: Locator) {
    const targetBounds = await targetNode.boundingBox();
    expect(targetBounds).not.toBeNull();
    await dragConnectionToPoint(page, sourceNode, targetBounds!.x + targetBounds!.width / 2, targetBounds!.y + targetBounds!.height / 2);
}

async function dragConnectionToPoint(page: Page, sourceNode: Locator, targetX: number, targetY: number) {
    await sourceNode.hover();
    const handle = sourceNode.locator('[data-canvas-handle="source"]');
    const bounds = await handle.boundingBox();
    expect(bounds).not.toBeNull();
    await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2);
    await page.mouse.down();
    await page.mouse.move(targetX, targetY, { steps: 8 });
    await page.mouse.up();
}

async function dragSelectionBox(page: Page, nodes: Locator) {
    const boxes = await nodes.evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect()).map(({ left, top, right, bottom }) => ({ left, top, right, bottom })));
    expect(boxes.length).toBeGreaterThan(0);
    const bounds = boxes.reduce((current, box) => ({ left: Math.min(current.left, box.left), top: Math.min(current.top, box.top), right: Math.max(current.right, box.right), bottom: Math.max(current.bottom, box.bottom) }), {
        left: Infinity,
        top: Infinity,
        right: -Infinity,
        bottom: -Infinity,
    });
    await page.mouse.move(bounds.left - 16, bounds.top - 16);
    await page.mouse.down();
    await page.mouse.move(bounds.right + 16, bounds.bottom + 16, { steps: 10 });
    await page.mouse.up();
}

async function expectSelectedNodeCount(page: Page, count: number) {
    await expect(page.locator("[data-canvas-node-selection-flow]")).toHaveCount(count);
}

async function expectCanvasSaved(page: Page, timeout = 5_000) {
    await expect(page.locator(".canvas-topbar")).toHaveAttribute("data-save-status", "saved", { timeout });
}

async function expectNoHorizontalOverflow(page: Page, label: string) {
    const widths = await page.evaluate(() => ({ clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth }));
    expect(widths.scrollWidth, `${label} document overflow`).toBeLessThanOrEqual(widths.clientWidth + 1);
}
