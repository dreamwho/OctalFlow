import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { e2eSettingsPatch, protocolFixtureState, resetProtocolFixture } from "./support";

const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p7sAAAAASUVORK5CYII=";
type TestLogicalModel = { id: string; fallbackModelId?: string; [key: string]: unknown };
type TestChannel = { id: string; advancedConfig?: { cancelPath?: string; cancelMethod?: string } };
type TestSettings = { logicalModels: TestLogicalModel[]; defaultModels: Record<string, string>; systemChannels: TestChannel[] };

test.beforeAll(async ({ request }) => {
    const response = await request.patch("/api/admin/settings", { data: e2eSettingsPatch() });
    expect(response.ok(), await response.text()).toBe(true);
});

test("workbench reference add entry remains visible and unclipped on narrow screens", async ({ page }) => {
    await workbenchMocks(page);
    for (const width of [320, 390, 430]) {
        await page.setViewportSize({ width, height: 844 });
        await page.goto("/create?mode=image");
        const workbench = page.locator('[data-testid="image-video-workbench"]:visible').first();
        const add = workbench.getByRole("button", { name: /添加参考图片|继续添加参考素材/ });
        await expect(add).toBeVisible();
        await expect(add).toBeEnabled();
        await add.click();
        const dialog = page.getByRole("dialog", { name: "添加参考图片" });
        await expect(dialog).toBeVisible();
        await dialog.locator("#workbench-reference-file").setInputFiles(Array.from({ length: 5 }, (_, index) => ({
            name: `reference-${index}.png`, mimeType: "image/png", buffer: Buffer.from(png.split(",")[1], "base64"),
        })));
        await expect(dialog).toBeHidden();
        await expect(workbench.locator("[class*=\"referencePreview\"]")).toHaveCount(5);
        await workbench.locator("[class*=\"referenceItems\"]").evaluate((element) => { element.scrollLeft = element.scrollWidth; });
        const geometry = await page.evaluate(() => {
            const add = document.querySelector<HTMLElement>("button[class*=\"referenceButton\"]")!;
            const strip = add.closest<HTMLElement>("[class*=\"referenceItems\"]")!;
            const rect = add.getBoundingClientRect();
            const parent = strip.getBoundingClientRect();
            return { left: rect.left, right: rect.right, parentLeft: parent.left, parentRight: parent.right, scrollLeft: strip.scrollLeft, scrollWidth: document.documentElement.scrollWidth };
        });
        expect(geometry.left).toBeGreaterThanOrEqual(geometry.parentLeft - 1);
        expect(geometry.right).toBeLessThanOrEqual(geometry.parentRight + 1);
        expect(geometry.scrollLeft).toBeGreaterThan(0);
        expect(geometry.scrollWidth).toBeLessThanOrEqual(width + 1);
        await add.click();
        await expect(dialog).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(dialog).toBeHidden();
        if (width === 390 || width === 430) await saveEvidence(workbench, `references-${width}.png`);
    }
});

