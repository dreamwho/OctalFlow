import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { expect, test, type APIRequestContext } from "@playwright/test";

const evidenceRoot = path.resolve(process.cwd(), "../docs/ui-rebuild-20260913/evidence");

test("static brand and installation entry states keep C01 readable", async ({ browser }, testInfo) => {
    const viewport = testInfo.project.use.viewport || { width: 1440, height: 900 };
    const context = await browser.newContext({
        baseURL: String(testInfo.project.use.baseURL || "http://127.0.0.1:3100"),
        storageState: { cookies: [], origins: [] },
        viewport,
    });
    const page = await context.newPage();
    await mkdir(evidenceRoot, { recursive: true });
    try {
        for (const theme of ["light", "dark"] as const) {
            await page.addInitScript((nextTheme) => {
                localStorage.setItem("dreamyo:theme_store", JSON.stringify({ state: { theme: nextTheme }, version: 0 }));
            }, theme);
            for (const route of [
                { path: "/login", heading: "登录 dreamyo", state: "登录表单入口" },
                { path: "/register", heading: "注册 dreamyo", state: "注册表单入口" },
                { path: "/forgot-password", heading: "重置密码", state: "找回密码表单入口" },
                { path: "/announcements", heading: "网站公告", state: "公告静态入口" },
                { path: "/privacy", heading: "隐私政策", state: "隐私政策 C01 长文入口" },
                { path: "/terms", heading: "服务条款", state: "服务条款 C01 长文入口" },
                { path: "/install", heading: "把灵感，变成作品", state: "安装入口已初始化并重定向至首页" },
                { path: "/a-route-that-does-not-exist", heading: "页面不存在", state: "404 静态错误入口" },
            ] as const) {
                const response = await page.goto(route.path, { waitUntil: "domcontentloaded" });
                expect(response?.status()).toBeLessThan(500);
                if (route.path === "/install") await expect(page).toHaveURL(/\/$/);
                await expect(page.getByRole("heading", { name: route.heading, exact: true })).toBeVisible();
                await expect(page).toHaveTitle(route.path === "/announcements" ? "网站公告 | dreamyo" : /dreamyo/);
                if (route.path === "/login") {
                    await page.getByRole("textbox", { name: "用户名或邮箱" }).fill("静态入口验收");
                } else if (route.path === "/register") {
                    await page.getByRole("textbox", { name: "用户名" }).fill("静态入口验收");
                } else if (route.path === "/forgot-password") {
                    await page.getByRole("textbox", { name: "绑定邮箱" }).fill("qa@example.test");
                }
                if (route.path === "/privacy" || route.path === "/terms") {
                    await expect(page.locator("main article > header")).toHaveCount(1);
                    await expect.poll(async () => page.locator("main article > header").evaluate((element) => getComputedStyle(element).backgroundImage)).toContain("linear-gradient");
                }
                const measurement = await page.evaluate((nextTheme) => {
                    const main = document.querySelector<HTMLElement>("main");
                    const logo = document.querySelector<HTMLElement>("img[alt='dreamyo']") || document.querySelector<HTMLElement>(".site-logo img") || document.querySelector<HTMLElement>("header img");
                    const favicon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
                    const rect = main?.getBoundingClientRect();
                    return {
                        route: location.pathname,
                        theme: nextTheme,
                        viewport: { width: innerWidth, height: innerHeight, zoom: visualViewport?.scale || 1 },
                        title: document.title,
                        main: rect ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height } : null,
                        logoSource: logo instanceof HTMLImageElement ? logo.currentSrc || logo.src : "",
                        faviconHref: favicon?.href || "",
                        overflow: document.documentElement.scrollWidth > innerWidth || document.body.scrollWidth > innerWidth,
                    };
                }, theme);
                expect(measurement.theme).toBe(theme);
                expect(measurement.overflow).toBe(false);
                expect(measurement.faviconHref).toMatch(/brand\/dreamyo|logo\.svg|icon\.svg|^data:image\/svg\+xml/);
                const stem = `after-static-brand-${route.path.slice(1).replaceAll("/", "-") || "home"}-${theme}-${testInfo.project.name}`;
                await page.screenshot({ path: path.join(evidenceRoot, `${stem}.png`), fullPage: false });
                await writeFile(path.join(evidenceRoot, `${stem}.json`), `${JSON.stringify({ ...measurement, state: route.state, buildId: await currentBuildId() }, null, 2)}\n`, "utf8");
            }
        }
    } finally {
        await context.close();
    }
});

