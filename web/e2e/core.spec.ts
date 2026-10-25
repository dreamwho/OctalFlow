import { createHmac, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import sharp from "sharp";

import { expect, test, type APIRequestContext } from "@playwright/test";
import { Client } from "pg";
import { E2E_PAYMENT_WEBHOOK_SECRET, pollTask, protocolFixtureState, resetProtocolFixture } from "./support";

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ request }) => {
    await resetProtocolFixture(request);
});

test("GeminiAI accepted video remains running and the open log follows its terminal state", async ({ page }, testInfo) => {
    test.skip(!process.env.DREAMYO_E2E_DATABASE_URL, "Requires an explicitly configured isolated PostgreSQL database");
    const client = new Client({ connectionString: process.env.DREAMYO_E2E_DATABASE_URL });
    const id = `e2e-omni-${randomUUID()}`;
    const taskId = `vt_${randomUUID()}`;
    await client.connect();
    try {
        await client.query(
            "INSERT INTO dreamyo_geminiai_request_logs (id, source, capability, method, path, model, status_code, duration_ms, phase, task_id, response_preview) VALUES ($1, 'runtime', 'video', 'POST', '/v1/videos', 'gemini-omni-1.1-flash', 200, 4500, 'running', $2, $3)",
            [id, taskId, JSON.stringify({ id: taskId, status: "processing", execution_stage: "generating" })],
        );
        await page.route("**/api/admin/geminiai", (route) =>
            route.fulfill({ json: { code: 0, data: { configured: true, healthy: true, accounts: [], accountsAvailable: true, models: [], channels: [], gateway: { enabled: true }, apiKeys: [] }, msg: "OK" } }),
        );
        await page.goto("/admin?section=geminiai");
        await page.getByRole("tab", { name: /请求日志|日志/ }).click();
        const row = page.getByRole("button").filter({ has: page.getByText("gemini-omni-1.1-flash", { exact: true }) });
        await expect(row).toContainText("执行中");
        await row.click();
        const drawer = page.getByRole("dialog");
        await expect(drawer).toContainText("执行中 · 200");
        await expect(drawer).toContainText(taskId);
        const refreshed = page.waitForResponse(async (response) => response.url().includes("/api/admin/geminiai/logs?") && (await response.json()).data?.items?.some((item: { id: string; phase: string }) => item.id === id && item.phase === "success"));
        await client.query("UPDATE dreamyo_geminiai_request_logs SET phase = 'success', duration_ms = 125000, response_preview = $2 WHERE id = $1", [id, JSON.stringify({ id: taskId, status: "succeeded", video_url: `/v1/videos/${taskId}/content` })]);
        await refreshed;
        await expect(drawer).toContainText("成功 · 200");
        await expect(drawer).toContainText("video_url");
        await expect(drawer).not.toContainText('"status":"processing"');
        await page.screenshot({ path: testInfo.outputPath("geminiai-video-log-completed.png") });
        await drawer.getByRole("button", { name: "关闭", exact: true }).click();
        await page.reload();
        await page.getByRole("tab", { name: /请求日志|日志/ }).click();
        await expect(row).toContainText("成功");
    } finally {
        await client.query("DELETE FROM dreamyo_geminiai_request_logs WHERE id = $1", [id]);
        await client.end();
    }
});

test("GeminiAI video failure logs persist in PostgreSQL and remain filterable in the admin UI", async ({ page, request }, testInfo) => {
    test.skip(!process.env.DREAMYO_E2E_DATABASE_URL, "Requires an explicitly configured isolated PostgreSQL database");
    const client = new Client({ connectionString: process.env.DREAMYO_E2E_DATABASE_URL });
    const id = `e2e-omni-${randomUUID()}`;
    const error = "reference image download failed: fixture connection refused";
    await client.connect();
    try {
        await client.query(
            "INSERT INTO dreamyo_geminiai_request_logs (id, source, capability, method, path, model, status_code, duration_ms, phase, error) VALUES ($1, 'runtime', 'video', 'GET', '/v1/videos/vt_fixture', 'gemini-omni-1.1-flash', 200, 20, 'failed', $2)",
            [id, error],
        );
        const response = await request.get("/api/admin/geminiai/logs?capability=video&status=failed");
        expect(response.ok(), await response.text()).toBe(true);
        expect((await response.json()).data.items).toContainEqual(expect.objectContaining({ id, capability: "video", phase: "failed", error }));
        await page.route("**/api/admin/geminiai", (route) =>
            route.fulfill({ json: { code: 0, data: { configured: true, healthy: true, accounts: [], accountsAvailable: true, models: [], channels: [], gateway: { enabled: true }, apiKeys: [] }, msg: "OK" } }),
        );
        for (const theme of ["light", "dark"]) {
            await page.goto("/admin?section=geminiai");
            await page.evaluate((value) => localStorage.setItem("dreamyo:theme_store", JSON.stringify({ state: { theme: value }, version: 0 })), theme);
            for (const width of [1440, 390, 430]) {
                await page.setViewportSize({ width, height: 1000 });
                await page.reload();
                await page.getByRole("tab", { name: /请求日志|日志/ }).click();
                await page.getByRole("combobox").nth(1).click();
                await page.locator(".ant-select-dropdown:visible").getByText("视频", { exact: true }).click();
                await page.getByRole("combobox").nth(0).click();
                await page.locator(".ant-select-dropdown:visible").getByText("失败", { exact: true }).click();
                const row = page.getByRole("button").filter({ has: page.getByText("gemini-omni-1.1-flash", { exact: true }) });
                await expect(row).toContainText("视频");
                await expect(row).toContainText("失败");
                await row.click();
                const drawer = page.getByRole("dialog");
                await expect(drawer).toContainText(error);
                await expect(drawer).toContainText("失败 · 200");
                const bounds = await drawer.boundingBox();
                expect(bounds).not.toBeNull();
                expect(bounds!.width).toBeLessThanOrEqual(width);
                await page.screenshot({ path: testInfo.outputPath(`geminiai-video-log-${theme}-${width}.png`) });
                await drawer.getByRole("button", { name: "关闭", exact: true }).click();
            }
        }
    } finally {
        await client.query("DELETE FROM dreamyo_geminiai_request_logs WHERE id = $1", [id]);
        await client.end();
    }
});

