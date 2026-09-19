import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";

import { E2E_ADMIN } from "./support";

const evidenceRoot = path.resolve(process.cwd(), "../docs/ui-rebuild-20260913/evidence/user-pages-matrix");
const tinyPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const viewports = [
    { name: "1672x941", width: 1672, height: 941 },
    { name: "1440x900", width: 1440, height: 900 },
    { name: "1366x768", width: 1366, height: 768 },
    { name: "1024x768", width: 1024, height: 768 },
    { name: "768x1024", width: 768, height: 1024 },
    { name: "430x932", width: 430, height: 932 },
    { name: "390x844", width: 390, height: 844 },
] as const;

test("user and public route matrix renders real default states across C01 themes and viewports", async ({ browser, page, request }) => {
    test.setTimeout(900_000);
    const fixtures = await createFixtures(request);
    await mkdir(evidenceRoot, { recursive: true });
    try {
        for (const viewport of viewports) {
            await page.setViewportSize({ width: viewport.width, height: viewport.height });
            for (const theme of ["light", "dark"] as const) {
                await setUserTheme(page, theme);
                for (const route of authenticatedRoutes(fixtures)) {
                    await captureRoute(page, route, viewport, theme);
                }
            }
        }

        const anonymousContext = await browser.newContext({ storageState: { cookies: [], origins: [] }, viewport: { width: 1440, height: 900 } });
        const anonymousPage = await anonymousContext.newPage();
        try {
            for (const viewport of viewports) {
                await anonymousPage.setViewportSize({ width: viewport.width, height: viewport.height });
                for (const theme of ["light", "dark"] as const) {
                    await setAnonymousTheme(anonymousPage, theme);
                    for (const route of anonymousRoutes()) {
                        await captureRoute(anonymousPage, route, viewport, theme);
                    }
                }
            }
        } finally {
            await anonymousContext.close();
        }
    } finally {
        await deleteIfPresent(request, fixtures.workId ? `/api/works/${encodeURIComponent(fixtures.workId)}` : "");
        await deleteIfPresent(request, fixtures.canvasId ? "/api/canvas/projects" : "", fixtures.canvasId ? { ids: [fixtures.canvasId] } : undefined);
        await deleteIfPresent(request, fixtures.dramaId ? `/api/drama/projects/${encodeURIComponent(fixtures.dramaId)}` : "");
        if (fixtures.storageKey) await deleteIfPresent(request, "/api/media-assets", { storageKeys: [fixtures.storageKey] });
    }
});

type RouteCase = { id: string; path: string; expectedPath?: RegExp; state: string };

function authenticatedRoutes(fixtures: { canvasId: string; dramaId: string; slug: string }): RouteCase[] {
    return [
        { id: "R01-assets", path: "/assets", state: "默认已登录" },
        { id: "R02-billing-cancel", path: "/billing/cancel", state: "无订单参数" },
        { id: "R03-billing-checkout", path: "/billing/checkout", state: "无套餐参数" },
        { id: "R04-billing", path: "/billing", expectedPath: /\/profile\?section=billing$/, state: "账单入口重定向" },
        { id: "R05-billing-success", path: "/billing/success", state: "无订单参数" },
        { id: "R06-canvas-detail", path: `/canvas/${encodeURIComponent(fixtures.canvasId)}`, state: "真实画布实体" },
        { id: "R07-canvas", path: "/canvas", state: "画布列表" },
        { id: "R08-community", path: "/community", state: "社区默认" },
        { id: "R09-create", path: "/create", state: "创作工作台默认" },
        { id: "R10-drama-detail", path: `/drama/${encodeURIComponent(fixtures.dramaId)}`, state: "真实短剧实体" },
        { id: "R11-drama", path: "/drama", state: "短剧列表" },
        { id: "R12-help", path: "/help", state: "帮助中心" },
        { id: "R13-image", path: "/image", expectedPath: /\/create$/, state: "图片入口重定向" },
        { id: "R14-me", path: "/me", state: "我的账户" },
        { id: "R15-my-prompts", path: "/my-prompts", state: "我的提示词" },
        { id: "R16-profile", path: "/profile", state: "个人资料" },
        { id: "R17-prompts", path: "/prompts", state: "提示词库" },
        { id: "R18-video", path: "/video", expectedPath: /\/create$/, state: "视频入口重定向" },
        { id: "R19-works", path: "/works", state: "作品管理" },
        { id: "R32-share", path: `/share/${encodeURIComponent(fixtures.slug)}`, state: "真实公开分享" },
        { id: "R34-profile-public", path: `/u/${encodeURIComponent(E2E_ADMIN.username)}`, state: "公开主页真实不可用状态" },
    ];
}

