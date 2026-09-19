import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { E2E_ADMIN } from "./support";

const evidenceRoot = path.resolve(process.cwd(), "../docs/ui-rebuild-20260913/evidence");
const tinyPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

test.describe.configure({ mode: "serial" });

test("content library renders persisted assets in C01", async ({ page, request }, testInfo) => {
    test.setTimeout(120_000);
    const suffix = randomUUID().slice(0, 8);
    const title = `内容库视觉素材 ${suffix}`;
    const buildId = await readCurrentBuildId();
    const assetIds: string[] = [];
    await mkdir(evidenceRoot, { recursive: true });
    try {
        for (const [index, content] of ["真实文本素材用于视觉验收", "第二条素材用于搜索和卡片状态"].entries()) {
            const response = await request.post("/api/library-assets", {
                data: { kind: "text", title: `${title} ${index + 1}`, coverUrl: "", tags: ["验收", "内容库"], source: "隔离视觉夹具", note: "动态实体验收", data: { content } },
            });
            expect(response.ok(), await response.text()).toBe(true);
            assetIds.push(((await response.json()) as { data: { asset: { id: string } } }).data.asset.id);
        }

        for (const theme of ["light", "dark"] as const) {
            await setTheme(page, theme);
            await page.goto("/assets", { waitUntil: "domcontentloaded" });
            await expect(page.getByRole("heading", { name: "我的素材", exact: true })).toBeVisible();
            const search = page.locator("main").getByPlaceholder("搜索标题、内容、标签或来源").first();
            await search.fill(title);
            await expect(page.getByText(`${title} 1`, { exact: true })).toBeVisible();
            const card = page.getByText(`${title} 1`, { exact: true }).locator("xpath=ancestor::article[1]");
            const measurement = {
                ...(await card.evaluate((element, state) => {
                    const rect = element.getBoundingClientRect();
                    return {
                        route: "/assets",
                        viewport: { width: innerWidth, height: innerHeight, zoom: visualViewport?.scale || 1 },
                        theme: document.documentElement.classList.contains("dark") ? "dark" : "light",
                        state,
                        card: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
                        overflow: document.documentElement.scrollWidth > innerWidth || document.body.scrollWidth > innerWidth,
                    };
                }, "已保存真实素材")),
                buildId,
            };
            expect(measurement.theme).toBe(theme);
            expect(measurement.overflow).toBe(false);
            expect(measurement.card.width).toBeGreaterThan(0);
            const stem = `after-content-library-${theme}-${testInfo.project.name}`;
            await page.screenshot({ path: path.join(evidenceRoot, `${stem}.png`), fullPage: false });
            await writeFile(path.join(evidenceRoot, `${stem}.json`), `${JSON.stringify({ ...measurement, entity: title }, null, 2)}\n`, "utf8");
        }
    } finally {
        for (const id of assetIds) await deleteIfPresent(request, `/api/library-assets/${encodeURIComponent(id)}`);
    }
});

