import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";

import { expect, test, type Page } from "@playwright/test";

const evidenceRoot = path.resolve(process.cwd(), "../docs/ui-rebuild-20260913/evidence");

async function ensureCreativeSession(page: Page) {
    await page.goto("/create", { waitUntil: "domcontentloaded" });
    if (/\/login(?:\?|$)/.test(page.url())) {
        await page.getByRole("textbox", { name: "用户名或邮箱" }).fill("e2e_admin");
        await page.getByRole("textbox", { name: /密码/ }).fill("dreamyoE2E!2026");
        await page.getByRole("button", { name: "登录并继续" }).click();
        await page.waitForURL(/\/create(?:\?|$)/);
    }
    await expect(page.getByRole("button", { name: "账户菜单" })).toBeVisible();
}

async function themeButton(page: Page, theme: "light" | "dark") {
    const label = theme === "light" ? "切换到浅色主题" : "切换到深色主题";
    const button = page.getByRole("button", { name: label });
    if (await button.count()) await button.click();
    if (theme === "dark") await expect(page.locator("html")).toHaveClass(/dark/);
    else await expect(page.locator("html")).not.toHaveClass(/dark/);
}

async function saveEvidence(page: Page, name: string) {
    await page.screenshot({ path: path.join(evidenceRoot, name), fullPage: false });
}

async function settleVisualTransition(page: Page) {
    await page.waitForFunction(() => !document.documentElement.dataset.magicuiThemeVt);
}

async function settleTransientAdminMessages(page: Page) {
    const notice = page.locator(".ant-message-notice").filter({ hasText: "商业订单需要启用 PostgreSQL" });
    if (await notice.count()) await expect(notice).toHaveCount(0, { timeout: 5000 });
}