test("site footer deletions remain deleted after settings and public-session reloads", async ({ request }) => {
    const beforeResponse = await request.get("/api/admin/settings");
    expect(beforeResponse.ok(), await beforeResponse.text()).toBe(true);
    const before = ((await beforeResponse.json()) as { settings: { site: Record<string, unknown> } }).settings.site;
    const socials = before.socials as Record<string, { enabled: boolean; label: string; url: string }>;
    try {
        const site = {
            ...before,
            friendLinks: [],
            socials: { ...socials, email: { enabled: false, label: "", url: "" } },
        };
        const savedResponse = await request.patch("/api/admin/settings", { data: { site } });
        expect(savedResponse.ok(), await savedResponse.text()).toBe(true);

        const persistedResponse = await request.get("/api/admin/settings");
        const persisted = ((await persistedResponse.json()) as { settings: { site: { friendLinks: unknown[]; socials: typeof socials } } }).settings.site;
        expect(persisted.friendLinks).toEqual([]);
        expect(persisted.socials.email).toEqual({ enabled: false, label: "", url: "" });

        const publicResponse = await request.get("/api/auth/session");
        const publicSite = ((await publicResponse.json()) as { settings: { site: { friendLinks: unknown[]; socials: typeof socials } } }).settings.site;
        expect(publicSite.friendLinks).toEqual([]);
        expect(publicSite.socials.email).toEqual({ enabled: false, label: "", url: "" });
    } finally {
        const restored = await request.patch("/api/admin/settings", { data: { site: before } });
        expect(restored.ok(), await restored.text()).toBe(true);
    }
});

test("admin site form persists social addresses, publishes them to the home footer, and deletes friend links", async ({ page, request }) => {
    const beforeResponse = await request.get("/api/admin/settings");
    expect(beforeResponse.ok(), await beforeResponse.text()).toBe(true);
    const before = ((await beforeResponse.json()) as { settings: { site: Record<string, unknown> } }).settings.site;
    const socials = before.socials as Record<string, { enabled: boolean; label: string; url: string }>;
    const testLink = { id: "e2e-footer-link", label: "E2E Footer Link", url: "https://example.com/footer", enabled: true };
    try {
        const seededResponse = await request.patch("/api/admin/settings", {
            data: {
                site: {
                    ...before,
                    friendLinks: [testLink],
                    socials: {
                        ...socials,
                        email: { enabled: true, label: "邮箱联系", url: "mailto:before@example.com" },
                        telegram: { enabled: true, label: "Telegram", url: "" },
                        x: { enabled: true, label: "X", url: "" },
                        instagram: { enabled: true, label: "Instagram", url: "" },
                    },
                },
            },
        });
        expect(seededResponse.ok(), await seededResponse.text()).toBe(true);

        await page.goto("/admin?section=site", { waitUntil: "domcontentloaded" });
        await expect(page.locator(".admin-dashboard-shell")).toHaveAttribute("data-hydrated", "true");
        const emailInput = page.getByPlaceholder("name@example.com").first();
        const telegramInput = page.getByPlaceholder("https://t.me/username 或 @username").first();
        const xInput = page.getByPlaceholder("https://x.com/username 或 @username").first();
        const instagramInput = page.getByPlaceholder("https://instagram.com/username 或 @username").first();
        await expect(emailInput).toBeVisible();
        await expect(emailInput).toHaveValue("mailto:before@example.com");
        await emailInput.fill("owner@example.com");
        await telegramInput.fill("t.me/dreamyo_group");
        await xInput.fill("@dreamyo");
        await instagramInput.fill("instagram.com/dreamyo.pro");
        await expect(emailInput).toHaveValue("owner@example.com");
        await page.getByRole("button", { name: "保存网站设置" }).click();
        await expect(page.getByLabel("当前密码")).toHaveCount(0);
        await expect(page.getByText("网站信息已保存")).toBeVisible();
        await expect(emailInput).toHaveValue("mailto:owner@example.com");
        await expect(telegramInput).toHaveValue("https://t.me/dreamyo_group");
        await expect(xInput).toHaveValue("https://x.com/dreamyo");
        await expect(instagramInput).toHaveValue("https://instagram.com/dreamyo.pro");

        await page.goto("/", { waitUntil: "domcontentloaded" });
        await expect(page.locator('footer a[aria-label="Telegram"]')).toHaveAttribute("href", "https://t.me/dreamyo_group");
        await expect(page.locator('footer a[aria-label="X"]')).toHaveAttribute("href", "https://x.com/dreamyo");
        await expect(page.locator('footer a[aria-label="Instagram"]')).toHaveAttribute("href", "https://instagram.com/dreamyo.pro");

        await page.goto("/admin?section=site", { waitUntil: "domcontentloaded" });
        await expect(emailInput).toHaveValue("mailto:owner@example.com");
        await expect(telegramInput).toHaveValue("https://t.me/dreamyo_group");
        await expect(xInput).toHaveValue("https://x.com/dreamyo");
        await expect(instagramInput).toHaveValue("https://instagram.com/dreamyo.pro");
        await page.getByRole("button", { name: "删除友情链接" }).click();
        await expect(page.getByLabel("当前密码")).toHaveCount(0);
        await expect(page.getByText("友情链接已删除")).toBeVisible();
        await expect(page.getByText(testLink.label, { exact: true })).toHaveCount(0);

        const persistedResponse = await request.get("/api/admin/settings");
        const persisted = ((await persistedResponse.json()) as { settings: { site: { friendLinks: unknown[]; socials: typeof socials } } }).settings.site;
        expect(persisted.friendLinks).toEqual([]);

        await page.reload({ waitUntil: "domcontentloaded" });
        await expect(page.getByText(testLink.label, { exact: true })).toHaveCount(0);

        expect(persisted.socials.email.url).toBe("mailto:owner@example.com");
        expect(persisted.socials.telegram).toEqual({ enabled: true, label: "Telegram", url: "https://t.me/dreamyo_group" });
        expect(persisted.socials.x).toEqual({ enabled: true, label: "X", url: "https://x.com/dreamyo" });
        expect(persisted.socials.instagram).toEqual({ enabled: true, label: "Instagram", url: "https://instagram.com/dreamyo.pro" });

        const publicResponse = await request.get("/api/auth/session");
        const publicSite = ((await publicResponse.json()) as { settings: { site: { socials: typeof socials } } }).settings.site;
        expect(publicSite.socials).toEqual(persisted.socials);
    } finally {
        const restored = await request.patch("/api/admin/settings", { data: { site: before } });
        expect(restored.ok(), await restored.text()).toBe(true);
    }
});