test("admin fallback selection persists through save, refresh and API reread", async ({ page, request }) => {
    const before = await readSettings(request);
    const primary = before.logicalModels.find((item) => item.id === "e2e-image");
    if (!primary) throw new Error("E2E image model must be installed by the setup project");
    expect(before.logicalModels.some((item) => item.id === "e2e-image-fallback")).toBe(true);
    try {
        await page.goto("/admin?section=channels");
        await expect(page.locator('.admin-dashboard-shell[data-hydrated="true"]:visible')).toHaveCount(1);
        await page.getByRole("tab", { name: "逻辑模型", exact: true }).click();
        await page.getByRole("button", { name: "编辑 e2e-image", exact: true }).click();
        await page.getByRole("combobox", { name: "备用逻辑模型" }).click();
        await page.locator(".ant-select-dropdown:visible").getByText("e2e-image-fallback（e2e-image-fallback）", { exact: true }).click();
        await expect(page.getByText("备用逻辑模型", { exact: true }).locator("xpath=..")).toContainText("e2e-image-fallback");
        const saved = page.waitForResponse((response) => response.request().method() === "PATCH" && new URL(response.url()).pathname === "/api/admin/settings");
        await page.getByRole("button", { name: "应用修改", exact: true }).click();
        expect((await saved).ok()).toBe(true);
        await page.reload();
        await page.getByRole("tab", { name: "逻辑模型", exact: true }).click();
        await page.getByRole("button", { name: "编辑 e2e-image", exact: true }).click();
        const fallbackField = page.getByText("备用逻辑模型", { exact: true }).locator("xpath=..");
        await expect(fallbackField).toContainText("e2e-image-fallback");
        expect((await readSettings(request)).logicalModels.find((item) => item.id === "e2e-image")?.fallbackModelId).toBe("e2e-image-fallback");
    } finally {
        const latest = await readSettings(request);
        const restore = await request.patch("/api/admin/settings", { data: { logicalModels: latest.logicalModels.map((item) => item.id === "e2e-image" ? { ...item, fallbackModelId: primary!.fallbackModelId } : item) } });
        expect(restore.ok(), await restore.text()).toBe(true);
    }
});

test("regenerate restores the public request for success, failure, review and active cards without submitting", async ({ page }) => {
    const fixtures: Array<{ id: string; status: string; slot: { status: string; assetIndex?: number; needsReview?: boolean; displayPhase?: string } }> = [
        { id: "success", status: "success", slot: { status: "success", assetIndex: 0 } },
        { id: "failed", status: "error", slot: { status: "failed" } },
        { id: "review", status: "pending", slot: { status: "pending", needsReview: true } },
        { id: "preparing", status: "pending", slot: { status: "pending", displayPhase: "preparing" } },
        { id: "running", status: "pending", slot: { status: "pending", displayPhase: "running" } },
    ].map(({ id, status, slot }) => ({
        id: `image-workbench:${id}`, kind: "image", status, title: `卡片 ${id}`, prompt: `卡片 ${id}`,
        model: "e2e-image", assets: slot.assetIndex === 0 ? [{ type: "image", url: "/design/home/aurora-background.webp", mimeType: "image/webp", width: 16, height: 9 }] : [],
        requestSnapshot: {
            version: 1, userPrompt: `公开提示 ${id}`, parameters: { model: "e2e-image", size: "3:4", quality: "medium" },
            references: [{ id: `ref-${id}`, kind: "image", name: `参考 ${id}`, url: "/design/home/aurora-background.webp", mimeType: "image/webp", width: 16, height: 9 }],
            slots: [{ id: `slot-${id}`, index: 0, assetIndex: slot.assetIndex, status: slot.status, needsReview: slot.needsReview, displayPhase: slot.displayPhase, parameters: { size: "3:4", quality: "medium" } }],
        }, createdAt: "2026-10-01T00:00:00.000Z", durationMs: 1000,
    }));
    await page.route("**/api/generation-logs**", (route) => route.fulfill({ json: { items: new URL(route.request().url()).searchParams.get("kind") === "image" ? fixtures : [] } }));
    await page.route("**/api/library-assets**", (route) => route.fulfill({ json: { code: 0, data: { assets: [], total: 0, page: 1, pageSize: 100 }, msg: "OK" } }));
    await page.route("**/api/model-generation-stats", (route) => route.fulfill({ json: { data: {} } }));
    const submissions: string[] = [];
    page.on("request", (request) => {
        if (request.method() === "POST" && ["/api/image-tasks", "/api/video-generation-tasks"].includes(new URL(request.url()).pathname)) submissions.push(request.url());
    });
    await page.goto("/create?mode=image");
    const workbench = page.locator('[data-testid="image-video-workbench"]:visible').first();
    for (const fixture of fixtures) {
        await test.step(`restore ${fixture.id}`, async () => {
            await page.reload();
            const card = workbench.locator(`article[data-record-id="${fixture.id}"]`);
            await expect(card).toBeVisible();
            await card.getByRole("button", { name: "生成结果操作" }).click();
            const regenerate = page.locator(".ant-dropdown:visible").last().getByRole("menuitem", { name: "重新生成" });
            await expect(regenerate).toBeVisible();
            await regenerate.click();
            await expect(page.locator("#workbench-prompt")).toContainText(`公开提示 ${fixture.id.split(":")[1]}`);
            await expect(workbench.locator("[class*=\"referencePreview\"]")).toHaveCount(1);
            await expect(page.getByRole("button", { name: /当前模型：e2e-image/ })).toBeVisible();
            await expect(page.getByRole("button", { name: "图片比例：3:4" })).toBeVisible();
            await expect(page.getByRole("button", { name: "画质：中 · 2K" })).toBeVisible();
        });
    }
    expect(submissions).toEqual([]);
});