function anonymousRoutes(): RouteCase[] {
    return [
        { id: "R24-announcements", path: "/announcements", state: "公告静态入口" },
        { id: "R25-forgot-password", path: "/forgot-password", state: "找回密码表单" },
        { id: "R26-gallery", path: "/gallery", state: "作品广场匿名入口" },
        { id: "R27-install", path: "/install", state: "安装入口已初始化重定向" },
        { id: "R28-login", path: "/login", state: "登录表单" },
        { id: "R29-home", path: "/", state: "匿名首页" },
        { id: "R30-privacy", path: "/privacy", state: "隐私政策" },
        { id: "R31-register", path: "/register", state: "注册表单" },
        { id: "R33-terms", path: "/terms", state: "服务条款" },
        { id: "R35-not-found", path: "/a-route-that-does-not-exist", state: "404错误页" },
    ];
}

async function captureRoute(page: Page, route: RouteCase, viewport: (typeof viewports)[number], theme: "light" | "dark") {
    const response = await page.goto(route.path, { waitUntil: "domcontentloaded" });
    expect(response?.status() || 200).toBeLessThan(500);
    if (route.expectedPath) await expect(page).toHaveURL(route.expectedPath);
    await page.waitForLoadState("load");
    await expect(page.locator("main").first()).toBeVisible();
    await expect(page.locator("h1, h2").first()).toBeAttached({ timeout: 20_000 });
    const measurement = await page.evaluate(
        (payload) => {
            const main = document.querySelector<HTMLElement>("main");
            const rect = main?.getBoundingClientRect();
            return {
                requestedPath: payload.requestedPath,
                actualPath: location.pathname + location.search,
                responseStatus: payload.status,
                route: location.pathname,
                theme: document.documentElement.classList.contains("dark") ? "dark" : "light",
                title: document.title,
                heading: document.querySelector("h1, h2")?.textContent?.trim() || "",
                viewport: { width: innerWidth, height: innerHeight, visualWidth: visualViewport?.width || 0, visualHeight: visualViewport?.height || 0, zoom: visualViewport?.scale || 1 },
                main: rect ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height } : null,
                overflow: document.documentElement.scrollWidth > innerWidth || document.body.scrollWidth > innerWidth,
            };
        },
        { requestedPath: route.path, status: response?.status() || 200 },
    );
    expect(measurement.theme).toBe(theme);
    expect(measurement.viewport.width).toBe(viewport.width);
    expect(measurement.viewport.visualWidth).toBe(viewport.width);
    expect(measurement.viewport.height).toBe(viewport.height);
    expect(measurement.viewport.visualHeight).toBe(viewport.height);
    expect(measurement.overflow).toBe(false);
    const stem = `${route.id}-${theme}-${viewport.name}`;
    await page.screenshot({ path: path.join(evidenceRoot, `${stem}.png`), fullPage: false });
    await writeFile(path.join(evidenceRoot, `${stem}.json`), `${JSON.stringify({ ...measurement, state: route.state, buildId: await currentBuildId() }, null, 2)}\n`, "utf8");
}