test("admin data lifecycle settings persist without password re-verification", async ({ page, request }) => {
    const beforeResponse = await request.get("/api/admin/settings");
    expect(beforeResponse.ok(), await beforeResponse.text()).toBe(true);
    const before = ((await beforeResponse.json()) as { settings: { dataLifecycle: { maintenanceBatchSize: number } } }).settings.dataLifecycle;
    const nextBatchSize = before.maintenanceBatchSize < 500 ? before.maintenanceBatchSize + 1 : before.maintenanceBatchSize - 1;

    try {
        await page.goto("/admin?section=settings", { waitUntil: "domcontentloaded" });
        await expect(page.locator(".admin-dashboard-shell")).toHaveAttribute("data-hydrated", "true");
        const batchInput = page.getByRole("spinbutton", { name: /单类每批处理数量/ });
        await expect(batchInput).toHaveValue(String(before.maintenanceBatchSize));
        await batchInput.fill(String(nextBatchSize));
        await page.getByRole("button", { name: "保存系统设置" }).click();
        await expect(page.getByLabel("当前密码")).toHaveCount(0);
        await expect(page.getByText("系统设置已保存", { exact: true })).toBeVisible();

        await page.reload({ waitUntil: "domcontentloaded" });
        await expect(batchInput).toHaveValue(String(nextBatchSize));
        const persistedResponse = await request.get("/api/admin/settings");
        expect(persistedResponse.ok(), await persistedResponse.text()).toBe(true);
        expect(((await persistedResponse.json()) as { settings: { dataLifecycle: { maintenanceBatchSize: number } } }).settings.dataLifecycle.maintenanceBatchSize).toBe(nextBatchSize);
    } finally {
        const restored = await request.patch("/api/admin/settings", { data: { dataLifecycle: before } });
        expect(restored.ok(), await restored.text()).toBe(true);
    }
});

test("GeminiAI authorization opens a fresh session after the previous account completes", async ({ page }) => {
    let startedSessions = 0;
    await page.route("**/api/admin/geminiai", async (route) => {
        await route.fulfill({
            contentType: "application/json",
            body: JSON.stringify({
                code: 0,
                data: {
                    configured: true,
                    healthy: true,
                    accounts: [{ id: "account-one", name: "测试账号", status: "active" }],
                    activeAccountId: "account-one",
                    rotation: { enabled: true, mode: "round_robin", cooldownSeconds: 0 },
                    models: [],
                    channels: [],
                },
                msg: "OK",
            }),
        });
    });
    await page.route("**/api/admin/geminiai/accounts/login/start", async (route) => {
        startedSessions += 1;
        await route.fulfill({ contentType: "application/json", body: JSON.stringify({ code: 0, data: { sessionId: `session-${startedSessions}`, status: "pending" }, msg: "OK" }) });
    });
    await page.route("**/api/admin/geminiai/accounts/login/status/*", async (route) => {
        const sessionId = route.request().url().split("/").pop();
        await route.fulfill({ contentType: "application/json", body: JSON.stringify({ code: 0, data: { sessionId, status: "completed", accountId: "account-one" }, msg: "OK" }) });
    });

    await page.goto("/admin?section=geminiai", { waitUntil: "domcontentloaded" });
    await expect(page.locator(".admin-dashboard-shell")).toHaveAttribute("data-hydrated", "true");
    await page.getByRole("button", { name: "添加授权" }).click();
    await page.getByRole("button", { name: "打开 Camoufox 授权窗口" }).click();
    await expect(page.getByText("授权状态：授权中", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "检查授权状态" }).click();
    await expect(page.getByRole("dialog", { name: "添加 Google 授权" })).toHaveCount(0);

    await page.getByRole("button", { name: "添加授权" }).click();
    await expect(page.getByText("授权状态：授权完成", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "打开 Camoufox 授权窗口" }).click();
    await expect.poll(() => startedSessions).toBe(2);
});

test("text tasks return content, fail over automatically, and surface terminal failures", async ({ request }) => {
    const fallback = await request.post("/api/text-tasks", { data: { config: { model: "e2e-text-fallback" }, messages: [{ role: "user", content: "protocol fallback" }] } });
    expect(fallback.ok(), await fallback.text()).toBe(true);
    const fallbackTask = ((await fallback.json()) as { task: { id: string } }).task;
    const completed = await pollTask(request, `/api/text-tasks/${fallbackTask.id}`);
    expect(completed).toMatchObject({ status: "success", result: { content: "协议测试文本返回成功" } });
    const state = await protocolFixtureState(request);
    expect(state.requests.filter((item) => item.method === "POST" && item.path.endsWith("/chat/completions"))).toMatchObject([
        { authorization: "Bearer e2e-primary-secret", model: "e2e-text-fallback" },
        { authorization: "Bearer e2e-backup-secret", model: "e2e-text-fallback" },
    ]);

    const failed = await request.post("/api/text-tasks", { data: { config: { model: "e2e-text-fail" }, messages: [{ role: "user", content: "protocol failure" }] } });
    expect(failed.ok(), await failed.text()).toBe(true);
    const failedTask = ((await failed.json()) as { task: { id: string } }).task;
    expect(await pollTask(request, `/api/text-tasks/${failedTask.id}`)).toMatchObject({ status: "error" });
});