test("workbench image fallback requires confirmation and cancel submits no second task", async ({ page }) => {
    await page.route("**/api/models/fallback**", (route) => route.fulfill({ json: { code: 0, data: { id: "e2e-image-fallback", name: "e2e-image-fallback" }, msg: "OK" } }));
    await workbenchMocks(page);
    const submissions: Array<Record<string, unknown>> = [];
    const statusReads = { value: 0 };
    await page.route("**/api/generation-logs**", (route) => {
        if (route.request().method() === "GET") return route.fulfill({ json: { items: [] } });
        return route.fulfill({ json: {} });
    });
    await page.route("**/api/image-tasks", async (route) => {
        submissions.push(await route.request().postDataJSON());
        return route.fulfill({ json: { task: { id: `fallback-image-${submissions.length}`, model: "e2e-image" } } });
    });
    await page.route("**/api/image-tasks/**", (route) => {
        statusReads.value += 1;
        return route.fulfill({ json: { task: { id: "task", status: "error", error: "模拟上游拒绝", canRetry: true } } });
    });
    await page.goto("/create?mode=image");
    await page.locator("#workbench-prompt").fill("确认前不得切换");
    await page.getByRole("button", { name: /^立即生成/ }).click();
    const modal = page.getByRole("dialog", { name: "切换备用模型？" });
    await expect(modal).toBeVisible();
    await expect(modal).toContainText("e2e-image-fallback");
    await saveEvidence(modal, "fallback-confirmation-modal.png");
    await modal.getByRole("button", { name: /取\s*消/ }).click();
    await expect(modal).toBeHidden();
    expect(submissions).toHaveLength(1);
    expect(statusReads.value).toBeGreaterThan(0);
});

test("workbench image fallback submits one fresh attempt only after confirmation", async ({ page }) => {
    await page.route("**/api/models/fallback**", (route) => route.fulfill({ json: { code: 0, data: { id: "e2e-image-fallback", name: "e2e-image-fallback" }, msg: "OK" } }));
    await workbenchMocks(page);
    const submissions: Array<{ config?: { model?: string } }> = [];
    await page.route("**/api/generation-logs**", (route) => route.fulfill({ json: { items: [] } }));
    await page.route("**/api/image-tasks", async (route) => {
        submissions.push(await route.request().postDataJSON());
        return route.fulfill({ json: { task: { id: `confirmed-image-${submissions.length}`, model: submissions.length === 1 ? "e2e-image" : "e2e-image-fallback" } } });
    });
    const successfulPolls = { value: 0 };
    await page.route("**/api/image-tasks/**", (route) => {
        const failed = new URL(route.request().url()).pathname.endsWith("confirmed-image-1");
        if (!failed) successfulPolls.value += 1;
        return route.fulfill({ json: { task: failed
            ? { id: "confirmed-image-1", status: "error", error: "模拟上游拒绝", canRetry: true }
            : { id: "confirmed-image-2", status: "success", result: { dataUrl: png, mimeType: "image/png", width: 1, height: 1 } } } });
    });
    await page.goto("/create?mode=image");
    await page.locator("#workbench-prompt").fill("确认后使用备用模型");
    await page.getByRole("button", { name: /^立即生成/ }).click();
    const modal = page.getByRole("dialog", { name: "切换备用模型？" });
    await expect(modal).toBeVisible();
    await modal.getByRole("button", { name: "切换并重试", exact: true }).click();
    await expect(modal).toBeHidden();
    await expect.poll(() => submissions.length).toBe(2);
    expect(submissions.map((item) => item.config?.model)).toEqual(["e2e-image", "e2e-image-fallback"]);
    expect(successfulPolls.value).toBeGreaterThan(0);
});