test("brand metadata and generated-button resources are browser-readable and transparent", async ({ page, request }, testInfo) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    const metadata = await page.evaluate(() => [...document.head.querySelectorAll<HTMLLinkElement>('link[rel="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"]')].map((link) => ({ rel: link.rel, href: link.href })));
    expect(metadata).toEqual(
        expect.arrayContaining([
            { rel: "icon", href: expect.stringMatching(/brand\/dreamyo|icon\.svg|api\/site-icon/) },
            { rel: "shortcut icon", href: expect.stringMatching(/brand\/dreamyo|icon\.svg|api\/site-icon/) },
            { rel: "apple-touch-icon", href: expect.stringMatching(/brand\/dreamyo|icon\.svg|api\/site-icon/) },
        ]),
    );

    const manifestResponse = await request.get("/manifest.webmanifest");
    expect(manifestResponse.ok(), await manifestResponse.text()).toBe(true);
    const manifest = (await manifestResponse.json()) as { name?: string; icons?: Array<{ src?: string; type?: string; sizes?: string }> };
    expect(manifest.name).toBeTruthy();
    expect(manifest.icons?.[0]).toMatchObject({ src: "/brand/dreamyo/mark.png", type: "image/png" });

    const resources = ["/icon.svg", "/logo.svg", "/brand/dreamyo/mark.png", "/brand/dreamyo/generation/button-surface.png", "/brand/dreamyo/generation/generate-glyph.png"];
    const resourceChecks = await checkBrandResources(request, resources);
    expect(resourceChecks.every((resource) => resource.status === 200)).toBe(true);
    expect(resourceChecks.filter((resource) => resource.contentType.includes("image/")).length).toBe(resources.length);

    const decoded = await page.evaluate(async (paths) => {
        const decode = (path: string) =>
            new Promise<{ path: string; width: number; height: number; transparentPixels: number }>((resolve, reject) => {
                const image = new Image();
                image.onload = () => {
                    const canvas = document.createElement("canvas");
                    canvas.width = 64;
                    canvas.height = 64;
                    const context = canvas.getContext("2d");
                    if (!context) return reject(new Error("canvas context unavailable"));
                    context.clearRect(0, 0, canvas.width, canvas.height);
                    context.drawImage(image, 0, 0, canvas.width, canvas.height);
                    const alpha = context.getImageData(0, 0, canvas.width, canvas.height).data;
                    let transparentPixels = 0;
                    for (let index = 3; index < alpha.length; index += 4) if (alpha[index] < 8) transparentPixels += 1;
                    resolve({ path, width: image.naturalWidth, height: image.naturalHeight, transparentPixels });
                };
                image.onerror = () => reject(new Error(`unable to decode ${path}`));
                image.src = path;
            });
        return Promise.all(paths.map(decode));
    }, resources);
    expect(decoded.every((resource) => resource.width > 0 && resource.height > 0)).toBe(true);
    expect(decoded.filter((resource) => resource.path.endsWith(".png")).every((resource) => resource.transparentPixels > 0)).toBe(true);

    const evidenceStem = `after-brand-resource-closure-${testInfo.project.name}`;
    const theme = await page.evaluate(() => (document.documentElement.classList.contains("dark") ? "dark" : "light"));
    await page.screenshot({ path: path.join(evidenceRoot, `${evidenceStem}.png`), fullPage: false });
    await writeFile(
        path.join(evidenceRoot, `${evidenceStem}.json`),
        `${JSON.stringify({ route: "/", theme, viewport: await page.evaluate(() => ({ width: innerWidth, height: innerHeight, zoom: visualViewport?.scale || 1 })), state: "浏览器元数据、品牌资源、B01资源解码与透明度", metadata, manifest, resourceChecks, decoded, buildId: await currentBuildId(), capturedAt: new Date().toISOString() }, null, 2)}\n`,
        "utf8",
    );
});

async function checkBrandResources(request: APIRequestContext, paths: string[]) {
    return Promise.all(
        paths.map(async (resourcePath) => {
            const response = await request.get(resourcePath);
            return { path: resourcePath, status: response.status(), contentType: response.headers()["content-type"] || "", bytes: (await response.body()).byteLength };
        }),
    );
}

async function currentBuildId() {
    return (await readFile(path.resolve(process.cwd(), ".next/BUILD_ID"), "utf8")).trim();
}