test("image task persists a real media result and reuses the same request identity", async ({ request }) => {
    const clientRequestId = `e2e-image:${randomUUID()}`;
    const body = { kind: "generation", config: { model: "e2e-image", quality: "standard", size: "64x64" }, prompt: "blue image", source: "image-workbench", context: { clientRequestId } };
    const headers = { "X-DREAMYO-Client-Request-Id": clientRequestId };
    const created = await request.post("/api/image-tasks", { data: body, headers });
    expect(created.ok(), await created.text()).toBe(true);
    const firstTask = ((await created.json()) as { task: { id: string } }).task;
    const replay = await request.post("/api/image-tasks", { data: body, headers });
    expect(replay.ok()).toBe(true);
    expect((await replay.json()).task.id).toBe(firstTask.id);
    const completed = await pollTask(request, `/api/image-tasks/${firstTask.id}`);
    // The isolated upstream fixture intentionally returns a 2×2 PNG. Results must
    // preserve the provider bytes and dimensions instead of being upscaled to the
    // requested 64×64 target (see generated-image-normalizer contract).
    expect(completed).toMatchObject({ status: "success", result: { width: 2, height: 2, mimeType: "image/png" } });
    const mediaUrl = String((completed.result as { dataUrl?: string }).dataUrl || "");
    expect(mediaUrl).toMatch(/^\/api\/generation-log-assets\/permanent\/.+\.png$/);
    const media = await request.get(mediaUrl);
    expect(media.ok()).toBe(true);
    expect(media.headers()["content-type"]).toMatch(/^image\/png/);
    expect(Array.from((await media.body()).subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const state = await protocolFixtureState(request);
    expect(state.requests.filter((item) => item.method === "POST" && item.path.endsWith("/images/generations"))).toHaveLength(1);
});

test("unified generation page reaches the local image protocol and restores its result", async ({ page, request }) => {
    await page.goto("/create", { waitUntil: "domcontentloaded" });
    const workbench = page.getByTestId("image-video-workbench").filter({ visible: true });
    await expect(workbench).toBeVisible();
    await expect(page.getByRole("button", { name: "图片", exact: true })).toHaveAttribute("aria-pressed", "true");
    const prompt = `统一入口协议图片 ${randomUUID().slice(0, 8)}`;
    await page.getByRole("textbox", { name: "提示词", exact: true }).fill(prompt);
    const created = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/generation-logs");
    await page.getByRole("button", { name: /立即生成/ }).click();
    const response = await created;
    expect(response.ok(), await response.text()).toBe(true);
    const recordId = (await response.json()).log.id;
    const card = workbench.locator(`article[data-record-id="${recordId}"]`);
    await expect(card).toHaveAttribute("data-status", "success", { timeout: 60_000 });
    await expect(card.locator("img").first()).toBeVisible();
    await page.reload();
    await expect(card).toHaveAttribute("data-status", "success");
    const state = await protocolFixtureState(request);
    expect(state.requests.filter((item) => item.method === "POST" && item.path.endsWith("/images/generations"))).toHaveLength(1);
});

for (const reference of [false, true]) {
    test(`video workbench completes ${reference ? "image-to-video" : "text-to-video"} through the local protocol`, async ({ page, request }) => {
        await page.goto("/create?mode=video");
        const workbench = page.getByTestId("image-video-workbench");
        await expect(page.getByRole("button", { name: "视频", exact: true })).toHaveAttribute("aria-pressed", "true");
        if (reference) {
            await page.getByRole("button", { name: "添加参考图片" }).click();
            await page.locator("#workbench-reference-file").setInputFiles({
                name: "video-reference.png",
                mimeType: "image/png",
                buffer: await sharp({ create: { width: 32, height: 32, channels: 3, background: "#2563eb" } })
                    .png()
                    .toBuffer(),
            });
            await expect(page.getByRole("img", { name: "video-reference.png" })).toBeVisible();
        }
        await page.getByRole("textbox", { name: "提示词", exact: true }).fill(`工作台视频协议 ${reference ? "参考图" : "纯文本"}`);
        const created = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/generation-logs");
        const taskCreated = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/video-generation-tasks");
        await page.getByRole("button", { name: /立即生成/ }).click();
        const response = await created;
        expect(response.ok(), await response.text()).toBe(true);
        const recordId = (await response.json()).log.id;
        const taskResponse = await taskCreated;
        expect(taskResponse.ok(), await taskResponse.text()).toBe(true);
        expect(taskResponse.request().postDataJSON().references || []).toHaveLength(reference ? 1 : 0);
        const card = workbench.locator(`article[data-record-id="${recordId}"]`);
        await expect(card).toHaveAttribute("data-status", "success", { timeout: 60_000 });
        await expect(card.locator("video")).toHaveAttribute("src", /\/api\/reference-assets\/permanent\/.+\.mp4/);
        await expect.poll(() => card.locator("video").evaluate((video: HTMLVideoElement) => video.videoWidth > 0 && video.videoHeight > 0 && video.duration > 0)).toBe(true);
        const state = await protocolFixtureState(request);
        expect(state.requests.filter((item) => item.method === "POST" && item.path.endsWith("/videos"))).toHaveLength(1);
        await page.reload();
        await expect(card).toHaveAttribute("data-status", "success");
    });
}

test("video request replay and cancellation keep one upstream task", async ({ request }) => {
    const clientRequestId = `e2e-video:${randomUUID()}`;
    const body = { config: { model: "e2e-video-slow", size: "16:9", vquality: "720", videoSeconds: 5 }, prompt: "slow video", source: "video-workbench", context: { clientRequestId } };
    const headers = { "X-DREAMYO-Client-Request-Id": clientRequestId };
    const created = await request.post("/api/video-generation-tasks", { data: body, headers });
    expect(created.ok(), await created.text()).toBe(true);
    const firstTask = ((await created.json()) as { task: { id: string } }).task;
    const replay = await request.post("/api/video-generation-tasks", { data: body, headers });
    expect(replay.ok()).toBe(true);
    expect((await replay.json()).task.id).toBe(firstTask.id);
    await expect.poll(async () => (await protocolFixtureState(request)).requests.filter((item) => item.method === "POST" && item.path.endsWith("/videos")).length).toBe(1);

    const cancelled = await request.patch(`/api/video-tasks/${firstTask.id}`, { data: { action: "cancel" } });
    expect(cancelled.ok(), await cancelled.text()).toBe(true);
    expect(await pollTask(request, `/api/video-tasks/${firstTask.id}`)).toMatchObject({ status: "cancelled" });
    const state = await protocolFixtureState(request);
    expect(state.requests.filter((item) => item.method === "POST" && item.path.endsWith("/videos"))).toHaveLength(1);
});

test("legacy image and video routes hand off to the unified creative Agent", async ({ page }) => {
    for (const route of ["/image", "/video"]) {
        await page.goto(route, { waitUntil: "domcontentloaded" });
        await expect(page).toHaveURL(/\/create$/);
        await expect(page.getByRole("heading", { name: "从灵感，到完整作品" })).toBeVisible();
        await expect(page.getByRole("button", { name: /生成模型：/ })).toBeVisible();
    }
});

test("audio task stores a valid audio result", async ({ request }) => {
    const created = await request.post("/api/audio-tasks", { data: { config: { model: "e2e-audio", voice: "alloy", format: "wav" }, prompt: "audio fixture", source: "agent", context: { clientRequestId: `e2e-audio:${randomUUID()}` } } });
    expect(created.ok(), await created.text()).toBe(true);
    const task = ((await created.json()) as { task: { id: string } }).task;
    expect(await pollTask(request, `/api/audio-tasks/${task.id}`)).toMatchObject({ status: "success", result: { mimeType: "audio/wav" } });
});

test("canvas projects round-trip two nodes and one connection", async ({ request }) => {
    const created = await request.post("/api/canvas/projects", {
        data: {
            title: "E2E Canvas",
            project: {
                nodes: [
                    { id: "node-a", type: "text", title: "需求", position: { x: 10, y: 20 }, width: 240, height: 120, metadata: { content: "生成测试" } },
                    { id: "node-b", type: "config", title: "配置", position: { x: 360, y: 20 }, width: 240, height: 160, metadata: { size: "1280x720" } },
                ],
                connections: [{ id: "edge-a-b", fromNodeId: "node-a", toNodeId: "node-b" }],
            },
        },
    });
    expect(created.ok(), await created.text()).toBe(true);
    const project = ((await created.json()) as { data: { project: { id: string } } }).data.project;
    const loaded = await request.get(`/api/canvas/projects/${project.id}`);
    expect(loaded.ok()).toBe(true);
    expect(await loaded.json()).toMatchObject({ data: { project: { nodes: [{ id: "node-a" }, { id: "node-b" }], connections: [{ id: "edge-a-b", fromNodeId: "node-a", toNodeId: "node-b" }] } } });
});

test("administrator orders and hides Canvas node models from the logical model catalog", async ({ page, request }, testInfo) => {
    const beforeResponse = await request.get("/api/admin/settings");
    expect(beforeResponse.ok(), await beforeResponse.text()).toBe(true);
    const before = (await beforeResponse.json()) as { settings: { systemChannels: Array<{ id: string; models: string[] }>; logicalModels: unknown[]; defaultModels: Record<string, string> } };
    const channel = before.settings.systemChannels.find((item) => item.models.includes("e2e-image"));
    expect(channel).toBeTruthy();
    const logicalModels = [logicalModel("canvas-image-a", "画布图片 A", "e2e-image"), logicalModel("canvas-image-b", "画布图片 B", "e2e-image-fallback"), logicalModel("canvas-image-c", "画布图片 C", "e2e-image")];
    let projectId = "";
    try {
        const seeded = await request.patch("/api/admin/settings", {
            data: { logicalModels: logicalModels.map((model) => ({ ...model, bindings: model.bindings.map((binding) => ({ ...binding, channelId: channel!.id })) })), defaultModels: { ...before.settings.defaultModels, imageModel: "canvas-image-a" } },
        });
        expect(seeded.ok(), await seeded.text()).toBe(true);

        await page.goto("/admin?section=channels", { waitUntil: "domcontentloaded" });
        await expect(page.locator('.admin-dashboard-shell[data-hydrated="true"]').filter({ visible: true })).toHaveCount(1);
        await page.getByRole("tab", { name: "逻辑模型" }).click();
        await page.getByRole("tab", { name: "默认与展示排序", exact: true }).click();
        await expect(page.getByText("节点模型显示与排序", { exact: true })).toBeVisible();
        const order = page.locator("[data-logical-model-order]");
        await expect(order).toHaveCount(3);
        await expect.poll(() => order.evaluateAll((rows) => rows.map((row) => row.getAttribute("data-logical-model-order")))).toEqual(["canvas-image-a", "canvas-image-b", "canvas-image-c"]);
        await page.locator('[data-logical-model-order="canvas-image-c"]').dragTo(page.locator('[data-logical-model-order="canvas-image-a"]'));
        await expect.poll(() => order.evaluateAll((rows) => rows.map((row) => row.getAttribute("data-logical-model-order")))).toEqual(["canvas-image-c", "canvas-image-a", "canvas-image-b"]);
        await page.getByRole("switch", { name: "画布图片 A在图片节点显示" }).click();
        await expect(page.getByText("显示 2/3", { exact: true })).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath("logical-model-node-order.png") });
        await page.getByRole("button", { name: "保存模型渠道配置" }).click();
        await expect(page.getByText("模型渠道配置已保存", { exact: true })).toBeVisible();

        const publicResponse = await request.get("/api/auth/session");
        const publicModels = ((await publicResponse.json()) as { settings: { logicalModels: Array<{ id: string; pickerVisible?: boolean }> } }).settings.logicalModels;
        expect(publicModels.map((model) => [model.id, model.pickerVisible])).toEqual([
            ["canvas-image-c", true],
            ["canvas-image-a", false],
            ["canvas-image-b", true],
        ]);

        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto("/admin?section=channels", { waitUntil: "domcontentloaded" });
        await page.getByRole("tab", { name: "逻辑模型" }).click();
        await page.getByRole("tab", { name: "默认与展示排序", exact: true }).click();
        const displayPanel = page.getByText("节点模型显示与排序", { exact: true }).locator("xpath=ancestor::section[1]");
        await expect(displayPanel).toBeVisible();
        await displayPanel.scrollIntoViewIfNeeded();
        const mobileBounds = await displayPanel.boundingBox();
        expect(mobileBounds).not.toBeNull();
        expect(mobileBounds!.x).toBeGreaterThanOrEqual(0);
        expect(mobileBounds!.x + mobileBounds!.width).toBeLessThanOrEqual(391);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
        await page.screenshot({ path: testInfo.outputPath("logical-model-node-order-390.png") });
        await page.setViewportSize({ width: 1280, height: 720 });

        const created = await request.post("/api/canvas/projects", {
            data: {
                title: "节点模型排序 E2E",
                project: { nodes: [{ id: "model-order-config", type: "config", title: "生成配置", position: { x: 120, y: 120 }, width: 320, height: 220, metadata: { generationMode: "image", model: "canvas-image-c" } }], connections: [] },
            },
        });
        expect(created.ok(), await created.text()).toBe(true);
        projectId = ((await created.json()) as { data: { project: { id: string } } }).data.project.id;
        await page.goto(`/canvas/${projectId}`, { waitUntil: "domcontentloaded" });
        const picker = page.locator('[data-node-id="model-order-config"] .canvas-composer-model-picker');
        await picker.click();
        const options = page.getByRole("region", { name: "其他模型", exact: true }).getByRole("option");
        await expect(options).toHaveCount(2);
        await expect(options.nth(0)).toContainText("画布图片 C");
        await expect(options.nth(1)).toContainText("画布图片 B");
        await expect(page.getByRole("option", { name: /画布图片 A/ })).toHaveCount(0);
    } finally {
        if (projectId) await request.delete(`/api/canvas/projects/${projectId}`);
        const restored = await request.patch("/api/admin/settings", { data: { logicalModels: before.settings.logicalModels, defaultModels: before.settings.defaultModels } });
        expect(restored.ok(), await restored.text()).toBe(true);
    }

    function logicalModel(id: string, name: string, upstreamModel: string) {
        return { id, name, capability: "image", enabled: true, bindings: [{ id: `${id}-binding`, channelId: "", upstreamModel, enabled: true, priority: 1 }] };
    }
});