test("workbench video fallback submits only the named fallback after confirmation", async ({ page }) => {
    await page.route("**/api/models/fallback**", (route) => route.fulfill({ json: { code: 0, data: { id: "e2e-video-fallback", name: "e2e-video-fallback" }, msg: "OK" } }));
    await workbenchMocks(page);
    const submissions: Array<{ config?: { model?: string } }> = [];
    await page.route("**/api/generation-logs**", (route) => route.fulfill({ json: { items: [] } }));
    await page.route("**/api/video-generation-tasks", async (route) => {
        submissions.push(await route.request().postDataJSON());
        return route.fulfill({ json: { task: { id: `confirmed-video-${submissions.length}`, model: submissions.length === 1 ? "e2e-video" : "e2e-video-fallback" } } });
    });
    await page.route("**/api/video-tasks/**", (route) => {
        const failed = new URL(route.request().url()).pathname.endsWith("confirmed-video-1");
        return route.fulfill({ json: { task: failed
            ? { id: "confirmed-video-1", status: "error", error: "模拟上游拒绝", canRetry: true }
            : { id: "confirmed-video-2", status: "success", result: { url: "https://example.com/e2e.mp4", mimeType: "video/mp4", width: 640, height: 360, durationSeconds: 2 } } } });
    });
    await page.goto("/create?mode=video");
    await page.locator("#workbench-prompt").fill("确认后使用视频备用模型");
    await page.getByRole("button", { name: /^立即生成/ }).click();
    const modal = page.getByRole("dialog", { name: "切换备用模型？" });
    await expect(modal).toBeVisible();
    await modal.getByRole("button", { name: "切换并重试", exact: true }).click();
    await expect(modal).toBeHidden();
    await expect.poll(() => submissions.length).toBe(2);
    expect(submissions.map((item) => item.config?.model)).toEqual(["e2e-video", "e2e-video-fallback"]);
});

test("Canvas image fallback cancellation leaves the original attempt as the only submission", async ({ page, request }) => {
    await page.route("**/api/models/fallback**", (route) => route.fulfill({ json: { code: 0, data: { id: "e2e-image-fallback", name: "e2e-image-fallback" }, msg: "OK" } }));
    const projectResponse = await request.post("/api/canvas/projects", { data: {
        title: `Fallback 取消 ${Date.now()}`,
        project: { nodes: [{ id: "fallback-config", type: "config", title: "生成配置", position: { x: 120, y: 120 }, width: 320, height: 220, metadata: { generationMode: "image", model: "e2e-image", composerContent: "Canvas fallback 测试" } }], connections: [] },
    } });
    expect(projectResponse.ok(), await projectResponse.text()).toBe(true);
    const projectId = ((await projectResponse.json()) as { data: { project: { id: string } } }).data.project.id;
    const submissions: unknown[] = [];
    await page.route("**/api/image-tasks", async (route) => {
        submissions.push(await route.request().postDataJSON());
        return route.fulfill({ json: { task: { id: `canvas-image-${submissions.length}`, model: "e2e-image" } } });
    });
    await page.route("**/api/image-tasks/**", (route) => route.fulfill({ json: { task: { id: "task", status: "error", error: "模拟上游拒绝", canRetry: true } } }));
    await page.route("**/api/generation-logs**", (route) => route.fulfill({ json: { items: [] } }));
    try {
        await page.goto(`/canvas/${projectId}`);
        const configNode = page.locator('[data-node-id="fallback-config"]');
        await configNode.getByRole("button", { name: "开始生成", exact: true }).click();
        const modal = page.getByRole("dialog", { name: "切换备用模型？" });
        await expect(modal).toBeVisible();
        await modal.getByRole("button", { name: /取\s*消/ }).click();
        await expect(modal).toBeHidden();
        expect(submissions).toHaveLength(1);
    } finally {
        await request.delete("/api/canvas/projects", { data: { ids: [projectId] } });
    }
});