test("content library covers pagination, edit, delete, loading and error states", async ({ page, request }, testInfo) => {
    test.setTimeout(150_000);
    const suffix = randomUUID().slice(0, 8);
    const title = `内容库状态素材 ${suffix}`;
    const buildId = await readCurrentBuildId();
    const assetIds: string[] = [];
    await mkdir(evidenceRoot, { recursive: true });
    const writeStateEvidence = async (state: string, stem: string) => {
        const measurement = await page
            .locator("main")
            .first()
            .evaluate((element, payload) => {
                const rect = element.getBoundingClientRect();
                return {
                    route: "/assets",
                    viewport: { width: innerWidth, height: innerHeight, zoom: visualViewport?.scale || 1 },
                    theme: document.documentElement.classList.contains("dark") ? "dark" : "light",
                    state: payload,
                    main: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
                    overflow: document.documentElement.scrollWidth > innerWidth || document.body.scrollWidth > innerWidth,
                };
            }, state);
        expect(measurement.overflow).toBe(false);
        await page.screenshot({ path: path.join(evidenceRoot, `${stem}-${testInfo.project.name}.png`), fullPage: false });
        await writeFile(path.join(evidenceRoot, `${stem}-${testInfo.project.name}.json`), `${JSON.stringify({ ...measurement, buildId, entity: title }, null, 2)}\n`, "utf8");
    };
    try {
        for (let index = 1; index <= 11; index += 1) {
            const response = await request.post("/api/library-assets", {
                data: { kind: "text", title: `${title} ${index}`, coverUrl: "", tags: ["状态矩阵"], source: "隔离视觉夹具", note: "分页与状态验收", data: { content: `第 ${index} 条可持久化内容` } },
            });
            expect(response.ok(), await response.text()).toBe(true);
            assetIds.push(((await response.json()) as { data: { asset: { id: string } } }).data.asset.id);
        }

        await setTheme(page, "light");
        await page.goto("/assets", { waitUntil: "domcontentloaded" });
        await expect(page.getByRole("heading", { name: "我的素材", exact: true })).toBeVisible();
        const search = page.locator("main").getByPlaceholder("搜索标题、内容、标签或来源").first();
        await search.fill(title);
        await expect(page.getByText(`${title} 11`, { exact: true })).toBeVisible();
        await expect(page.getByText(`${title} 1`, { exact: true })).toHaveCount(0);
        await writeStateEvidence("已保存真实素材，第 1 页", "after-content-library-pagination-page-1");
        const nextPage = page.locator(".ant-pagination-next:not(.ant-pagination-disabled)").first();
        await expect(nextPage).toBeEnabled();
        await nextPage.click();
        await expect(page.getByText(`${title} 1`, { exact: true })).toBeVisible();
        await writeStateEvidence("分页第 2 页", "after-content-library-pagination-page-2");

        const firstCard = page.getByText(`${title} 1`, { exact: true }).locator("xpath=ancestor::article[1]");
        await firstCard.locator('button[aria-label^="编辑 "]').click();
        const editDialog = page.getByRole("dialog");
        await expect(editDialog.getByText("编辑素材", { exact: true })).toBeVisible();
        await editDialog.getByLabel("标题", { exact: true }).fill(`${title} 1 已编辑`);
        await editDialog.getByLabel("文本内容", { exact: true }).fill("编辑后的状态矩阵内容");
        const saveButton = editDialog.getByRole("button", { name: /保\s*存/ });
        await expect(saveButton).toBeVisible();
        const [patchResult] = await Promise.all([page.waitForResponse((response) => response.url().includes("/api/library-assets/") && response.request().method() === "PATCH"), saveButton.click({ timeout: 5000 })]);
        expect(patchResult.ok(), await patchResult.text()).toBe(true);
        await expect(editDialog).toBeHidden();
        await search.fill(`${title} 1 已编辑`);
        await expect(page.getByText(`${title} 1 已编辑`, { exact: true })).toBeVisible();
        await writeStateEvidence("编辑保存后", "after-content-library-edit-saved");

        const editedCard = page.getByText(`${title} 1 已编辑`, { exact: true }).locator("xpath=ancestor::article[1]");
        await editedCard.locator('button[aria-label^="删除 "]').click();
        const deleteDialog = page.getByRole("dialog");
        await expect(deleteDialog.getByText("删除素材", { exact: true })).toBeVisible();
        const deleteResponse = page.waitForResponse((response) => response.url().includes("/api/library-assets/") && response.request().method() === "DELETE" && response.ok());
        await deleteDialog.getByRole("button", { name: /删\s*除/ }).click();
        await deleteResponse;
        await expect(page.getByText(`${title} 1 已编辑`, { exact: true })).toHaveCount(0);
        await writeStateEvidence("删除持久化后", "after-content-library-delete-saved");

        await page.unroute("**/api/library-assets**");
        let releaseLoading!: () => void;
        const loadingGate = new Promise<void>((resolve) => {
            releaseLoading = resolve;
        });
        await page.route("**/api/library-assets**", async (route) => {
            if (route.request().method() === "GET") await loadingGate;
            await route.continue();
        });
        await page.goto("/assets", { waitUntil: "domcontentloaded" });
        await expect(page.getByRole("status", { name: "正在加载素材" })).toBeVisible();
        await writeStateEvidence("列表加载中", "after-content-library-loading");
        releaseLoading();
        await expect(page.getByText(`${title} 2`, { exact: true })).toBeVisible();
        await page.unroute("**/api/library-assets**");

        await page.route("**/api/library-assets**", async (route) => {
            if (route.request().method() === "GET") {
                await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ code: "STATE_MATRIX_FAILURE", msg: "状态矩阵故障" }) });
                return;
            }
            await route.continue();
        });
        await page.goto("/assets", { waitUntil: "domcontentloaded" });
        await expect(page.getByText("状态矩阵故障", { exact: true })).toBeVisible();
        await writeStateEvidence("列表请求失败", "after-content-library-error");
        await page.unroute("**/api/library-assets**");
    } finally {
        for (const id of assetIds) await deleteIfPresent(request, `/api/library-assets/${encodeURIComponent(id)}`);
    }
});