for (const width of [1440, 390, 430]) test(`uploaded model icons persist and restore defaults at ${width}px`, async ({ page, request }, testInfo) => {
    test.slow();
    const before = (await (await request.get("/api/admin/settings")).json()).settings;
    const modelId = "gemini-icon-test";
    const name = "图标验收模型";
    const icon = await sharp({ create: { width: 24, height: 24, channels: 4, background: { r: 255, g: 87, b: 51, alpha: 0.75 } } }).png().toBuffer();
    const iconUrl = `data:image/png;base64,${icon.toString("base64")}`;
    const seededModel = { id: modelId, name, capability: "image", enabled: true, bindings: [{ id: "icon-binding", channelId: "e2e-primary", upstreamModel: "e2e-image", enabled: true, priority: 1 }] };
    const seeded = await request.patch("/api/admin/settings", { data: { logicalModels: [...before.logicalModels.filter((model: { id: string }) => model.id !== modelId), seededModel], defaultModels: { ...before.defaultModels, imageModel: modelId } } });
    expect(seeded.ok(), await seeded.text()).toBe(true);
    let projectId = "";
    try {
        const created = await request.post("/api/canvas/projects", { data: { title: "自定义模型图标验收", project: { nodes: [{ id: "icon-config", type: "config", title: "生成配置", position: { x: 80, y: 100 }, width: 320, height: 220, metadata: { generationMode: "image", model: modelId } }], connections: [] } } });
        expect(created.ok(), await created.text()).toBe(true);
        projectId = (await created.json()).data.project.id;
        await page.setViewportSize({ width, height: width === 1440 ? 900 : 932 });
        for (const theme of ["light", "dark"] as const) {
            const themed = await request.patch("/api/admin/settings", { data: { site: { ...before.site, frontendTheme: theme, adminTheme: theme } } });
            expect(themed.ok(), await themed.text()).toBe(true);
            await page.goto("/admin?section=channels");
            await openEditor();
            if (theme === "dark") await expect(page.locator("html")).toHaveClass(/dark/);
            else await expect(page.locator("html")).not.toHaveClass(/dark/);
            await expect(preview()).toHaveAttribute("src", "/icons/nanobanana.svg");
            await expect(page.getByRole("button", { name: "恢复默认图标" })).toBeDisabled();
            await page.getByLabel("上传模型图标文件").setInputFiles({ name: "invalid.txt", mimeType: "text/plain", buffer: Buffer.from("invalid") });
            await expect(page.getByText("模型图标支持 PNG、JPG、WebP、SVG 或 ICO，文件不能超过 300KB", { exact: true })).toBeVisible();
            await expect(preview()).toHaveAttribute("src", "/icons/nanobanana.svg");
            const chooser = page.waitForEvent("filechooser");
            await page.getByRole("button", { name: "上传自定义图标" }).click();
            await (await chooser).setFiles({ name: "custom-icon.png", mimeType: "image/png", buffer: icon });
            await expect(preview()).toHaveAttribute("src", iconUrl);
            await expect.poll(() => preview().evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth === 24 && getComputedStyle(image).filter === "none")).toBe(true);
            await expect(page.getByRole("button", { name: "恢复默认图标" })).toBeEnabled();
            await expect(page.getByText("模型图标支持 PNG、JPG、WebP、SVG 或 ICO，文件不能超过 300KB", { exact: true })).toBeHidden();
            await expect(page.getByText("图标已读取，应用修改后生效", { exact: true })).toBeHidden();
            const editorBounds = await page.locator("[data-model-icon-editor]").evaluate((editor) => ({ editor: editor.getBoundingClientRect().toJSON(), children: Array.from(editor.children).filter((child) => getComputedStyle(child).display !== "none").map((child) => child.getBoundingClientRect().toJSON()), viewport: innerWidth }));
            expect(editorBounds.children.every((box) => box.x >= 0 && box.right <= editorBounds.viewport + 1)).toBe(true);
            await writeFile(testInfo.outputPath(`icon-editor-${theme}-${width}.json`), JSON.stringify({ buildId: (await readFile(".next/BUILD_ID", "utf8")).trim(), route: "/admin?section=channels", theme, viewport: { width, height: width === 1440 ? 900 : 932 }, state: "自定义图标上传完成", ...editorBounds, image: await preview().evaluate((image: HTMLImageElement) => ({ width: image.naturalWidth, height: image.naturalHeight, filter: getComputedStyle(image).filter, objectFit: getComputedStyle(image).objectFit })) }, null, 2), "utf8");
            await page.screenshot({ path: testInfo.outputPath(`icon-editor-${theme}-${width}.png`) });
            await saveEditor();
            expect((await readModel()).iconUrl).toBe(iconUrl);
            const publicModels = (await (await request.get("/api/auth/session")).json()).settings.logicalModels;
            expect(publicModels.find((model: { id: string }) => model.id === modelId).iconUrl).toBe(iconUrl);
            await page.reload();
            await openEditor();
            await expect(preview()).toHaveAttribute("src", iconUrl);
            await page.getByRole("button", { name: /^取\s*消$/ }).click();

            await page.goto(`/canvas/${projectId}`);
            const picker = page.locator('[data-node-id="icon-config"] .canvas-composer-model-picker');
            await expect(picker.locator("img")).toHaveAttribute("src", iconUrl);
            await picker.click();
            await expect(page.locator(`[data-model-id="${modelId}"] img`).last()).toHaveAttribute("src", iconUrl);
            await page.screenshot({ path: testInfo.outputPath(`icon-canvas-${theme}-${width}.png`) });
            await page.goto("/create?mode=image");
            const workbenchPicker = page.locator(".canvas-composer-model-picker").filter({ visible: true }).first();
            await workbenchPicker.click();
            const workbenchOption = page.locator(`[data-model-id="${modelId}"]`).last();
            await expect(workbenchOption.locator("img")).toHaveAttribute("src", iconUrl);
            await workbenchOption.click();
            await expect(workbenchPicker.locator("img")).toHaveAttribute("src", iconUrl);
            await page.screenshot({ path: testInfo.outputPath(`icon-workbench-${theme}-${width}.png`) });

            const currentSettings = (await (await request.get("/api/admin/settings")).json()).settings;
            const broken = await request.patch("/api/admin/settings", { data: { logicalModels: currentSettings.logicalModels.map((model: { id: string }) => model.id === modelId ? { ...model, iconUrl: "data:image/png;base64,YQ==" } : model) } });
            expect(broken.ok(), await broken.text()).toBe(true);
            await page.goto("/admin?section=channels");
            await openEditor();
            await expect(preview()).toHaveAttribute("src", "/icons/nanobanana.svg");
            await page.getByRole("button", { name: "恢复默认图标" }).click();
            await expect(preview()).toHaveAttribute("src", "/icons/nanobanana.svg");
            await page.screenshot({ path: testInfo.outputPath(`icon-restored-${theme}-${width}.png`) });
            await saveEditor();
            expect(await readModel()).not.toHaveProperty("iconUrl");
            expect(await readModel()).not.toHaveProperty("icon");
            await page.reload();
            await openEditor();
            await expect(preview()).toHaveAttribute("src", "/icons/nanobanana.svg");
            await page.getByRole("combobox", { name: "模型内置图标" }).click();
            await page.locator(".ant-select-dropdown:visible").getByText("OpenAI", { exact: true }).click();
            await expect(preview()).toHaveAttribute("src", "/icons/openai.svg");
            await page.getByRole("button", { name: "恢复默认图标" }).click();
            await saveEditor();
        }
    } finally {
        if (projectId) await request.delete(`/api/canvas/projects/${projectId}`);
        const restored = await request.patch("/api/admin/settings", { data: { site: before.site, logicalModels: before.logicalModels, defaultModels: before.defaultModels } });
        expect(restored.ok(), await restored.text()).toBe(true);
    }
    function preview() { return page.getByLabel("模型图标预览").locator("img"); }
    async function openEditor() {
        await expect(page.locator('.admin-dashboard-shell[data-hydrated="true"]').filter({ visible: true })).toHaveCount(1);
        await page.getByRole("tab", { name: "逻辑模型", exact: true }).click();
        await page.getByRole("button", { name: `编辑 ${name}`, exact: true }).click();
        await expect(page.getByText("编辑逻辑模型", { exact: true })).toBeVisible();
    }
    async function saveEditor() {
        const saved = page.waitForResponse((response) => response.request().method() === "PATCH" && new URL(response.url()).pathname === "/api/admin/settings");
        await page.getByRole("button", { name: "应用修改", exact: true }).click();
        const response = await saved;
        expect(response.ok(), await response.text()).toBe(true);
    }
    async function readModel() {
        const response = await request.get("/api/admin/settings");
        expect(response.ok(), await response.text()).toBe(true);
        const model = (await response.json()).settings.logicalModels.find((model: { id: string }) => model.id === modelId);
        if (process.env.DREAMYO_E2E_DATABASE_URL) {
            const client = new Client({ connectionString: process.env.DREAMYO_E2E_DATABASE_URL });
            await client.connect();
            try {
                const result = await client.query("SELECT logical_models FROM dreamyo_app_settings WHERE id = 'default'");
                expect(result.rows[0].logical_models.find((stored: { id: string }) => stored.id === modelId).iconUrl).toBe(model.iconUrl);
            } finally { await client.end(); }
        }
        return model;
    }
});