test("Canvas image fallback uses the configured model after user confirmation", async ({ page, request }) => {
    await page.route("**/api/models/fallback**", (route) => route.fulfill({ json: { code: 0, data: { id: "e2e-image-fallback", name: "e2e-image-fallback" }, msg: "OK" } }));
    const projectResponse = await request.post("/api/canvas/projects", { data: {
        title: `Fallback 确认 ${Date.now()}`,
        project: { nodes: [{ id: "fallback-config", type: "config", title: "生成配置", position: { x: 120, y: 120 }, width: 320, height: 220, metadata: { generationMode: "image", model: "e2e-image", composerContent: "Canvas fallback 测试" } }], connections: [] },
    } });
    expect(projectResponse.ok(), await projectResponse.text()).toBe(true);
    const projectId = ((await projectResponse.json()) as { data: { project: { id: string } } }).data.project.id;
    const submissions: Array<{ config?: { model?: string } }> = [];
    await page.route("**/api/image-tasks", async (route) => {
        submissions.push(await route.request().postDataJSON());
        return route.fulfill({ json: { task: { id: `canvas-confirm-${submissions.length}`, model: submissions.length === 1 ? "e2e-image" : "e2e-image-fallback" } } });
    });
    await page.route("**/api/image-tasks/**", (route) => {
        const failed = new URL(route.request().url()).pathname.endsWith("canvas-confirm-1");
        return route.fulfill({ json: { task: failed
            ? { id: "canvas-confirm-1", status: "error", error: "模拟上游拒绝", canRetry: true }
            : { id: "canvas-confirm-2", status: "success", result: { dataUrl: png, mimeType: "image/png", width: 1, height: 1 } } } });
    });
    await page.route("**/api/generation-logs**", (route) => route.fulfill({ json: { items: [] } }));
    try {
        await page.goto(`/canvas/${projectId}`);
        await page.locator('[data-node-id="fallback-config"]').getByRole("button", { name: "开始生成", exact: true }).click();
        const modal = page.getByRole("dialog", { name: "切换备用模型？" });
        await expect(modal).toBeVisible();
        await modal.getByRole("button", { name: "切换并重试", exact: true }).click();
        await expect(modal).toBeHidden();
        await expect.poll(() => submissions.length).toBe(2);
        expect(submissions.map((item) => item.config?.model)).toEqual(["e2e-image", "e2e-image-fallback"]);
    } finally {
        await request.delete("/api/canvas/projects", { data: { ids: [projectId] } });
    }
});