test("my prompts and prompt library cover persisted CRUD plus loading and error states", async ({ page, request }, testInfo) => {
    test.setTimeout(180_000);
    const suffix = randomUUID().slice(0, 8);
    const title = `账户提示词视觉验收 ${suffix}`;
    const editedTitle = `${title} 已编辑`;
    const buildId = await readCurrentBuildId();
    await mkdir(evidenceRoot, { recursive: true });
    let promptId = "";
    try {
        // Create through the real page so the evidence covers the same
        // authenticated form path as a user, rather than only the API.
        await setTheme(page, "light");
        await page.goto("/my-prompts", { waitUntil: "domcontentloaded" });
        await expect(page.getByRole("heading", { name: "我的提示词", exact: true })).toBeVisible();
        await page.getByRole("button", { name: "添加提示词" }).click();
        const createDialog = page.getByRole("dialog", { name: "添加提示词" });
        await expect(createDialog).toBeVisible();
        await createDialog.getByLabel("标题", { exact: true }).fill(title);
        await createDialog.getByLabel("提示词内容", { exact: true }).fill("一张清晰的创意产品海报");
        await createDialog.getByRole("button", { name: "保存提示词", exact: true }).click();
        await expect(page.getByText("提示词已保存", { exact: true })).toBeVisible();
        await expect(page.getByText(title, { exact: true })).toBeVisible();
        const listResponse = await request.get("/api/my-prompts?page=1&pageSize=100");
        expect(listResponse.ok(), await listResponse.text()).toBe(true);
        const list = (await listResponse.json()) as { items: Array<{ id: string; title: string }> };
        promptId = list.items.find((item) => item.title === title)?.id || "";
        expect(promptId).toBeTruthy();

        for (const theme of ["light", "dark"] as const) {
            await setTheme(page, theme);
            await page.goto("/my-prompts", { waitUntil: "domcontentloaded" });
            await expect(page.getByRole("heading", { name: "我的提示词", exact: true })).toBeVisible();
            const visibleTitle = theme === "light" ? title : editedTitle;
            await expect(page.getByText(visibleTitle, { exact: true })).toBeVisible();
            const row = page.getByText(visibleTitle, { exact: true }).locator("xpath=ancestor::tr[1]");
            const rowRect = await row.boundingBox();
            expect(rowRect?.width || 0).toBeGreaterThan(0);
            const measurement = await page.evaluate(
                (state) => ({
                    route: "/my-prompts",
                    theme: document.documentElement.classList.contains("dark") ? "dark" : "light",
                    viewport: { width: innerWidth, height: innerHeight, zoom: visualViewport?.scale || 1 },
                    state,
                    overflow: document.documentElement.scrollWidth > innerWidth || document.body.scrollWidth > innerWidth,
                }),
                "真实提示词已保存",
            );
            expect(measurement.theme).toBe(theme);
            expect(measurement.overflow).toBe(false);
            await page.screenshot({ path: path.join(evidenceRoot, `after-my-prompts-persisted-${theme}-${testInfo.project.name}.png`), fullPage: false });
            await writeFile(path.join(evidenceRoot, `after-my-prompts-persisted-${theme}-${testInfo.project.name}.json`), `${JSON.stringify({ ...measurement, entity: visibleTitle, buildId }, null, 2)}\n`, "utf8");

            if (theme === "light") {
                await row.getByRole("button", { name: `编辑提示词 ${title}` }).click();
                const dialog = page.getByRole("dialog", { name: "编辑提示词" });
                await expect(dialog).toBeVisible();
                await dialog.getByLabel("标题", { exact: true }).fill(editedTitle);
                await dialog.getByLabel("提示词内容", { exact: true }).fill("编辑后的账户提示词内容");
                const patchResponse = page.waitForResponse((response) => response.url().includes(`/api/my-prompts/${promptId}`) && response.request().method() === "PATCH");
                await dialog.getByRole("button", { name: "保存修改", exact: true }).click();
                expect((await patchResponse).ok()).toBe(true);
                await expect(dialog).toBeHidden();
                await expect(page.getByText(editedTitle, { exact: true })).toBeVisible();
            }
        }

        await page.getByText(editedTitle, { exact: true }).locator("xpath=ancestor::tr[1]").getByRole("button", { name: "删除提示词" }).click();
        await expect(page.getByText("删除提示词？", { exact: true })).toBeVisible();
        const deleteResponse = page.waitForResponse((response) => response.url().includes(`/api/my-prompts/${promptId}`) && response.request().method() === "DELETE");
        const confirm = page.locator(".ant-popconfirm:visible");
        await expect(confirm).toHaveCount(1);
        await confirm.locator(".ant-popconfirm-buttons .ant-btn-primary").click();
        expect((await deleteResponse).ok()).toBe(true);
        await expect(page.getByText(editedTitle, { exact: true })).toHaveCount(0);

        await setTheme(page, "light");
        await page.unroute("**/api/prompts**");
        let releaseLoading!: () => void;
        const loadingGate = new Promise<void>((resolve) => {
            releaseLoading = resolve;
        });
        await page.route("**/api/prompts**", async (route) => {
            if (route.request().method() === "GET") await loadingGate;
            await route.continue();
        });
        await page.goto("/prompts", { waitUntil: "domcontentloaded" });
        await expect(page.getByRole("heading", { name: "提示词库", exact: true })).toBeVisible();
        await expect(page.getByRole("status", { name: "正在加载提示词" })).toBeVisible();
        const loadingMeasurement = await page.evaluate(() => ({
            route: "/prompts",
            theme: document.documentElement.classList.contains("dark") ? "dark" : "light",
            viewport: { width: innerWidth, height: innerHeight, zoom: visualViewport?.scale || 1 },
            state: "提示词库加载中",
            overflow: document.documentElement.scrollWidth > innerWidth || document.body.scrollWidth > innerWidth,
        }));
        expect(loadingMeasurement.overflow).toBe(false);
        await page.screenshot({ path: path.join(evidenceRoot, `after-prompts-loading-${testInfo.project.name}.png`), fullPage: false });
        await writeFile(path.join(evidenceRoot, `after-prompts-loading-${testInfo.project.name}.json`), `${JSON.stringify({ ...loadingMeasurement, buildId }, null, 2)}\n`, "utf8");
        releaseLoading();
        await expect(page.getByRole("status", { name: "正在加载提示词" })).toHaveCount(0);
        await page.unroute("**/api/prompts**");

        await page.route("**/api/prompts**", async (route) => {
            if (route.request().method() === "GET") {
                await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ code: "PROMPT_MATRIX_FAILURE", msg: "提示词库暂时不可用" }) });
                return;
            }
            await route.continue();
        });
        await page.goto("/prompts", { waitUntil: "domcontentloaded" });
        await expect(page.getByText("获取提示词失败", { exact: true })).toBeVisible();
        const errorMeasurement = await page.evaluate(() => ({
            route: "/prompts",
            theme: document.documentElement.classList.contains("dark") ? "dark" : "light",
            viewport: { width: innerWidth, height: innerHeight, zoom: visualViewport?.scale || 1 },
            state: "提示词库请求失败",
            overflow: document.documentElement.scrollWidth > innerWidth || document.body.scrollWidth > innerWidth,
        }));
        expect(errorMeasurement.overflow).toBe(false);
        await page.screenshot({ path: path.join(evidenceRoot, `after-prompts-error-${testInfo.project.name}.png`), fullPage: false });
        await writeFile(path.join(evidenceRoot, `after-prompts-error-${testInfo.project.name}.json`), `${JSON.stringify({ ...errorMeasurement, buildId }, null, 2)}\n`, "utf8");
        await page.unroute("**/api/prompts**");
    } finally {
        if (promptId) await request.delete(`/api/my-prompts/${encodeURIComponent(promptId)}`).catch(() => undefined);
    }
});