test("new Agent Skill is saved before leaving the administrator page", async ({ page, request }) => {
    const beforeResponse = await request.get("/api/admin/settings");
    expect(beforeResponse.ok(), await beforeResponse.text()).toBe(true);
    const before = ((await beforeResponse.json()) as { settings: { agentSkills: unknown[] } }).settings.agentSkills;
    const skillName = `E2E 持久 Skill ${randomUUID().slice(0, 8)}`;

    try {
        await page.goto("/admin?section=skills");
        await page.getByRole("button", { name: "新增 Skill" }).click();
        await page.getByText("手动创建", { exact: true }).click();
        await page.getByLabel("Skill 名称").fill(skillName);
        await page.getByLabel("执行规则").fill("保持用户需求不变，按当前工作台能力规划并执行。");
        await page.getByRole("button", { name: "添加并保存" }).click();
        await expect(page.getByLabel("当前密码")).toHaveCount(0);
        await expect(page.getByText("Agent Skill 已添加并保存", { exact: true })).toBeVisible();

        await page.goto("/create");
        await page.goto("/admin?section=skills");
        await expect(page.getByRole("main").getByText(skillName, { exact: true })).toBeVisible();

        const persistedResponse = await request.get("/api/admin/settings");
        expect(persistedResponse.ok(), await persistedResponse.text()).toBe(true);
        const persisted = ((await persistedResponse.json()) as { settings: { agentSkills: Array<{ name?: string }> } }).settings.agentSkills;
        expect(persisted.some((skill) => skill.name === skillName)).toBe(true);
    } finally {
        const restored = await request.patch("/api/admin/settings", { data: { agentSkills: before } });
        expect(restored.ok(), await restored.text()).toBe(true);
    }
});