test("deleting a workbench result cancels its owned active video task", async ({ page, request }) => {
    const before = await readSettings(request);
    await resetProtocolFixture(request);
    const systemChannels = before.systemChannels.map((channel) => channel.id === "e2e-primary" ? {
        ...channel,
        advancedConfig: { ...channel.advancedConfig, cancelPath: "/videos/:task_id", cancelMethod: "DELETE" },
    } : channel);
    const updated = await request.patch("/api/admin/settings", { data: { defaultModels: { ...before.defaultModels, videoModel: "e2e-video-slow" }, systemChannels } });
    expect(updated.ok(), await updated.text()).toBe(true);
    try {
        const logId = `video-workbench:${randomUUID()}`;
        const slotId = randomUUID();
        const clientRequestId = `video-workbench:${logId}:0:${randomUUID()}`;
        const prompt = "创建后立即删除并取消任务";
        const createdLog = await request.post("/api/generation-logs", { data: {
            id: logId, kind: "video", source: "video-workbench", status: "pending", title: prompt, prompt, model: "e2e-video-slow", count: 1,
            requestSnapshot: { version: 1, userPrompt: prompt, parameters: { model: "e2e-video-slow", size: "16:9", count: "1", quality: "720P", seconds: 5 }, references: [], slots: [{ id: slotId, index: 0, status: "pending", clientRequestId, parameters: { size: "16:9", quality: "720P", seconds: 5 } }] },
        } });
        expect(createdLog.ok(), await createdLog.text()).toBe(true);
        const created = await request.post("/api/video-generation-tasks", { data: {
            config: { model: "e2e-video-slow", size: "16:9", vquality: "720", videoSeconds: 5 }, prompt, source: "video-workbench",
            context: { clientRequestId, generationLogId: logId, generationSlotId: slotId },
        } });
        expect(created.ok(), await created.text()).toBe(true);
        const taskId = ((await created.json()) as { task: { id: string } }).task.id;
        await expect.poll(async () => { const response = await request.get(`/api/video-tasks/${taskId}`); return response.ok() ? (await response.json()).task.status : "missing"; }, { timeout: 15000 }).toBe("running");
        await page.goto("/create?mode=video");
        const card = page.locator(`article[data-record-id="${logId}"][data-slot-id="${slotId}"]`).first();
        await expect(card).toBeVisible();
        await expect(card).toContainText(/准备中|排队中|生成中|结果待确认/);
        await card.getByRole("button", { name: "生成结果操作" }).click();
        await page.getByRole("menuitem", { name: "删除" }).click();
        const confirm = page.getByRole("dialog", { name: "删除这条生成结果？" });
        await expect(confirm).toBeVisible();
        const deletion = page.waitForResponse((response) => response.request().method() === "PATCH" && new URL(response.url()).pathname === "/api/generation-logs");
        await confirm.getByRole("button", { name: /删\s*除/ }).click();
        const deletionResponse = await deletion;
        expect(deletionResponse.ok(), await deletionResponse.text()).toBe(true);
        const cancelled = await request.get(`/api/video-tasks/${taskId}`);
        expect(cancelled.ok(), await cancelled.text()).toBe(true);
        expect((await cancelled.json()).task.status).toBe("cancelled");
        const recovery = await request.post("/api/maintenance/generation-tasks/run", { headers: { Authorization: "Bearer dreamyo-e2e-worker-token-separate-32chars" } });
        expect(recovery.ok(), await recovery.text()).toBe(true);
        const fixtureState = await protocolFixtureState(request);
        expect(fixtureState.tasks.some((task) => task.status === "cancelled"), JSON.stringify(fixtureState)).toBe(true);
    } finally {
        const restored = await request.patch("/api/admin/settings", { data: { defaultModels: before.defaultModels, systemChannels: before.systemChannels } });
        expect(restored.ok(), await restored.text()).toBe(true);
    }
});

async function workbenchMocks(page: Page) {
    await page.route("**/api/generation-logs**", (route) => route.fulfill({ json: { items: [] } }));
    await page.route("**/api/library-assets**", (route) => route.fulfill({ json: { code: 0, data: { assets: [], total: 0, page: 1, pageSize: 100 }, msg: "OK" } }));
    await page.route("**/api/model-generation-stats", (route) => route.fulfill({ json: { data: {} } }));
}

async function readSettings(request: APIRequestContext): Promise<TestSettings> {
    const response = await request.get("/api/admin/settings");
    expect(response.ok(), await response.text()).toBe(true);
    return (await response.json()).settings as TestSettings;
}

async function saveEvidence(target: Locator, filename: string) {
    const directory = path.resolve(process.cwd(), "../docs/generation-management/evidence");
    await mkdir(directory, { recursive: true });
    await target.screenshot({ path: path.join(directory, filename) });
}