async function setUserTheme(page: Page, theme: "light" | "dark") {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.evaluate((nextTheme) => localStorage.setItem("dreamyo:theme_store", JSON.stringify({ state: { theme: nextTheme }, version: 0 })), theme);
    await page.reload({ waitUntil: "domcontentloaded" });
    if (theme === "dark") await expect(page.locator("html")).toHaveClass(/dark/);
    else await expect(page.locator("html")).not.toHaveClass(/dark/);
}

async function setAnonymousTheme(page: Page, theme: "light" | "dark") {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.evaluate((nextTheme) => localStorage.setItem("dreamyo:theme_store", JSON.stringify({ state: { theme: nextTheme }, version: 0 })), theme);
    await page.reload({ waitUntil: "domcontentloaded" });
    if (theme === "dark") await expect(page.locator("html")).toHaveClass(/dark/);
    else await expect(page.locator("html")).not.toHaveClass(/dark/);
}

async function createFixtures(request: APIRequestContext) {
    const suffix = randomUUID().slice(0, 8);
    const uploaded = await request.post("/api/reference-assets", { data: { dataUrl: `data:image/png;base64,${tinyPng}`, type: "image", persistent: true, originalName: `matrix-${suffix}.png` } });
    expect(uploaded.ok(), await uploaded.text()).toBe(true);
    const media = (await uploaded.json()) as { url: string; key: string };
    const canvasResponse = await request.post("/api/canvas/projects", {
        data: {
            title: `矩阵画布 ${suffix}`,
            project: {
                viewport: { x: 0, y: 0, k: 1 },
                nodes: [
                    {
                        id: `matrix-image-${suffix}`,
                        type: "image",
                        title: "矩阵图片",
                        position: { x: 80, y: 80 },
                        width: 240,
                        height: 180,
                        metadata: { status: "success", content: media.url, serverUrl: media.url, storageKey: media.key, mimeType: "image/png", width: 1, height: 1 },
                    },
                ],
                connections: [],
            },
        },
    });
    expect(canvasResponse.ok(), await canvasResponse.text()).toBe(true);
    const canvasId = ((await canvasResponse.json()) as { data: { project: { id: string } } }).data.project.id;
    const dramaResponse = await request.post("/api/drama/projects", { data: { title: `矩阵短剧 ${suffix}`, summary: "视口矩阵真实实体", ratio: "16:9" } });
    expect(dramaResponse.ok(), await dramaResponse.text()).toBe(true);
    const dramaId = ((await dramaResponse.json()) as { data: { project: { id: string } } }).data.project.id;
    const workResponse = await request.post("/api/works", {
        data: {
            sourceType: "canvas",
            sourceId: canvasId,
            title: `矩阵公开作品 ${suffix}`,
            description: "矩阵公开分享实体",
            publicPrompt: "矩阵验收作品",
            category: "视觉设计",
            tags: ["矩阵"],
            visibility: "public",
            authorDisplay: "profile",
            assetStorageKeys: [media.key],
            coverStorageKey: media.key,
        },
    });
    expect(workResponse.ok(), await workResponse.text()).toBe(true);
    const work = ((await workResponse.json()) as { data: { work: { id: string; slug: string } } }).data.work;
    const submit = await request.post(`/api/works/${encodeURIComponent(work.id)}/submit`);
    expect(submit.ok(), await submit.text()).toBe(true);
    const versionId = ((await submit.json()) as { data: { work: { currentVersion?: { id: string } } } }).data.work.currentVersion?.id;
    expect(versionId).toBeTruthy();
    const review = await request.post(`/api/admin/works/${encodeURIComponent(work.id)}/review`, { data: { versionId, decision: "approved" } });
    expect(review.ok(), await review.text()).toBe(true);
    return { canvasId, dramaId, workId: work.id, slug: work.slug, storageKey: media.key };
}

async function deleteIfPresent(request: APIRequestContext, url: string, data?: unknown) {
    if (!url) return;
    const response = await request.delete(url, data === undefined ? undefined : { data });
    expect([200, 204, 404, 409]).toContain(response.status());
}

async function currentBuildId() {
    return (await readFile(path.resolve(process.cwd(), ".next/BUILD_ID"), "utf8")).trim();
}