test("PostgreSQL payment flow verifies missing fields, rejects trade reuse, and refunds", async ({ request }) => {
    test.skip(!process.env.DREAMYO_E2E_DATABASE_URL, "需要专用 PostgreSQL E2E 数据库");
    const productResponse = await request.post("/api/admin/billing/products", {
        data: { productKind: "points", name: `E2E 积分包 ${randomUUID().slice(0, 8)}`, description: "E2E", amountCents: 100, currency: "CNY", pointsAmount: 100, enabled: true },
    });
    expect(productResponse.ok(), await productResponse.text()).toBe(true);
    const product = ((await productResponse.json()) as { product: { id: string } }).product;

    const firstOrder = await createOrder(request, product.id);
    const checkout = await request.post(`/api/billing/orders/${firstOrder.id}/checkout`, { data: { provider: "payply" } });
    expect(checkout.ok(), await checkout.text()).toBe(true);
    expect(await checkout.json()).toMatchObject({ code: 0, data: { checkout: { kind: "redirect", provider: "payply" } } });

    const firstWebhookBody = JSON.stringify({ eventId: `event-${randomUUID()}`, status: "succeeded", orderId: firstOrder.id, orderNo: firstOrder.orderNo, providerTradeId: "payply_trade_e2e", providerPaymentId: "payply_payment_e2e" });
    const firstWebhook = await postSignedWebhook(request, firstWebhookBody);
    expect(firstWebhook.ok(), await firstWebhook.text()).toBe(true);
    expect(await firstWebhook.json()).toMatchObject({ orderId: firstOrder.id, orderStatus: "paid" });
    const duplicate = await postSignedWebhook(request, firstWebhookBody);
    expect(duplicate.ok()).toBe(true);
    expect(await duplicate.json()).toMatchObject({ duplicate: true, orderId: firstOrder.id });

    const secondOrder = await createOrder(request, product.id);
    const conflictBody = JSON.stringify({ eventId: `event-${randomUUID()}`, status: "succeeded", orderId: secondOrder.id, orderNo: secondOrder.orderNo, providerTradeId: "payply_trade_e2e", providerPaymentId: "payply_payment_conflict" });
    const conflict = await postSignedWebhook(request, conflictBody);
    expect(conflict.status()).toBe(409);

    const refund = await request.post(`/api/admin/billing/orders/${firstOrder.id}/refund`, { data: { reason: "E2E 退款" } });
    expect(refund.ok(), await refund.text()).toBe(true);
    expect(await refund.json()).toMatchObject({ order: { id: firstOrder.id, status: "refunded" }, providerRefund: { provider: "payply", status: "succeeded" } });
});

async function createOrder(request: APIRequestContext, productId: string) {
    const response = await request.post("/api/billing/orders", { data: { productId, quantity: 1, provider: "payply" } });
    expect(response.ok(), await response.text()).toBe(true);
    return ((await response.json()) as { order: { id: string; orderNo: string } }).order;
}

async function postSignedWebhook(request: APIRequestContext, rawBody: string) {
    const signature = createHmac("sha256", E2E_PAYMENT_WEBHOOK_SECRET).update(rawBody).digest("hex");
    return request.post("/api/billing/webhooks/payply", { data: rawBody, headers: { "content-type": "application/json", "x-dreamyo-signature": signature } });
}