test("GPTAPI one-click cleanup previews confirmed scope, persists synchronously and is idempotent", async ({ page }) => {
    const accounts = [
        { id: "acct-invalid", display_name: "无效凭据账号", email: "invalid@example.test", source_plan_label: "Plus", status_label: "异常", status_reason: "凭据已确认失效", enabled: true, quota_label: "未知", success_count: 0, failure_count: 1 },
        { id: "acct-disabled", display_name: "已禁用账号", email: "disabled@example.test", source_plan_label: "Plus", status_label: "禁用", status_reason: "管理员已禁用", enabled: false, quota_label: "未知", success_count: 0, failure_count: 0 },
        { id: "acct-network", display_name: "网络失败账号", email: "network@example.test", source_plan_label: "Plus", status_label: "异常", status_reason: "网络连接失败", enabled: true, quota_label: "未知", success_count: 0, failure_count: 1 },
        { id: "acct-uncertain", display_name: "未确认异常账号", email: "uncertain@example.test", source_plan_label: "Plus", status_label: "异常", status_reason: "待确认", enabled: true, quota_label: "未知", success_count: 0, failure_count: 1 },
    ];
    let cleanupPosts = 0;
    let accountReads = 0;
    const removedIds = ["acct-invalid", "acct-disabled"];
    await page.route("**/api/admin/chatgpt-api/**", async (route) => {
        const url = new URL(route.request().url());
        const path = url.pathname.split("/chatgpt-api/")[1];
        const method = route.request().method();
        let data: unknown = {};
        if (path === "accounts" && method === "GET") {
            accountReads += 1;
            const visibleAccounts = cleanupPosts > 0 ? accounts.filter((account) => !removedIds.includes(account.id)) : accounts;
            data = { items: visibleAccounts, total: visibleAccounts.length };
        } else if (path === "accounts/cleanup-abnormal" && method === "GET") {
            data = cleanupPosts === 0 ? { count: 2, scope: ["异常", "禁用"] } : { count: 0, scope: ["异常", "禁用"] };
        } else if (path === "accounts/cleanup-abnormal" && method === "POST") {
            cleanupPosts += 1;
            data = cleanupPosts === 1
                ? { checked: 2, removed: 2, removed_ids: removedIds, errors: [], status_label: "已完成" }
                : { checked: 0, removed: 0, removed_ids: [], errors: [], status_label: "已完成" };
        } else if (path === "model-catalog") {
            data = { chat_models: [], image_models: [], source: { chat: "config", image: "config" } };
        } else if (path === "models") {
            data = { models: [] };
        }
        await route.fulfill({ json: { code: 0, data, msg: "" } });
    });

    await page.goto("/admin?section=chatgptApi", { waitUntil: "domcontentloaded" });
    await expect(page.getByText("invalid@example.test", { exact: true })).toBeVisible();
    await expect(page.getByText("network@example.test", { exact: true })).toBeVisible();
    const cleanupButton = page.getByRole("button", { name: "一键清理异常账号" });

    await cleanupButton.click();
    const firstConfirmation = page.getByRole("dialog", { name: "一键清理异常账号？" });
    await expect(firstConfirmation).toContainText("当前预计清理 2 个");
    await expect(firstConfirmation).toContainText("网络失败、超时和限流账号会保留");
    await firstConfirmation.getByRole("button", { name: "清理账号" }).click();
    await expect.poll(() => cleanupPosts).toBe(1);
    await expect(page.getByText("invalid@example.test", { exact: true })).toHaveCount(0);
    await expect(page.getByText("disabled@example.test", { exact: true })).toHaveCount(0);
    await expect(page.getByText("network@example.test", { exact: true })).toBeVisible();
    await expect(page.getByText("uncertain@example.test", { exact: true })).toBeVisible();
    expect(accountReads).toBeGreaterThanOrEqual(2);

    await cleanupButton.click();
    const repeatConfirmation = page.getByRole("dialog", { name: "一键清理异常账号？" });
    await expect(repeatConfirmation).toContainText("当前预计清理 0 个");
    await repeatConfirmation.getByRole("button", { name: "清理账号" }).click();
    await expect.poll(() => cleanupPosts).toBe(2);
    await expect(page.getByText("清理异常账号已完成：清理 0 个，失败 0 个", { exact: true })).toBeVisible();
    await expect(page.getByText("network@example.test", { exact: true })).toBeVisible();
    await expect(page.getByText("uncertain@example.test", { exact: true })).toBeVisible();
    expect(accountReads).toBeGreaterThanOrEqual(3);
});