test("works and public share render a persisted media publication", async ({ page, request }, testInfo) => {
    test.setTimeout(150_000);
    const suffix = randomUUID().slice(0, 8);
    const title = `公开作品视觉验收 ${suffix}`;
    const buildId = await readCurrentBuildId();
    let canvasId = "";
    let workId = "";
    let storageKey = "";
    let slug = "";
    await mkdir(evidenceRoot, { recursive: true });
    try {
        const uploaded = await request.post("/api/reference-assets", { data: { dataUrl: `data:image/png;base64,${tinyPng}`, type: "image", persistent: true, originalName: `visual-${suffix}.png` } });
        expect(uploaded.ok(), await uploaded.text()).toBe(true);
        const media = (await uploaded.json()) as { url: string; key: string };
        storageKey = media.key;
        const canvasResponse = await request.post("/api/canvas/projects", {
            data: {
                title: `发布来源画布 ${suffix}`,
                project: {
                    viewport: { x: 0, y: 0, k: 1 },
                    nodes: [
                        {
                            id: `image-${suffix}`,
                            type: "image",
                            title: "公开作品图片",
                            position: { x: 120, y: 120 },
                            width: 320,
                            height: 240,
                            metadata: { status: "success", content: media.url, serverUrl: media.url, storageKey, mimeType: "image/png", width: 1, height: 1 },
                        },
                    ],
                    connections: [],
                },
            },
        });
        expect(canvasResponse.ok(), await canvasResponse.text()).toBe(true);
        canvasId = ((await canvasResponse.json()) as { data: { project: { id: string } } }).data.project.id;

        const workResponse = await request.post("/api/works", {
            data: {
                sourceType: "canvas",
                sourceId: canvasId,
                title,
                description: "真实隔离实体公开作品",
                publicPrompt: "一张清晰的创意作品",
                category: "视觉设计",
                tags: ["dreamyo", "验收"],
                visibility: "public",
                authorDisplay: "profile",
                assetStorageKeys: [storageKey],
                coverStorageKey: storageKey,
            },
        });
        expect(workResponse.ok(), await workResponse.text()).toBe(true);
        const work = ((await workResponse.json()) as { data: { work: { id: string; slug: string } } }).data.work;
        workId = work.id;
        slug = work.slug;
        const submitResponse = await request.post(`/api/works/${encodeURIComponent(workId)}/submit`);
        expect(submitResponse.ok(), await submitResponse.text()).toBe(true);
        const submitted = (await submitResponse.json()) as { data: { work: { currentVersion?: { id: string } } } };
        const versionId = submitted.data.work.currentVersion?.id;
        expect(versionId).toBeTruthy();
        const reviewResponse = await request.post(`/api/admin/works/${encodeURIComponent(workId)}/review`, { data: { versionId, decision: "approved" } });
        expect(reviewResponse.ok(), await reviewResponse.text()).toBe(true);

        for (const theme of ["light", "dark"] as const) {
            await setTheme(page, theme);
            await page.goto("/works", { waitUntil: "domcontentloaded" });
            await expect(page.getByRole("heading", { name: "作品管理", exact: true })).toBeVisible();
            await expect(page.getByText(title, { exact: true }).first()).toBeVisible();
            const workCard = page.getByText(title, { exact: true }).locator("xpath=ancestor::article[1]");
            const workMeasurement = {
                ...(await workCard.evaluate((element, state) => {
                    const rect = element.getBoundingClientRect();
                    return {
                        route: "/works",
                        viewport: { width: innerWidth, height: innerHeight, zoom: visualViewport?.scale || 1 },
                        theme: document.documentElement.classList.contains("dark") ? "dark" : "light",
                        state,
                        card: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
                        overflow: document.documentElement.scrollWidth > innerWidth || document.body.scrollWidth > innerWidth,
                    };
                }, "已保存真实作品发布记录")),
                buildId,
            };
            expect(workMeasurement.overflow).toBe(false);
            const workStem = `after-work-publication-${theme}-${testInfo.project.name}`;
            await page.screenshot({ path: path.join(evidenceRoot, `${workStem}.png`), fullPage: false });
            await writeFile(path.join(evidenceRoot, `${workStem}.json`), `${JSON.stringify({ ...workMeasurement, entity: title }, null, 2)}\n`, "utf8");

            await page.goto("/community", { waitUntil: "domcontentloaded" });
            await expect(page.getByRole("heading", { name: "灵感发现", exact: true })).toBeVisible();
            const communityTitle = page.getByText(title, { exact: true }).first();
            await expect(communityTitle).toBeVisible();
            const communityCard = communityTitle.locator("xpath=ancestor::article[1]");
            await expect(communityCard.locator('img[src*="format=webp"]'), "作品广场媒体必须使用限宽 WebP 预览").toHaveCount(1);

            await page.goto(`/share/${encodeURIComponent(slug)}`, { waitUntil: "domcontentloaded" });
            await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
            await expect(page.getByRole("heading", { name: "公开提示词", exact: true })).toBeVisible();
            await expect(page.locator('img[src*="format=webp"]'), "公开分享媒体必须使用限宽 WebP 预览").not.toHaveCount(0);
            const shareMeasurement = {
                ...(await page
                    .locator("main")
                    .first()
                    .evaluate(
                        (element, payload) => {
                            const rect = element.getBoundingClientRect();
                            return {
                                route: `/share/${payload.slug}`,
                                viewport: { width: innerWidth, height: innerHeight, zoom: visualViewport?.scale || 1 },
                                theme: document.documentElement.classList.contains("dark") ? "dark" : "light",
                                state: payload.state,
                                main: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
                                overflow: document.documentElement.scrollWidth > innerWidth || document.body.scrollWidth > innerWidth,
                            };
                        },
                        { slug, state: "公开分享真实媒体与提示词" },
                    )),
                buildId,
            };
            expect(shareMeasurement.overflow).toBe(false);
            const shareStem = `after-public-share-${theme}-${testInfo.project.name}`;
            await page.screenshot({ path: path.join(evidenceRoot, `${shareStem}.png`), fullPage: false });
            await writeFile(path.join(evidenceRoot, `${shareStem}.json`), `${JSON.stringify({ ...shareMeasurement, entity: title }, null, 2)}\n`, "utf8");

            await page.goto(`/u/${encodeURIComponent(E2E_ADMIN.username)}`, { waitUntil: "domcontentloaded" });
            await expect(page.getByRole("heading", { name: E2E_ADMIN.displayName, exact: true })).toBeVisible();
            await expect(page.getByText(title, { exact: true }).first()).toBeVisible();
            const creatorMeasurement = {
                ...(await page
                    .locator("main")
                    .first()
                    .evaluate(
                        (element, payload) => {
                            const rect = element.getBoundingClientRect();
                            return {
                                route: `/u/${payload.username}`,
                                viewport: { width: innerWidth, height: innerHeight, zoom: visualViewport?.scale || 1 },
                                theme: document.documentElement.classList.contains("dark") ? "dark" : "light",
                                state: "动态创作者主页真实公开作品",
                                main: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
                                overflow: document.documentElement.scrollWidth > innerWidth || document.body.scrollWidth > innerWidth,
                                webpPreviewCount: document.querySelectorAll('img[src*="format=webp"]').length,
                            };
                        },
                        { username: E2E_ADMIN.username },
                    )),
                buildId,
            };
            expect(creatorMeasurement.overflow).toBe(false);
            expect(creatorMeasurement.webpPreviewCount).toBeGreaterThan(0);
            const creatorStem = `after-public-creator-${theme}-${testInfo.project.name}`;
            await page.screenshot({ path: path.join(evidenceRoot, `${creatorStem}.png`), fullPage: false });
            await writeFile(path.join(evidenceRoot, `${creatorStem}.json`), `${JSON.stringify({ ...creatorMeasurement, entity: title }, null, 2)}\n`, "utf8");
        }
    } finally {
        if (workId) await deleteIfPresent(request, `/api/works/${encodeURIComponent(workId)}`);
        if (canvasId) await deleteIfPresent(request, "/api/canvas/projects", { ids: [canvasId] });
        if (storageKey) {
            const response = await request.delete("/api/media-assets", { data: { storageKeys: [storageKey] } });
            expect([200, 204, 404]).toContain(response.status());
        }
    }
});

async function setTheme(page: Page, theme: "light" | "dark") {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.evaluate((nextTheme) => localStorage.setItem("dreamyo:theme_store", JSON.stringify({ state: { theme: nextTheme }, version: 0 })), theme);
    await page.reload({ waitUntil: "domcontentloaded" });
    if (theme === "dark") await expect(page.locator("html")).toHaveClass(/dark/);
    else await expect(page.locator("html")).not.toHaveClass(/dark/);
}

async function readCurrentBuildId() {
    return (await readFile(path.resolve(process.cwd(), ".next/BUILD_ID"), "utf8")).trim();
}

async function deleteIfPresent(request: APIRequestContext, url: string, data?: unknown) {
    if (!url) return;
    const response = await request.delete(url, data === undefined ? undefined : { data });
    expect([200, 204, 404, 409]).toContain(response.status());
}