for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 390, height: 844 },
    { width: 430, height: 932 },
]) {
    for (const theme of ["light", "dark"]) {
        test(`prompt rules save, reload and fit ${viewport.width}px ${theme}`, async ({ page, request }, testInfo) => {
            const response = await request.get("/api/admin/settings");
            expect(response.ok()).toBe(true);
            const before = (await response.json()).settings;
            try {
                await request.patch("/api/admin/settings", { data: { site: { ...before.site, adminTheme: theme } } });
                await page.setViewportSize(viewport);
                await page.goto("/admin?section=settings", { waitUntil: "domcontentloaded" });
                await expect(page.locator(".admin-dashboard-shell")).toHaveAttribute("data-hydrated", "true");
                await page.getByRole("tab", { name: "生成控制" }).click();
                const toggle = page.getByRole("switch", { name: "图片参考素材约束开关", exact: true });
                const content = page.getByRole("textbox", { name: "图片参考素材约束内容", exact: true });
                await expect(toggle).toHaveAttribute("aria-checked", "true");
                await toggle.click();
                await content.fill("只保留 {{referenceLabelsZh}} 的面部身份。\n允许按用户要求修改服饰。");
                await page.getByRole("button", { name: "保存系统设置" }).click();
                await expect(page.getByText("系统设置已保存", { exact: true })).toBeVisible();
                await expect(toggle).toHaveAttribute("aria-checked", "false");
                const saved = (await (await request.get("/api/admin/settings")).json()).settings;
                expect(saved.generationDefaults.promptRules.imageReference).toEqual({ enabled: false, content: "只保留 {{referenceLabelsZh}} 的面部身份。\n允许按用户要求修改服饰。" });
                expect(JSON.stringify((await (await request.get("/api/auth/session")).json()).settings)).not.toContain("promptRules");
                await page.reload({ waitUntil: "domcontentloaded" });
                await page.getByRole("tab", { name: "生成控制" }).click();
                await expect(toggle).toHaveAttribute("aria-checked", "false");
                await expect(content).toHaveValue(saved.generationDefaults.promptRules.imageReference.content);
                await toggle.click();
                await page.getByRole("button", { name: "保存系统设置" }).click();
                await expect(page.getByText("系统设置已保存", { exact: true })).toBeVisible();
                expect((await (await request.get("/api/admin/settings")).json()).settings.generationDefaults.promptRules.imageReference.enabled).toBe(true);
                await content.scrollIntoViewIfNeeded();
                const geometry = await page.locator("[data-prompt-rule=imageReference]").evaluate((element) => {
                    const rect = element.getBoundingClientRect();
                    const input = element.querySelector("textarea")!.getBoundingClientRect();
                    return {
                        left: rect.left,
                        right: rect.right,
                        inputLeft: input.left,
                        inputRight: input.right,
                        viewport: innerWidth,
                        display: getComputedStyle(element.parentElement!).display,
                        overflow: document.documentElement.scrollWidth - innerWidth,
                    };
                });
                expect(geometry.display).toBe("grid");
                expect(geometry.left).toBeGreaterThanOrEqual(0);
                expect(geometry.right).toBeLessThanOrEqual(geometry.viewport);
                expect(geometry.inputLeft).toBeGreaterThanOrEqual(geometry.left);
                expect(geometry.inputRight).toBeLessThanOrEqual(geometry.right);
                expect(geometry.overflow).toBeLessThanOrEqual(0);
                await page.screenshot({ path: testInfo.outputPath(`prompt-rules-${viewport.width}-${theme}.png`) });
            } finally {
                const restored = await request.patch("/api/admin/settings", { data: { site: before.site, generationDefaults: before.generationDefaults } });
                expect(restored.ok()).toBe(true);
            }
        });
    }
}

test("all prompt rule switches and contents persist independently", async ({ page, request }) => {
    const before = (await (await request.get("/api/admin/settings")).json()).settings.generationDefaults;
    const labels = {
        imageReference: "图片参考素材约束",
        sub2ApiImageReference: "Sub2API 图片编辑约束",
        panorama: "全景节点输出约束",
        videoReference: "视频参考素材约束",
        videoFirstFrame: "视频首帧约束",
        videoFirstLastFrame: "视频首尾帧约束",
        minimaxH3Base: "MiniMax H3 文生 / 首尾帧包装",
        minimaxH3Reference: "MiniMax H3 多模态参考包装",
        minimaxH3Bindings: "MiniMax H3 素材绑定说明",
        image: "图片通用优化规则",
        video: "视频通用优化规则",
        text: "文本通用优化规则",
        audio: "音频通用优化规则",
    };
    try {
        await page.goto("/admin?section=settings", { waitUntil: "domcontentloaded" });
        await expect(page.locator(".admin-dashboard-shell")).toHaveAttribute("data-hydrated", "true");
        await page.getByRole("tab", { name: "生成控制" }).click();
        for (const [key, label] of Object.entries(labels)) {
            const toggle = page.getByRole("switch", { name: `${label}开关`, exact: true });
            if ((await toggle.getAttribute("aria-checked")) === "true") await toggle.click();
            await page.getByRole("textbox", { name: `${label}内容`, exact: true }).fill(key === "panorama" ? "" : `${label} 自定义内容\n第二行`);
        }
        await page.getByRole("button", { name: "保存系统设置" }).click();
        await expect(page.getByText("系统设置已保存", { exact: true })).toBeVisible();
        const saved = (await (await request.get("/api/admin/settings")).json()).settings.generationDefaults.promptRules;
        for (const [key, label] of Object.entries(labels)) expect(saved[key]).toEqual({ enabled: false, content: key === "panorama" ? "" : `${label} 自定义内容\n第二行` });
        await page.reload({ waitUntil: "domcontentloaded" });
        await page.getByRole("tab", { name: "生成控制" }).click();
        for (const [key, label] of Object.entries(labels)) {
            const toggle = page.getByRole("switch", { name: `${label}开关`, exact: true });
            await expect(toggle).toHaveAttribute("aria-checked", "false");
            await expect(page.getByRole("textbox", { name: `${label}内容`, exact: true })).toHaveValue(saved[key].content);
            await toggle.click();
        }
        await page.getByRole("button", { name: "保存系统设置" }).click();
        await expect(page.getByText("系统设置已保存", { exact: true })).toBeVisible();
        const enabled = (await (await request.get("/api/admin/settings")).json()).settings.generationDefaults.promptRules;
        for (const key of Object.keys(labels)) expect(enabled[key]).toEqual({ ...saved[key], enabled: true });
    } finally {
        expect((await request.patch("/api/admin/settings", { data: { generationDefaults: before } })).ok()).toBe(true);
    }
});