async function saveMeasurement(name: string, payload: unknown) {
    await writeFile(path.join(evidenceRoot, name), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function currentBuildId() {
    try {
        return (await readFile(path.resolve(process.cwd(), ".next/BUILD_ID"), "utf8")).trim();
    } catch {
        return "unknown";
    }
}

test.describe("dreamyo UI rebuild V2.1", () => {
    test("认证、法务与 404 静态入口在双主题保持可读且无溢出", async ({ browser }, testInfo) => {
        const viewport = testInfo.project.use.viewport || undefined;
        const baseURL = String(testInfo.project.use.baseURL || "http://127.0.0.1:3100");
        const context = await browser.newContext({ baseURL, viewport, storageState: { cookies: [], origins: [] } });
        const page = await context.newPage();
        if (testInfo.project.name === "chromium") await page.setViewportSize({ width: 1440, height: 900 });
        const themes = ["light", "dark"] as const;
        const routes = [
            { path: "/login", heading: "登录 dreamyo", title: "登录 | dreamyo", input: "用户名或邮箱" },
            { path: "/register", heading: "注册 dreamyo", title: "注册 | dreamyo", input: "用户名" },
            { path: "/forgot-password", heading: "重置密码", title: "找回密码 | dreamyo", input: "绑定邮箱" },
            { path: "/privacy", heading: "隐私政策", title: "隐私政策 | dreamyo" },
            { path: "/terms", heading: "服务条款", title: "服务条款 | dreamyo" },
            { path: "/a-route-that-does-not-exist", heading: "页面不存在", title: "页面不存在 | dreamyo", expectedStatus: 404 },
        ] as const;
        try {
            for (const theme of themes) {
                await page.addInitScript((nextTheme) => localStorage.setItem("dreamyo:theme_store", JSON.stringify({ state: { theme: nextTheme }, version: 0 })), theme);
                for (const route of routes) {
                    const response = await page.goto(route.path, { waitUntil: "domcontentloaded" });
                    expect(response?.status(), `${route.path} document status`).toBe(route.expectedStatus || 200);
                    await expect(page.locator("main").first()).toBeVisible();
                    await expect(page.getByRole("heading", { name: route.heading, exact: true })).toBeVisible();
                    await expect(page).toHaveTitle(route.title);
                    if (route.input) {
                        const input = page.getByRole("textbox", { name: route.input }).first();
                        await expect(input).toBeVisible();
                        await input.fill("静态页视觉验收");
                        await input.focus();
                    }
                    const measurement = await page.evaluate((nextTheme) => {
                        const main = document.querySelector<HTMLElement>("main");
                        const input = document.querySelector<HTMLInputElement | HTMLTextAreaElement>('input:not([type="hidden"]), textarea');
                        const mainRect = main?.getBoundingClientRect();
                        const inputRect = input?.getBoundingClientRect();
                        const inputStyle = input ? getComputedStyle(input) : null;
                        const inputSurface = input?.closest<HTMLElement>(".ant-input-affix-wrapper") || input;
                        const inputSurfaceStyle = inputSurface ? getComputedStyle(inputSurface) : null;
                        return {
                            route: location.pathname,
                            theme: nextTheme,
                            title: document.title,
                            heading: document.querySelector("h1, h2")?.textContent?.trim() || "",
                            viewport: { width: innerWidth, height: innerHeight, zoom: visualViewport?.scale || 1 },
                            main: mainRect ? { left: mainRect.left, top: mainRect.top, width: mainRect.width, height: mainRect.height } : null,
                            input:
                                inputRect && inputStyle
                                    ? {
                                          left: inputRect.left,
                                          top: inputRect.top,
                                          width: inputRect.width,
                                          height: inputRect.height,
                                          caretColor: inputStyle.caretColor,
                                          color: inputStyle.color,
                                          surfaceBackground: inputSurfaceStyle?.backgroundColor || "",
                                          surfaceColor: inputSurfaceStyle?.color || "",
                                          visible: inputRect.width > 0 && inputRect.height > 0,
                                      }
                                    : null,
                            overflow: document.documentElement.scrollWidth > innerWidth || document.body.scrollWidth > innerWidth,
                            iconHref: document.querySelector<HTMLLinkElement>('link[rel="icon"]')?.href || "",
                        };
                    }, theme);
                    expect(measurement.theme).toBe(theme);
                    expect(measurement.overflow).toBe(false);
                    expect(measurement.iconHref).toMatch(/\/brand\/dreamyo\/|\/icon\.svg/);
                    if (route.input) {
                        expect(measurement.input?.visible).toBe(true);
                        expect(measurement.input?.caretColor).not.toBe("transparent");
                        expect(measurement.input?.color).not.toBe("rgba(0, 0, 0, 0)");
                        if (theme === "dark") {
                            expect(measurement.input?.color).toMatch(/rgb\((?:1[89]\d|2\d\d),/);
                            expect(measurement.input?.surfaceBackground).toMatch(/16, 30, 60|14, 28, 58/);
                        } else {
                            expect(measurement.input?.color).toMatch(/19, 33, 63|15, 23, 42/);
                        }
                    }
                    const slug = route.path.slice(1).replaceAll("/", "-");
                    await saveEvidence(page, `after-static-${slug}-${theme}-${testInfo.project.name}.png`);
                    await saveMeasurement(`after-static-${slug}-${theme}-${testInfo.project.name}.json`, {
                        ...measurement,
                        state: route.input ? "真实输入与光标可见" : "静态内容可读",
                        buildId: await currentBuildId(),
                        capturedAt: new Date().toISOString(),
                    });
                }
            }
        } finally {
            await context.close();
        }
    });

    test("C01 composer and B01 action keep readable geometry in both themes", async ({ page }, testInfo) => {
        await ensureCreativeSession(page);
        await expect(page).toHaveTitle("创作工作台 | dreamyo");

        await expect(page.getByText("正在加载创作 Skill...", { exact: true })).toHaveCount(0, { timeout: 15_000 });

        const input = page.getByRole("textbox", { name: "输入创作要求，使用 / 选择 Skill" });
        const idleAction = page.locator('[data-generation-action][data-appearance="icon"]:visible').first();
        await expect(idleAction).toHaveAttribute("data-state", "disabled");
        await expect(idleAction).toBeDisabled();
        await input.fill("V2.1 浅色主题输入光标与按钮验收");
        await input.focus();
        await expect(idleAction).toHaveAttribute("data-state", "ready");
        await expect(idleAction).toBeEnabled();
        await expect(idleAction).toBeVisible({ timeout: 15_000 });

        const light = await page.evaluate(() => {
            const textarea = document.querySelector("textarea");
            const button = document.querySelector<HTMLElement>('[data-generation-action][data-appearance="icon"]');
            if (!textarea || !button) throw new Error("创作输入或生成按钮缺失");
            const textareaStyle = getComputedStyle(textarea);
            const buttonStyle = getComputedStyle(button);
            const rect = button.getBoundingClientRect();
            const icon = button.querySelector<HTMLElement>(".generation-action-button__icon")?.getBoundingClientRect();
            const glyph = button.querySelector<HTMLImageElement>(".generation-action-button__glyph");
            const glyphRect = glyph?.getBoundingClientRect();
            return {
                activeElement: document.activeElement === textarea,
                caretColor: textareaStyle.caretColor,
                color: textareaStyle.color,
                fill: textareaStyle.webkitTextFillColor,
                backgroundImage: buttonStyle.backgroundImage,
                width: rect.width,
                height: rect.height,
                icon: icon ? { width: icon.width, height: icon.height } : null,
                glyph: glyph && glyphRect ? { src: glyph.currentSrc || glyph.src, naturalWidth: glyph.naturalWidth, naturalHeight: glyph.naturalHeight, width: glyphRect.width, height: glyphRect.height, complete: glyph.complete } : null,
                whiteSpace: buttonStyle.whiteSpace,
            };
        });

        expect(light.activeElement).toBe(true);
        expect(light.caretColor).not.toBe("transparent");
        expect(light.color).not.toBe("rgba(0, 0, 0, 0)");
        expect(light.backgroundImage).toContain("linear-gradient");
        expect(light.width).toBe(44);
        expect(light.height).toBe(44);
        expect(light.icon?.width).toBeGreaterThan(12);
        expect(light.icon?.height).toBeGreaterThan(12);
        expect(light.glyph?.src).toContain("/brand/dreamyo/generation/generate-glyph.png");
        expect(light.glyph?.naturalWidth).toBeGreaterThanOrEqual(100);
        expect(light.glyph?.naturalHeight).toBeGreaterThanOrEqual(100);
        expect(light.glyph?.complete).toBe(true);
        expect(light.glyph?.width).toBeGreaterThanOrEqual(16);
        expect(light.glyph?.width).toBeLessThanOrEqual(24);
        expect(light.whiteSpace).toBe("nowrap");
        const createViewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight, zoom: window.visualViewport?.scale ?? 1 }));
        await saveEvidence(page, `after-v21-create-light-${testInfo.project.name}.png`);

        await themeButton(page, "dark");
        await settleVisualTransition(page);
        const dark = await page.evaluate(() => {
            const textarea = document.querySelector("textarea");
            const visible = <T extends HTMLElement>(selector: string) =>
                [...document.querySelectorAll<T>(selector)].find((element) => {
                    const rect = element.getBoundingClientRect();
                    return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== "hidden";
                });
            const composer = visible<HTMLElement>(".creative-composer");
            const button = visible<HTMLElement>('[data-generation-action][data-appearance="icon"]');
            if (!textarea || !composer || !button) throw new Error("深色创作控件缺失");
            const textareaStyle = getComputedStyle(textarea);
            const composerStyle = getComputedStyle(composer);
            const buttonStyle = getComputedStyle(button);
            const glyph = button.querySelector<HTMLImageElement>(".generation-action-button__glyph");
            return {
                caretColor: textareaStyle.caretColor,
                color: textareaStyle.color,
                composerBackground: composerStyle.backgroundImage,
                buttonBackground: buttonStyle.backgroundImage,
                buttonColor: buttonStyle.color,
                glyphSource: glyph?.currentSrc || glyph?.src || "",
                glyphNaturalWidth: glyph?.naturalWidth || 0,
            };
        });
        expect(dark.caretColor).not.toBe("transparent");
        expect(dark.color).not.toBe("rgba(0, 0, 0, 0)");
        expect(dark.composerBackground === "none" || dark.composerBackground.includes("linear-gradient")).toBe(true);
        expect(dark.buttonBackground).toContain("linear-gradient");
        expect(dark.buttonColor).toBe("rgb(255, 255, 255)");
        expect(dark.glyphSource).toContain("/brand/dreamyo/generation/generate-glyph.png");
        expect(dark.glyphNaturalWidth).toBeGreaterThanOrEqual(100);
        await saveEvidence(page, `after-v21-create-dark-${testInfo.project.name}.png`);

        const composerLayout = await page.evaluate(() => {
            const send = document.querySelector<HTMLElement>('[data-generation-action][data-appearance="icon"]');
            const row = send?.parentElement?.parentElement;
            if (!send || !row) throw new Error("发送按钮布局缺失");
            const sendRect = send.getBoundingClientRect();
            const rowRect = row.getBoundingClientRect();
            const tools = [...row.querySelectorAll<HTMLElement>(".dreamyo-composer-tool-button")].map((button) => {
                const rect = button.getBoundingClientRect();
                return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, text: button.innerText.trim() };
            });
            return {
                viewport: { width: window.innerWidth, height: window.innerHeight, zoom: window.visualViewport?.scale ?? 1 },
                row: { left: rowRect.left, right: rowRect.right, width: rowRect.width },
                send: { left: sendRect.left, right: sendRect.right, top: sendRect.top, bottom: sendRect.bottom, width: sendRect.width, height: sendRect.height },
                tools,
                visibleLabelCount: tools.filter((tool) => tool.text.length > 0).length,
                sendOverlapCount: tools.filter((tool) => tool.right > sendRect.left && tool.left < sendRect.right && tool.bottom > sendRect.top && tool.top < sendRect.bottom).length,
            };
        });
        if (createViewport.width <= 430) {
            expect(composerLayout.visibleLabelCount).toBe(0);
            expect(composerLayout.sendOverlapCount).toBe(0);
        }
        await saveMeasurement(`after-v21-create-measurements-${testInfo.project.name}.json`, {
            route: "/create",
            themes: { light: { ...light, viewport: createViewport }, dark: { ...dark, viewport: composerLayout.viewport } },
            state: "filled textarea, generation action idle",
            composerLayout,
        });
    });

    test("C01 create model, preference, and Skill popovers keep their own theme surface", async ({ page }, testInfo) => {
        await ensureCreativeSession(page);
        await expect(page.getByText("正在加载创作 Skill...", { exact: true })).toHaveCount(0, { timeout: 15_000 });
        const themes = ["light", "dark"] as const;
        const measurements: Record<string, unknown> = {};
        for (const theme of themes) {
            await page.evaluate((nextTheme) => localStorage.setItem("dreamyo:theme_store", JSON.stringify({ state: { theme: nextTheme }, version: 0 })), theme);
            await page.reload({ waitUntil: "domcontentloaded" });
            await expect(page.getByRole("textbox", { name: "输入创作要求，使用 / 选择 Skill" })).toBeVisible();
            if (theme === "dark") await expect(page.locator("html")).toHaveClass(/dark/);
            else await expect(page.locator("html")).not.toHaveClass(/dark/);

            const popovers = [
                { name: "model", trigger: page.getByRole("button", { name: /生成模型：/ }).first(), selector: "[data-creative-model-popover]" },
                { name: "preferences", trigger: page.getByRole("button", { name: /生成参数/ }).first(), selector: "[data-creative-generation-preferences]" },
                { name: "skill", trigger: page.getByRole("button", { name: /创作 Skill/ }).first(), selector: "[data-creative-skill-popover]" },
            ] as const;
            const themeMeasurements: Record<string, unknown> = {};
            for (const popover of popovers) {
                await popover.trigger.click();
                const panel = page.locator(`${popover.selector}:visible`).last();
                await expect(panel).toBeVisible();
                await expect.poll(() => panel.evaluate((element) => element.getBoundingClientRect().width), { timeout: 5000 }).toBeGreaterThan(0);
                await expect.poll(() => panel.evaluate((element) => element.getBoundingClientRect().height), { timeout: 5000 }).toBeGreaterThan(0);
                await expect.poll(() => panel.evaluate((element) => Number.parseFloat(getComputedStyle(element.closest<HTMLElement>(".ant-popover") || element).opacity)), { timeout: 5000 }).toBeGreaterThan(0.5);
                const measurement = await panel.evaluate((element) => {
                    const rect = element.getBoundingClientRect();
                    const style = getComputedStyle(element);
                    const heading = element.querySelector<HTMLElement>("p");
                    const colorLightness = style.backgroundColor.match(/(?:oklab|lab)\(([-.\d]+)/)?.[1];
                    const parsedLightness = colorLightness ? Number(colorLightness) : null;
                    const popup = element.closest<HTMLElement>(".ant-popover");
                    const popupStyle = popup ? getComputedStyle(popup) : null;
                    const popupRect = popup?.getBoundingClientRect();
                    return {
                        rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
                        backgroundColor: style.backgroundColor,
                        backgroundLightness: parsedLightness === null ? null : parsedLightness > 1 ? parsedLightness / 100 : parsedLightness,
                        backgroundImage: style.backgroundImage,
                        color: style.color,
                        borderColor: style.borderTopColor,
                        headingColor: heading ? getComputedStyle(heading).color : "",
                        overflowX: style.overflowX,
                        horizontalOverflow: element.scrollWidth > element.clientWidth + 1,
                        popup:
                            popup && popupStyle && popupRect
                                ? {
                                      opacity: popupStyle.opacity,
                                      visibility: popupStyle.visibility,
                                      display: popupStyle.display,
                                      zIndex: popupStyle.zIndex,
                                      rect: { left: popupRect.left, top: popupRect.top, width: popupRect.width, height: popupRect.height },
                                  }
                                : null,
                    };
                });
                expect((measurement as { rect: { width: number; height: number } }).rect.width).toBeGreaterThan(0);
                expect((measurement as { rect: { width: number; height: number } }).rect.height).toBeGreaterThan(0);
                expect((measurement as { horizontalOverflow: boolean }).horizontalOverflow).toBe(false);
                const backgroundColor = (measurement as { backgroundColor: string }).backgroundColor;
                const backgroundLightness = (measurement as { backgroundLightness: number | null }).backgroundLightness;
                if (theme === "light") {
                    if (backgroundLightness !== null) expect(backgroundLightness).toBeGreaterThan(0.9);
                    else expect(backgroundColor).not.toMatch(/2,\s*8,\s*19/);
                    expect(backgroundColor).not.toMatch(/2,\s*8,\s*19/);
                } else {
                    if (backgroundLightness !== null) expect(backgroundLightness).toBeLessThan(0.2);
                    else expect(backgroundColor).toMatch(/2,\s*8,\s*19/);
                }
                themeMeasurements[popover.name] = measurement;
                await page.keyboard.press("Escape");
                await expect(panel).toBeHidden();
            }
            await page
                .getByRole("button", { name: /创作 Skill/ })
                .first()
                .click();
            await expect(page.locator("[data-creative-skill-popover]:visible").last()).toBeVisible();
            await expect
                .poll(
                    () =>
                        page
                            .locator("[data-creative-skill-popover]:visible")
                            .last()
                            .evaluate((element) => element.getBoundingClientRect().width),
                    { timeout: 5000 },
                )
                .toBeGreaterThan(0);
            await expect
                .poll(
                    () =>
                        page
                            .locator("[data-creative-skill-popover]:visible")
                            .last()
                            .evaluate((element) => Number.parseFloat(getComputedStyle(element.closest<HTMLElement>(".ant-popover") || element).opacity)),
                    { timeout: 5000 },
                )
                .toBeGreaterThan(0.5);
            await saveEvidence(page, `after-create-popovers-${theme}-${testInfo.project.name}.png`);
            await page.keyboard.press("Escape");
            measurements[theme] = themeMeasurements;
        }
        await saveMeasurement(`after-create-popovers-${testInfo.project.name}.json`, {
            route: "/create",
            state: "model, generation preference, and Skill popovers opened in both themes",
            viewport: await page.evaluate(() => ({ width: innerWidth, height: innerHeight, zoom: visualViewport?.scale ?? 1 })),
            themes: measurements,
            buildId: await currentBuildId(),
            capturedAt: new Date().toISOString(),
        });
    });

    test("Canvas toolbar uses semantic line icons and selection frame stays outside media", async ({ page }, testInfo) => {
        await ensureCreativeSession(page);
        await page.goto("/canvas", { waitUntil: "domcontentloaded" });
        await expect(page).toHaveTitle("Canvas 项目 | dreamyo");
        const create = page.getByRole("button", { name: "新建画布" }).last();
        const createResponse = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/canvas/projects");
        await create.click();
        const response = await createResponse;
        expect(response.ok(), await response.text()).toBe(true);
        await expect.poll(() => new URL(page.url()).pathname, { timeout: 10_000 }).toMatch(/^\/canvas\/[^/]+$/);
        await expect(page.getByRole("button", { name: "图片", exact: true })).toBeVisible();
        await expect(page.getByRole("button", { name: "视频", exact: true })).toBeVisible();
        await expect(page.getByRole("button", { name: "音频", exact: true })).toBeVisible();
        const toolbarIcons = await page.evaluate(() =>
            ["图片", "视频", "音频"].map((label) => {
                const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.getAttribute("aria-label") === label);
                return { label, svg: Boolean(button?.querySelector("svg")), img: Boolean(button?.querySelector("img")) };
            }),
        );
        expect(toolbarIcons).toEqual([
            { label: "图片", svg: true, img: false },
            { label: "视频", svg: true, img: false },
            { label: "音频", svg: true, img: false },
        ]);

        await page.getByRole("button", { name: "图片", exact: true }).click();
        await expect(page.getByRole("textbox", { name: "节点提示词" })).toBeVisible();
        await page.locator("[data-node-id]").first().click();
        await expect(page.locator("[data-canvas-node-selection-flow]")).toBeVisible();
        const geometry = await page.evaluate(() => {
            const flow = document.querySelector<HTMLElement>("[data-canvas-node-selection-flow]");
            const media = document.querySelector<HTMLElement>("[data-node-id] > div");
            if (!flow || !media) throw new Error("Canvas节点选中框或媒体壳缺失");
            const a = flow.getBoundingClientRect();
            const b = media.getBoundingClientRect();
            return {
                left: a.left - b.left,
                top: a.top - b.top,
                right: b.right - a.right,
                bottom: b.bottom - a.bottom,
                border: getComputedStyle(flow).borderTopWidth,
                flow: { left: a.left, top: a.top, right: a.right, bottom: a.bottom, width: a.width, height: a.height },
                media: { left: b.left, top: b.top, right: b.right, bottom: b.bottom, width: b.width, height: b.height },
            };
        });
        expect(geometry.flow.width).toBeGreaterThan(0);
        expect(geometry.flow.height).toBeGreaterThan(0);
        expect(geometry.media.width).toBeGreaterThan(0);
        expect(geometry.media.height).toBeGreaterThan(0);
        expect(Math.abs(geometry.left)).toBeLessThanOrEqual(2);
        expect(Math.abs(geometry.top)).toBeLessThanOrEqual(2);
        expect(Math.abs(geometry.right)).toBeLessThanOrEqual(2);
        expect(Math.abs(geometry.bottom)).toBeLessThanOrEqual(2);
        expect(geometry.border).toBe("2px");
        await saveEvidence(page, `after-v21-canvas-light-${testInfo.project.name}.png`);
        const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight, zoom: window.visualViewport?.scale ?? 1 }));
        await saveMeasurement(`after-v21-canvas-measurements-${testInfo.project.name}.json`, {
            route: page.url(),
            theme: "light",
            viewport,
            state: "image node selected, prompt panel open",
            geometry,
        });
    });

    test("public title smoke test keeps brand and page titles distinct", async ({ browser }) => {
        const context = await browser.newContext();
        await context.clearCookies();
        const page = await context.newPage();
        const routes = [
            ["/", "dreamyo"],
            ["/login", "登录 | dreamyo"],
            ["/register", "注册 | dreamyo"],
            ["/forgot-password", "找回密码 | dreamyo"],
            ["/terms", "服务条款 | dreamyo"],
            ["/privacy", "隐私政策 | dreamyo"],
        ] as const;
        for (const [route, title] of routes) {
            await page.goto(route, { waitUntil: "domcontentloaded" });
            await expect(page).toHaveTitle(title);
        }
        await context.close();
    });

    test("home C01 hero keeps a light surface and B01 action in both themes", async ({ page }, testInfo) => {
        await page.goto("/", { waitUntil: "domcontentloaded" });
        await expect(page).toHaveTitle("dreamyo");
        const card = page.getByTestId("home-agent-card");
        const input = page.getByRole("textbox", { name: "描述你想创作的内容" });
        const send = card.getByRole("button", { name: "开始创作" });
        await expect(card).toBeVisible();
        await expect(send).toBeVisible();
        await input.fill("首页 C01 浅色面板与 B01 按钮验收");
        await input.focus();
        const light = await card.evaluate((element) => {
            const composer = element as HTMLElement;
            const button = composer.querySelector<HTMLElement>('button[aria-label="开始创作"]');
            if (!button) throw new Error("首页生成按钮缺失");
            const composerStyle = getComputedStyle(composer);
            const buttonStyle = getComputedStyle(button);
            const rect = button.getBoundingClientRect();
            return { background: composerStyle.backgroundColor, color: composerStyle.color, buttonBackground: buttonStyle.backgroundImage, width: rect.width, height: rect.height, whiteSpace: buttonStyle.whiteSpace };
        });
        expect(light.background).not.toBe("rgba(0, 0, 0, 0)");
        expect(light.buttonBackground).toContain("linear-gradient");
        expect(light.width).toBeGreaterThanOrEqual(44);
        expect(light.height).toBeGreaterThanOrEqual(44);
        expect(light.whiteSpace).toBe("nowrap");
        await saveEvidence(page, `after-v21-home-light-${testInfo.project.name}.png`);

        await themeButton(page, "dark");
        await settleVisualTransition(page);
        const dark = await card.evaluate((element) => {
            const composer = element as HTMLElement;
            const button = composer.querySelector<HTMLElement>('button[aria-label="开始创作"]');
            if (!button) throw new Error("深色首页生成按钮缺失");
            const composerStyle = getComputedStyle(composer);
            const buttonStyle = getComputedStyle(button);
            const rect = button.getBoundingClientRect();
            return { background: composerStyle.backgroundColor, color: composerStyle.color, buttonBackground: buttonStyle.backgroundImage, width: rect.width, height: rect.height, whiteSpace: buttonStyle.whiteSpace };
        });
        expect(dark.background).not.toBe("rgba(0, 0, 0, 0)");
        expect(dark.buttonBackground).toContain("linear-gradient");
        expect(dark.width).toBeGreaterThanOrEqual(44);
        expect(dark.height).toBeGreaterThanOrEqual(44);
        await saveEvidence(page, `after-v21-home-dark-${testInfo.project.name}.png`);
        await saveMeasurement(`after-v21-home-measurements-${testInfo.project.name}.json`, {
            route: "/",
            state: "filled homepage textarea, generation action idle",
            themes: { light, dark },
            viewport: await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight, zoom: window.visualViewport?.scale ?? 1 })),
        });
    });

    test("C01 background has a reduced-motion and resource-failure fallback", async ({ page }, testInfo) => {
        await page.emulateMedia({ reducedMotion: "reduce" });
        await page.goto("/", { waitUntil: "domcontentloaded" });
        await expect(page.getByRole("heading", { name: "把灵感，变成作品" })).toBeVisible();
        await page.evaluate(() => document.fonts.ready);
        const reduced = await page.evaluate(() => {
            const stage = document.querySelector<HTMLElement>('[data-testid="home-agent-halo"]');
            const visual = stage?.querySelector<HTMLElement>("img");
            const layers = [...(stage?.querySelectorAll<HTMLElement>("[data-halo-ring]") || [])];
            return {
                viewport: { width: innerWidth, height: innerHeight, visualWidth: visualViewport?.width || null, visualHeight: visualViewport?.height || null },
                visualDisplay: visual ? getComputedStyle(visual).display : "missing",
                visualAnimation: visual ? getComputedStyle(visual).animationName : "missing",
                layerAnimations: layers.map((layer) => getComputedStyle(layer).animationName),
                imageSources: [...(stage?.querySelectorAll<HTMLImageElement>("img") || [])].map((image) => ({ src: image.currentSrc, naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight })),
            };
        });
        expect(reduced.visualAnimation).toBe("none");
        expect(reduced.layerAnimations.every((name) => name === "none")).toBe(true);
        await saveEvidence(page, `after-v21-home-reduced-motion-${testInfo.project.name}.png`);

        await page.route("**/brand/dreamyo/flow-light.png", (route) => route.fulfill({ status: 404, contentType: "text/plain", body: "fixture missing" }));
        await page.reload({ waitUntil: "domcontentloaded" });
        await expect(page.getByRole("heading", { name: "把灵感，变成作品" })).toBeVisible();
        await expect
            .poll(
                () =>
                    page.evaluate(() => {
                        const images = [...document.querySelectorAll<HTMLImageElement>('[data-testid="home-agent-halo"] img')];
                        return images.filter((image) => image.src.endsWith("flow-light.png")).every((image) => getComputedStyle(image).display === "none");
                    }),
                { timeout: 10_000 },
            )
            .toBe(true);
        const fallback = await page.evaluate(() => {
            const images = [...document.querySelectorAll<HTMLImageElement>('[data-testid="home-agent-halo"] img')];
            return {
                brokenLightHidden: images.filter((image) => image.src.endsWith("flow-light.png")).every((image) => getComputedStyle(image).display === "none"),
                stageBackground: getComputedStyle(document.querySelector<HTMLElement>('[data-testid="home-agent-halo"]')!).backgroundImage,
            };
        });
        expect(fallback.brokenLightHidden).toBe(true);
        await saveEvidence(page, `after-v21-home-resource-fallback-${testInfo.project.name}.png`);

        const setDocumentHidden = async (hidden: boolean) =>
            page.evaluate((nextHidden) => {
                Object.defineProperty(document, "hidden", { configurable: true, get: () => nextHidden });
                document.dispatchEvent(new Event("visibilitychange"));
            }, hidden);
        await page.emulateMedia({ reducedMotion: "no-preference" });
        await page.reload({ waitUntil: "domcontentloaded" });
        await expect(page.getByRole("heading", { name: "把灵感，变成作品" })).toBeVisible();
        await setDocumentHidden(true);
        await expect(page.locator('[data-testid="home-agent-halo"]').locator("xpath=..")).toHaveAttribute("data-page-hidden", "true");
        const homeHidden = await page.evaluate(() => {
            const hero = document.querySelector<HTMLElement>("[data-page-hidden='true']");
            const stage = hero?.querySelector<HTMLElement>('[data-testid="home-agent-halo"]');
            const visual = stage?.querySelector<HTMLElement>("img");
            const rings = [...(stage?.querySelectorAll<HTMLElement>("[data-halo-ring]") || [])];
            const animatedRings = rings.filter((ring) => getComputedStyle(ring).animationName !== "none");
            return {
                pageHidden: hero?.dataset.pageHidden || "",
                visualAnimationPlayState: visual ? getComputedStyle(visual).animationPlayState : "missing",
                ringAnimationPlayStates: animatedRings.map((ring) => getComputedStyle(ring).animationPlayState),
            };
        });
        expect(homeHidden.pageHidden).toBe("true");
        expect(homeHidden.visualAnimationPlayState).toBe("paused");
        expect(homeHidden.ringAnimationPlayStates.every((state) => state === "paused")).toBe(true);
        await setDocumentHidden(false);
        await expect(page.locator('[data-testid="home-agent-halo"]').locator("xpath=..")).not.toHaveAttribute("data-page-hidden", "true");

        await page.unroute("**/brand/dreamyo/flow-light.png");
        const tracePath = path.join(evidenceRoot, `after-v21-motion-performance-${testInfo.project.name}.zip`);
        await page.context().tracing.startChunk({ title: `motion-performance-${testInfo.project.name}` });
        await page.goto("/create", { waitUntil: "domcontentloaded" });
        await page.evaluate(() => document.fonts.ready);
        await setDocumentHidden(true);
        await expect(page.locator("main[data-page-hidden='true']")).toBeVisible();
        const createHidden = await page.evaluate(() => {
            const main = document.querySelector<HTMLElement>("main[data-page-hidden='true']");
            const visual = main?.querySelector<HTMLElement>("[data-landing-backdrop-visual]");
            const veil = main?.querySelector<HTMLElement>("[data-landing-backdrop-veil]");
            return {
                pageHidden: main?.dataset.pageHidden || "",
                visualAnimationPlayState: visual ? getComputedStyle(visual).animationPlayState : "missing",
                veilAnimationPlayState: veil ? getComputedStyle(veil).animationPlayState : "missing",
            };
        });
        expect(createHidden.pageHidden).toBe("true");
        expect(createHidden.visualAnimationPlayState).toBe("paused");
        expect(createHidden.veilAnimationPlayState).toBe("paused");
        await setDocumentHidden(false);
        await expect(page.locator("main[data-page-hidden='true']")).toHaveCount(0);
        await page.context().tracing.stopChunk({ path: tracePath });
        const performance = await page.evaluate(() => {
            const resources = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
            return resources.filter((entry) => /flow-(?:light|dark)\.png$/.test(entry.name)).map((entry) => ({ name: entry.name, duration: Math.round(entry.duration), transferSize: entry.transferSize }));
        });
        await saveMeasurement(`after-v21-motion-${testInfo.project.name}.json`, {
            route: "/",
            theme: "light",
            state: "reduced-motion and flow-light 404 fallback, then /create performance trace",
            viewport: reduced.viewport,
            reduced,
            fallback,
            visibility: { homeHidden, createHidden },
            performance,
            trace: tracePath,
            buildId: await currentBuildId(),
            capturedAt: new Date().toISOString(),
        });
    });

    test("admin C01 reference board keeps overview and operations visually coherent", async ({ page }, testInfo) => {
        const themes = testInfo.project.name === "chromium" ? (["light", "dark"] as const) : ([testInfo.project.name === "mobile-430" ? "dark" : "light"] as const);
        await page.goto("/admin", { waitUntil: "domcontentloaded" });
        await expect(page).toHaveTitle("管理后台 | dreamyo");

        for (const theme of themes) {
            await page.goto("/admin", { waitUntil: "domcontentloaded" });
            await page.evaluate((nextTheme) => localStorage.setItem("dreamyo:admin_theme_store", JSON.stringify({ state: { theme: nextTheme }, version: 0 })), theme);
            await page.reload({ waitUntil: "domcontentloaded" });
            await expect(page.locator("[data-hydrated='true']").first()).toBeVisible();
            await expect(page.locator("[data-admin-model-status], .admin-overview-snapshot-empty").first()).toBeVisible();
            if (theme === "dark") await expect(page.locator("html")).toHaveClass(/dark/);
            else await expect(page.locator("html")).not.toHaveClass(/dark/);

            const navigation = page.locator("[data-admin-navigation]").first();
            if (testInfo.project.name.startsWith("mobile-")) {
                await expect(page.getByRole("button", { name: "展开后台侧边栏" })).toBeVisible();
                await page.getByRole("button", { name: "展开后台侧边栏" }).click();
                const openNavigation = page.locator("[data-admin-navigation].is-open");
                await expect(openNavigation).toBeVisible();
                await expect(openNavigation.locator(".admin-section-brand-logo:visible").first()).toBeVisible();
                await expect(openNavigation.locator(".admin-section-nav-promo")).toBeVisible();
                await openNavigation.getByRole("button", { name: "收起后台侧边栏" }).click();
            } else {
                await expect(navigation).toBeVisible();
                await expect(navigation.locator(".admin-section-brand-logo:visible").first()).toBeVisible();
                await expect(navigation.locator(".admin-section-nav-promo")).toBeVisible();
            }
            await settleTransientAdminMessages(page);
            const overview = await page.evaluate(() => {
                const intro = document.querySelector<HTMLElement>(".admin-dashboard-intro");
                const cards = [...document.querySelectorAll<HTMLElement>(".admin-metric-card")].filter((card) => {
                    const box = card.getBoundingClientRect();
                    return box.width > 0 && box.height > 0 && getComputedStyle(card).visibility !== "hidden";
                });
                const rect = (element: HTMLElement | null) =>
                    element
                        ? (() => {
                              const box = element.getBoundingClientRect();
                              return { left: box.left, right: box.right, top: box.top, width: box.width, height: box.height };
                          })()
                        : null;
                return {
                    intro: rect(intro),
                    introBackground: intro ? getComputedStyle(intro).backgroundImage : "none",
                    metricCards: cards.map((card) => rect(card)),
                    modelStatusCount: document.querySelectorAll("[data-admin-model-status]").length,
                    queueCount: document.querySelectorAll("[data-admin-queue-row]").length,
                    emptySnapshotCount: document.querySelectorAll(".admin-overview-snapshot-empty").length,
                    overflow: document.documentElement.scrollWidth > innerWidth || document.body.scrollWidth > innerWidth,
                };
            });
            expect(overview.introBackground).toContain("linear-gradient");
            expect(overview.metricCards).toHaveLength(4);
            expect(overview.metricCards.every((card) => (card?.width || 0) > 0 && (card?.height || 0) > 0)).toBe(true);
            expect(overview.modelStatusCount + overview.queueCount + overview.emptySnapshotCount).toBeGreaterThan(0);
            expect(overview.overflow).toBe(false);
            await saveEvidence(page, `after-admin-regression-overview-${theme}-${testInfo.project.name}.png`);
            await saveMeasurement(`after-admin-regression-overview-${theme}-${testInfo.project.name}.json`, {
                route: "/admin",
                theme,
                viewport: await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight, zoom: window.visualViewport?.scale ?? 1 })),
                state: "admin overview with C01 shell, KPI cards and real model/queue snapshot",
                buildId: await currentBuildId(),
                evidenceVersion: "admin-c01-v3",
                capturedAt: new Date().toISOString(),
                overview,
            });
            await page.goto("/admin?section=generationOperations", { waitUntil: "domcontentloaded" });
            await expect(page).toHaveTitle("管理后台 | dreamyo");
            await expect(page.locator("[data-admin-generation-operations='true']:visible")).toHaveCount(1);
            await expect(page.locator("[data-admin-channel-card]").first()).toBeVisible();
            const operationVisual = await page.evaluate(() => {
                const visible = (selector: string) =>
                    [...document.querySelectorAll<HTMLElement>(selector)].filter((element) => {
                        const box = element.getBoundingClientRect();
                        return box.width > 0 && box.height > 0 && getComputedStyle(element).visibility !== "hidden";
                    });
                const summary = visible(".admin-generation-summary-metric");
                const channelCards = visible("[data-admin-channel-card]");
                return {
                    summaryCount: summary.length,
                    summaryBackgrounds: summary.slice(0, 2).map((element) => getComputedStyle(element).backgroundImage),
                    channelCards: channelCards.length,
                    channelCardWidths: channelCards.map((element) => element.getBoundingClientRect().width),
                    overflow: document.documentElement.scrollWidth > innerWidth || document.body.scrollWidth > innerWidth,
                };
            });
            expect(operationVisual.summaryCount).toBe(6);
            expect(operationVisual.summaryBackgrounds.every((background) => background.includes("linear-gradient"))).toBe(true);
            expect(operationVisual.channelCards).toBeGreaterThan(0);
            expect(operationVisual.channelCardWidths.every((width) => width > 0)).toBe(true);
            expect(operationVisual.overflow).toBe(false);
            await page.getByRole("heading", { name: "渠道运行状态", exact: true }).first().scrollIntoViewIfNeeded();
            await expect(page.locator("[data-admin-channel-card]").first()).toBeVisible();
            await saveEvidence(page, `after-admin-regression-${theme}-${testInfo.project.name}.png`);
            await saveMeasurement(`after-admin-regression-${theme}-${testInfo.project.name}.json`, {
                route: "/admin?section=generationOperations",
                theme,
                viewport: await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight, zoom: window.visualViewport?.scale ?? 1 })),
                state: "overview and generation operations visual regression, scrolled to channel runtime status",
                buildId: await currentBuildId(),
                evidenceVersion: "admin-c01-v3",
                capturedAt: new Date().toISOString(),
                overview,
                operationVisual,
            });
        }
    });
});
