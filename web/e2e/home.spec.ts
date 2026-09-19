import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";

const galleryResponse = {
    code: 0,
    msg: "OK",
    data: {
        items: [
            galleryItem(1, "image", "media", "视觉设计"),
            galleryItem(2, "video", "media", "视频"),
            galleryItem(3, "image", "drama", "短剧"),
            galleryItem(4, "image", "media", "品牌内容"),
            galleryItem(5, "image", "canvas", "视觉设计"),
            galleryItem(6, "video", "drama", "短剧"),
        ],
    },
};

test("public homepage is functional for signed-out visitors", async ({ browser }, testInfo) => {
    const context = await browser.newContext({ baseURL: String(testInfo.project.use.baseURL || "http://127.0.0.1:3100") });
    await context.clearCookies();
    const page = await context.newPage();
    const browserErrors = collectBrowserErrors(page);
    let galleryRequest = "";
    await page.route("**/api/public/gallery?**", async (route) => {
        galleryRequest = route.request().url();
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(galleryResponse) });
    });
    await page.route("**/api/billing/products", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ products: [], paymentProviders: [] }) }));

    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 1, name: "把灵感，变成作品" })).toBeVisible();
    await expect(page.locator("h1")).toHaveCount(1);
    await expect(page.getByText("核心能力", { exact: true })).toHaveCount(0);
    await expect(page.getByTestId("home-agent-card")).toHaveCount(1);
    await expect(page.getByTestId("home-agent-halo").locator("[data-halo-ring]")).toHaveCount(4);
    await expect(page.getByTestId("home-public-gallery")).toBeVisible();
    const galleryLayout = await page
        .getByTestId("home-public-gallery")
        .locator("article")
        .evaluateAll((cards) => {
            const visible = cards.map((card) => ({ bounds: card.getBoundingClientRect(), display: getComputedStyle(card).display })).filter((card) => card.display !== "none" && card.bounds.width > 0 && card.bounds.height > 0);
            return { visibleCount: visible.length, rowCount: new Set(visible.map((card) => Math.round(card.bounds.top))).size };
        });
    expect(galleryLayout.rowCount).toBe(2);
    expect(galleryLayout.visibleCount).toBe(testInfo.project.name.startsWith("mobile-") ? 4 : 6);
    const firstGalleryCard = page.getByTestId("home-gallery-card").first();
    await expect(firstGalleryCard.locator("[data-gallery-type], [data-gallery-like]")).toHaveCount(0);
    await expect(firstGalleryCard.locator(".author")).toHaveCount(0);
    const firstGalleryMedia = firstGalleryCard.getByRole("button", { name: /查看作品/ });
    await expect(firstGalleryMedia).toBeVisible();
    if (testInfo.project.name === "chromium") {
        const workBody = firstGalleryCard.locator("[data-gallery-work-body]");
        await expect(workBody).toHaveCSS("opacity", "0");
        await expect(workBody).toHaveCSS("background-image", "none");
        await firstGalleryCard.hover();
        await expect.poll(() => workBody.evaluate((element) => getComputedStyle(element).opacity)).toBe("1");
    }
    await firstGalleryMedia.click();
    const galleryPreview = page.getByRole("dialog");
    await expect(galleryPreview.getByRole("img", { name: "首页公开作品 1" })).toBeVisible();
    await galleryPreview.getByRole("button", { name: "Close" }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByText("登录后使用 AI 创作", { exact: true })).toHaveCount(0);
    const menuButton = page.getByRole("button", { name: "打开导航菜单" });
    await expect(menuButton).toBeVisible();
    await expect(page.getByRole("navigation", { name: "首页导航菜单" })).toHaveCount(0);
    await menuButton.click();
    const headerNavigation = page.getByRole("navigation", { name: "首页导航菜单" });
    await expect(headerNavigation).toBeVisible();
    await expect(headerNavigation.getByRole("link", { name: "首页", exact: true })).toHaveCount(1);
    await expect(headerNavigation.getByRole("button", { name: "创作" })).toHaveCount(1);
    await expect(headerNavigation.getByRole("button", { name: "无限画布" })).toHaveCount(1);
    await expect(headerNavigation.getByRole("link", { name: "作品广场" })).toHaveCount(1);
    await expect(headerNavigation.getByRole("button", { name: "定价" })).toHaveCount(1);
    if (testInfo.project.name === "chromium") {
        await page.getByRole("button", { name: "关闭导航菜单" }).click();
        await page
            .locator("header")
            .getByRole("button", { name: "登录", exact: true })
            .click();
        await expect(page.getByRole("dialog")).toBeVisible();
        await page.getByRole("button", { name: "Close" }).click();

        await menuButton.click();
        await headerNavigation.getByRole("button", { name: "定价" }).click();
        const plansDialog = page.getByRole("dialog");
        await expect(plansDialog.getByText("升级创作套餐", { exact: true })).toBeVisible();
        await expect(plansDialog.getByText("暂无已上架套餐", { exact: true })).toBeVisible();
        await plansDialog.getByRole("button", { name: "关闭套餐选择" }).click();
        await expect(plansDialog).toBeHidden();
    } else {
        await page.getByRole("button", { name: "关闭导航菜单" }).click();
        await expect(headerNavigation).toHaveCount(0);
    }
    expect(new URL(galleryRequest).pathname).toBe("/api/public/gallery");
    expect(new URL(galleryRequest).searchParams.get("limit")).toBe("18");
    expect(new URL(galleryRequest).searchParams.get("sort")).toBe("random");

    const prompt = page.locator('textarea[aria-label="描述你想创作的内容"]:visible').first();
    await expect(prompt).toHaveAttribute("placeholder", /^描述你想创作的内容，比如：生成一张科幻城市概念图/);
    const modeTrigger = page.getByRole("button", { name: "当前创作模式：智能模式" });
    await expect(modeTrigger).toBeVisible();
    await modeTrigger.click();
    const modePicker = page.getByTestId("home-mode-picker");
    await expect(modePicker.getByRole("button")).toHaveCount(4);
    await modePicker.getByRole("button", { name: /AI 绘图/ }).click();
    await expect(page.getByRole("button", { name: "当前创作模式：AI 绘图" })).toBeVisible();
    await expect(prompt).toHaveAttribute("placeholder", /^描述你想创作的内容，比如：生成电影感的未来城市概念图/);
    await expect(page.getByRole("button", { name: "使用麦克风" })).toHaveCount(0);
    if (testInfo.project.name === "chromium") {
        await prompt.focus();
        expect(await prompt.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe("none");
        expect(await prompt.evaluate((element) => getComputedStyle(element).borderTopWidth)).toBe("0px");
        expect(await prompt.evaluate((element) => getComputedStyle(element).boxShadow)).toBe("none");
        expect(await prompt.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe("rgba(0, 0, 0, 0)");

        const send = page.getByRole("button", { name: "开始创作" });
        await expect(send).toHaveAttribute("data-generation-action", "true");
        await expect(send.locator(".generation-action-button__glyph")).toHaveCount(1);
        await expect(send.locator(".generation-action-button__label")).toHaveText("开始创作");
        await send.hover();
        const sendStyle = await send.evaluate((element) => ({
            backgroundImage: getComputedStyle(element).backgroundImage,
            borderRadius: getComputedStyle(element).borderRadius,
            boxShadow: getComputedStyle(element).boxShadow,
            color: getComputedStyle(element).color,
        }));
        expect(sendStyle.backgroundImage).toContain("linear-gradient");
        expect(sendStyle.borderRadius).toBe("14px");
        expect(sendStyle.boxShadow).not.toBe("none");
        expect(sendStyle.color).toBe("rgb(255, 255, 255)");
    }
    for (const action of ["开始创作"]) {
        await page.getByRole("button", { name: action }).click();
        const dialog = page.getByRole("dialog");
        const closeButton = dialog.getByRole("button", { name: "Close" });
        await expect(dialog).toBeVisible();
        await expect(dialog.getByRole("heading", { name: "登录后回到刚才的位置" })).toBeVisible();
        await expect(dialog.getByText("登录后将继续刚才的创作操作，输入内容不会丢失。")).toHaveCount(0);
        await expect(closeButton).toBeVisible();
        await closeButton.click();
        await expect(dialog).toBeHidden();
    }
    await expect(page.locator('input[type="file"][accept*="image"]')).toHaveCount(1);
    await expect(page.getByRole("navigation", { name: "产品" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "平台" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "解决方案" })).toHaveCount(0);
    await expect(page.getByRole("navigation", { name: "联系我们" })).toHaveCount(0);
    if (testInfo.project.name.startsWith("mobile-")) {
        const footerLayout = await mobileFooterDomState(page);
        expect(footerLayout.navigationCount).toBe(3);
        expect(footerLayout.navigationLeftSpread).toBeLessThanOrEqual(1);
        expect(footerLayout.navigationTops).toEqual([...footerLayout.navigationTops].sort((left, right) => left - right));
        expect(footerLayout.productFirstRowTopDelta).toBeLessThanOrEqual(1);
        expect(footerLayout.productSecondColumnOffset).toBeGreaterThan(120);
        expect(footerLayout.socialLogoTopDelta).toBeLessThanOrEqual(4);
        expect(footerLayout.firstPolicyLeft).toBeGreaterThan(footerLayout.footerCenter);
    }

    await expect(page.getByRole("tab", { name: "音频作品" })).toHaveCount(0);
    await page.getByRole("tab", { name: "视频", exact: true }).click();
    await expect(page.getByRole("tab", { name: "视频", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("home-public-gallery").locator("article")).toHaveCount(1);
    await page
        .getByTestId("home-gallery-card")
        .getByRole("button", { name: /查看作品/ })
        .click();
    const videoPreview = page.getByRole("dialog");
    await expect(videoPreview.locator("video")).toBeVisible();
    await videoPreview.getByRole("button", { name: "Close" }).click();
    await expect(page).toHaveURL(/\/$/);
    await page.getByRole("tab", { name: "短剧", exact: true }).click();
    await expect(page.getByTestId("home-public-gallery").locator("article")).toHaveCount(2);
    const brandTab = page.getByRole("tab", { name: "品牌内容", exact: true });
    await brandTab.click();
    if (testInfo.project.name === "chromium") await brandTab.hover();
    await expect.poll(() => brandTab.evaluate((element) => getComputedStyle(element).backgroundImage)).toContain("linear-gradient");
    await expect(brandTab).not.toHaveCSS("color", "rgb(255, 255, 255)");

    const beforeTheme = await homepageDomState(page);
    await page.getByRole("button", { name: "切换到深色主题" }).click();
    await expect(page.locator("html")).toHaveClass(/dark/);
    if (testInfo.project.name === "chromium") {
        const attach = page.getByRole("button", { name: "参考素材" });
        const send = page.getByRole("button", { name: "开始创作" });
        const [attachStyle, sendStyle] = await Promise.all([
            attach.evaluate((element) => ({ backgroundImage: getComputedStyle(element).backgroundImage, borderColor: getComputedStyle(element).borderColor, color: getComputedStyle(element).color })),
            send.evaluate((element) => ({ backgroundImage: getComputedStyle(element).backgroundImage, color: getComputedStyle(element).color })),
        ]);
        expect(attachStyle.backgroundImage).toBe("none");
        expect(attachStyle.borderColor).not.toBe("rgba(0, 0, 0, 0)");
        expect(attachStyle.color).not.toBe(sendStyle.color);
        expect(sendStyle.backgroundImage).toContain("linear-gradient");
        expect(sendStyle.color).toBe("rgb(255, 255, 255)");
    }
    expect(await homepageDomState(page)).toEqual(beforeTheme);
    await expectNoHorizontalOverflow(page);
    expect(browserErrors).toEqual([]);
    await context.close();
});

test("signed-in homepage restores the selected creation mode and prompt", async ({ page }, testInfo) => {
    await page.route("**/api/public/gallery?**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(galleryResponse) }));
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.locator("header").getByRole("button", { name: "打开个人中心" })).toBeVisible();
    await page.getByRole("button", { name: "当前创作模式：智能模式" }).click();
    await page.getByTestId("home-mode-picker").getByRole("button", { name: /AI 绘图/ }).click();
    await page.getByLabel("描述你想创作的内容").fill("已登录首页图片提示词");
    await page.getByTestId("home-agent-card").getByRole("button", { name: "开始创作" }).click();
    await expect(page).toHaveURL(/\/create(?:#.*)?$/);
    await expect(page.getByRole("button", { name: "当前创作类型：图片生成" })).toBeVisible();
    await expect(page.locator("textarea").first()).toHaveValue("已登录首页图片提示词");
});

test("homepage gallery hides internal service errors from visitors", async ({ page }) => {
    await page.route("**/api/public/gallery?**", (route) =>
        route.fulfill({
            status: 409,
            contentType: "application/json",
            body: JSON.stringify({ code: 409, data: null, msg: "作品广场需要启用 PostgreSQL 数据库" }),
        }),
    );
    await page.goto("/", { waitUntil: "domcontentloaded" });

    await expect(page.getByRole("heading", { name: "作品暂时无法加载" })).toBeVisible();
    await expect(page.getByText("请稍后重试，或刷新页面后再试。")).toBeVisible();
    await expect(page.getByRole("button", { name: "重新加载" })).toBeVisible();
    await expect(page.getByText(/PostgreSQL|数据库|部署/)).toHaveCount(0);
});

test("homepage hero stays centered and responsive", async ({ page }, testInfo) => {
    await page.route("**/api/public/gallery?**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(galleryResponse) }));
    await page.goto("/", { waitUntil: "domcontentloaded" });
    const geometry = await page.evaluate(() => {
        const viewportWidth = document.documentElement.clientWidth;
        const title = document.querySelector("h1")!.getBoundingClientRect();
        const subtitle = document.querySelector("h1 + p")!.getBoundingClientRect();
        const card = document.querySelector<HTMLElement>('[data-testid="home-agent-card"]')!.getBoundingClientRect();
        const halo = document.querySelector<HTMLElement>('[data-testid="home-agent-halo"]')!.getBoundingClientRect();
        const textarea = document.querySelector<HTMLElement>("#home-agent-prompt")!.getBoundingClientRect();
        const sendElement = document.querySelector<HTMLElement>('button[aria-label="开始创作"]')!;
        const send = sendElement.getBoundingClientRect();
        const toolbarElement = sendElement.closest("div")!.parentElement!;
        const toolbar = toolbarElement.getBoundingClientRect();
        const toolbarButtons = Array.from(toolbarElement.querySelectorAll<HTMLButtonElement>("button"));
        const toolbarButtonRects = toolbarButtons.map((button) => button.getBoundingClientRect());
        const cardRadius = Number.parseFloat(getComputedStyle(document.querySelector<HTMLElement>('[data-testid="home-agent-card"]')!).borderRadius);
        const rings = Array.from(document.querySelectorAll<HTMLElement>("[data-halo-ring]"));
        const decorations = Array.from(document.querySelectorAll<HTMLElement>("[data-hero-decoration]"));
        return {
            viewportWidth,
            titleCenterOffset: Math.abs(title.left + title.width / 2 - viewportWidth / 2),
            subtitleCenterOffset: Math.abs(subtitle.left + subtitle.width / 2 - viewportWidth / 2),
            cardCenterOffset: Math.abs(card.left + card.width / 2 - viewportWidth / 2),
            cardWidth: card.width,
            cardHeight: card.height,
            cardRadius,
            haloCenterOffset: Math.abs(halo.left + halo.width / 2 - (card.left + card.width / 2)),
            haloWidthRatio: halo.width / card.width,
            haloTop: halo.top,
            cardBottom: card.bottom,
            textareaHeight: textarea.height,
            toolbarOffset: toolbar.top - textarea.bottom,
            sendInset: card.right - send.right,
            sendVisible: send.width >= 42 && send.height >= 42,
            filledRingCount: rings.filter((ring) => getComputedStyle(ring).backgroundImage !== "none").length,
            borderOnlyRingCount: rings.filter((ring) => Number.parseFloat(getComputedStyle(ring).borderTopWidth) > 0 && getComputedStyle(ring).backgroundImage === "none").length,
            decorationCount: decorations.length,
            mobileToolbarButtonCount: toolbarButtons.length,
            mobileToolbarButtonsInsideCard: toolbarButtonRects.every((button) => button.left >= card.left && button.right <= card.right && button.top >= card.top && button.bottom <= card.bottom),
            mobileToolbarMaxRight: Math.max(...toolbarButtonRects.map((button) => button.right)),
        };
    });
    expect(geometry.titleCenterOffset).toBeLessThanOrEqual(2);
    expect(geometry.subtitleCenterOffset).toBeLessThanOrEqual(2);
    expect(geometry.cardCenterOffset).toBeLessThanOrEqual(2);
    expect(geometry.cardWidth).toBeLessThanOrEqual(geometry.viewportWidth - (geometry.viewportWidth < 768 ? 24 : 48));
    if (testInfo.project.name === "chromium") {
        expect(geometry.cardWidth).toBeGreaterThanOrEqual(1040);
        expect(geometry.cardWidth).toBeLessThanOrEqual(1100);
        expect(geometry.cardHeight).toBeGreaterThanOrEqual(130);
        expect(geometry.cardHeight).toBeLessThanOrEqual(220);
        expect(geometry.cardRadius).toBeGreaterThanOrEqual(20);
        expect(geometry.cardRadius).toBeLessThanOrEqual(30);
        expect(geometry.haloCenterOffset).toBeLessThanOrEqual(1);
        expect(geometry.haloWidthRatio).toBeGreaterThan(1.2);
        expect(geometry.haloWidthRatio).toBeLessThan(2);
        expect(geometry.haloTop).toBeLessThan(geometry.cardBottom);
        expect(geometry.textareaHeight).toBeGreaterThanOrEqual(40);
        expect(geometry.toolbarOffset).toBeGreaterThanOrEqual(8);
        expect(geometry.sendInset).toBeGreaterThanOrEqual(16);
        expect(geometry.filledRingCount).toBe(4);
        expect(geometry.borderOnlyRingCount).toBe(0);
        expect(geometry.decorationCount).toBe(0);
    }
    if (testInfo.project.name.startsWith("mobile-")) {
        expect(geometry.mobileToolbarButtonCount).toBe(5);
        expect(geometry.mobileToolbarButtonsInsideCard).toBe(true);
        expect(geometry.mobileToolbarMaxRight).toBeLessThanOrEqual(geometry.viewportWidth);
    }
    expect(geometry.sendVisible).toBe(true);
    await expectNoHorizontalOverflow(page);
});

test("homepage dark composer keeps entered text and caret readable", async ({ page }, testInfo) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.evaluate(() => localStorage.setItem("dreamyo:theme_store", JSON.stringify({ state: { theme: "dark" }, version: 0 })));
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator("html")).toHaveClass(/dark/);
    const prompt = page.locator('textarea[aria-label="描述你想创作的内容"]:visible').first();
    await prompt.fill("暗色主题真实输入可读性验收");
    const style = await prompt.evaluate((element) => {
        const computed = getComputedStyle(element);
        const panel = element.closest('[data-testid="home-agent-card"]');
        const panelStyle = panel ? getComputedStyle(panel) : null;
        return {
            color: computed.color,
            fill: computed.webkitTextFillColor,
            caret: computed.caretColor,
            background: panelStyle?.backgroundColor || "",
            text: element.value,
        };
    });
    expect(style.text).toBe("暗色主题真实输入可读性验收");
    expect(style.color).toBe("rgb(35, 61, 115)");
    expect(style.fill).toBe("rgb(35, 61, 115)");
    expect(style.caret).toBe("rgb(53, 204, 225)");
    expect(style.background).toContain("rgba(245, 250, 255");

    const viewport = await page.evaluate(() => ({
        width: innerWidth,
        height: innerHeight,
        visualWidth: visualViewport?.width || 0,
        visualHeight: visualViewport?.height || 0,
        zoom: visualViewport?.scale || 1,
    }));
    const evidenceRoot = path.resolve(process.cwd(), "../docs/ui-rebuild-20260913/evidence");
    const stem = `after-home-dark-composer-${testInfo.project.name}`;
    await mkdir(evidenceRoot, { recursive: true });
    await page.screenshot({ path: path.join(evidenceRoot, `${stem}.png`), fullPage: false });
    await writeFile(
        path.join(evidenceRoot, `${stem}.json`),
        `${JSON.stringify({ route: "/", theme: "dark", viewport, state: "暗色主题真实输入与光标", text: style.text, colors: { text: style.color, webkitTextFill: style.fill, caret: style.caret, panel: style.background }, buildId: (await readFile(path.resolve(process.cwd(), ".next/BUILD_ID"), "utf8")).trim() }, null, 2)}\n`,
        "utf8",
    );
});

test("front-end and administrator theme choices remain independent", async ({ page, context }, testInfo) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.evaluate(() => {
        localStorage.setItem("dreamyo:theme_store", JSON.stringify({ state: { theme: "light" }, version: 0 }));
        localStorage.setItem("dreamyo:admin_theme_store", JSON.stringify({ state: { theme: "light" }, version: 0 }));
    });
    await page.reload({ waitUntil: "domcontentloaded" });

    await page.getByRole("button", { name: "切换到深色主题" }).click();
    await expect(page.locator("html")).toHaveClass(/dark/);
    await expect.poll(() => storedThemes(page)).toEqual({ frontend: "dark", admin: "light" });

    const peer = await context.newPage();
    try {
        await peer.goto("/", { waitUntil: "domcontentloaded" });
        await expect(peer.locator("html")).toHaveClass(/dark/);
        await peer.getByRole("button", { name: "切换到浅色主题" }).click();
        await expect(peer.locator("html")).not.toHaveClass(/dark/);
        await expect.poll(() => page.locator("html").getAttribute("class")).not.toMatch(/dark/);
        await expect.poll(() => storedThemes(page)).toEqual({ frontend: "light", admin: "light" });
    } finally {
        await peer.close();
    }

    await page.goto("/admin", { waitUntil: "domcontentloaded" });
    await expect(page.locator("html")).not.toHaveClass(/dark/);
    await page.getByRole("button", { name: "切换到深色主题" }).click();
    await expect(page.locator("html")).toHaveClass(/dark/);
    await expect.poll(() => storedThemes(page)).toEqual({ frontend: "light", admin: "dark" });
    await page.getByRole("button", { name: "切换到浅色主题" }).click();
    await expect(page.locator("html")).not.toHaveClass(/dark/);
    await expect.poll(() => storedThemes(page)).toEqual({ frontend: "light", admin: "light" });

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator("html")).not.toHaveClass(/dark/);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.locator("html")).not.toHaveClass(/dark/);

    const measurement = await page.evaluate(() => ({
        route: location.pathname,
        theme: document.documentElement.classList.contains("dark") ? "dark" : "light",
        viewport: { width: innerWidth, height: innerHeight, visualWidth: visualViewport?.width || 0, visualHeight: visualViewport?.height || 0, zoom: visualViewport?.scale || 1 },
        stored: {
            frontend: JSON.parse(localStorage.getItem("dreamyo:theme_store") || "{}").state?.theme,
            admin: JSON.parse(localStorage.getItem("dreamyo:admin_theme_store") || "{}").state?.theme,
        },
        crossTabSync: "frontend theme synchronized through peer tab while admin scope remained independent",
    }));
    const root = path.resolve(process.cwd(), "../docs/ui-rebuild-20260913/evidence");
    await mkdir(root, { recursive: true });
    await page.screenshot({ path: path.join(root, `after-theme-scope-cross-tab-${testInfo.project.name}.png`), fullPage: false });
    await writeFile(
        path.join(root, `after-theme-scope-cross-tab-${testInfo.project.name}.json`),
        `${JSON.stringify({ ...measurement, state: "前台/后台主题作用域跨页刷新与跨标签同步", buildId: (await readFile(path.resolve(process.cwd(), ".next/BUILD_ID"), "utf8")).trim(), capturedAt: new Date().toISOString() }, null, 2)}\n`,
        "utf8",
    );
});

function galleryItem(index: number, mediaType: "image" | "video", sourceType: "media" | "canvas" | "drama", category: string) {
    return {
        slug: `home-e2e-${index}`,
        sourceType,
        viewCount: index * 10,
        likeCount: index * 3,
        isFeatured: false,
        publishedAt: "2026-08-05T00:00:00.000Z",
        title: `首页公开作品 ${index}`,
        description: "公开作品测试数据",
        publicPrompt: `public fixture ${index}`,
        category,
        tags: [],
        authorName: "公开创作者",
        preview: {
            id: `home-preview-${index}`,
            mediaType,
            mimeType: mediaType === "video" ? "video/mp4" : "image/svg+xml",
            url: mediaType === "video" ? "data:video/mp4;base64," : `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="640" height="480" fill="hsl(${index * 48} 58% 62%)"/></svg>`)}`,
        },
    };
}

async function storedThemes(page: Page) {
    return page.evaluate(() => {
        const readTheme = (key: string) => JSON.parse(localStorage.getItem(key) || "{}")?.state?.theme;
        return {
            frontend: readTheme("dreamyo:theme_store"),
            admin: readTheme("dreamyo:admin_theme_store"),
        };
    });
}

function collectBrowserErrors(page: Page) {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
    });
    return errors;
}

async function homepageDomState(page: Page) {
    return page.evaluate(() => ({
        mains: document.querySelectorAll("main").length,
        heroes: document.querySelectorAll("h1").length,
        agentCards: document.querySelectorAll('[data-testid="home-agent-card"]').length,
    }));
}

async function mobileFooterDomState(page: Page) {
    return page.evaluate(() => {
        const footer = document.querySelector<HTMLElement>("footer")!;
        const navigations = Array.from(footer.querySelectorAll<HTMLElement>("nav"));
        const navigationRects = navigations.map((navigation) => navigation.getBoundingClientRect());
        const productItems = Array.from(navigations[0].querySelectorAll<HTMLElement>("a, button")).map((item) => item.getBoundingClientRect());
        const social = footer.querySelector<HTMLElement>('a[aria-label="邮箱联系"]');
        const footerLogo = footer.querySelector<HTMLElement>('a[href="/"]');
        const firstPolicy = footer.querySelector<HTMLElement>('[data-testid="home-footer-bottom"] a');
        const footerRect = footer.getBoundingClientRect();
        return {
            navigationCount: navigations.length,
            navigationLeftSpread: Math.max(...navigationRects.map((rect) => rect.left)) - Math.min(...navigationRects.map((rect) => rect.left)),
            navigationTops: navigationRects.map((rect) => Math.round(rect.top)),
            productFirstRowTopDelta: Math.abs(productItems[0].top - productItems[1].top),
            productSecondColumnOffset: productItems[1].left - productItems[0].left,
            socialLogoTopDelta: social && footerLogo ? Math.abs(social.getBoundingClientRect().top - footerLogo.getBoundingClientRect().top) : Number.POSITIVE_INFINITY,
            firstPolicyLeft: firstPolicy?.getBoundingClientRect().left || 0,
            footerCenter: footerRect.left + footerRect.width / 2,
        };
    });
}

async function expectNoHorizontalOverflow(page: Page) {
    const overflow = await page.evaluate(() => {
        const root = document.querySelector<HTMLElement>("main.app-scroll-page");
        const rootBounds = root?.getBoundingClientRect();
        const offenders = rootBounds
            ? Array.from(root.querySelectorAll<HTMLElement>("*")).flatMap((element) => {
                  const bounds = element.getBoundingClientRect();
                  if (bounds.width <= 0 || (bounds.left >= rootBounds.left - 1 && bounds.right <= rootBounds.right + 1)) return [];
                  let parent = element.parentElement;
                  while (parent && parent !== root) {
                      const overflowX = getComputedStyle(parent).overflowX;
                      if (overflowX === "hidden" || overflowX === "clip" || overflowX === "auto" || overflowX === "scroll") return [];
                      parent = parent.parentElement;
                  }
                  return [{ tag: element.tagName, className: element.className, left: Math.round(bounds.left), right: Math.round(bounds.right), width: Math.round(bounds.width) }];
              })
            : [];
        return {
            document: [document.documentElement.clientWidth, document.documentElement.scrollWidth],
            body: [document.body.clientWidth, document.body.scrollWidth],
            root: root ? [root.clientWidth, root.scrollWidth] : [0, 1],
            offenders,
        };
    });
    for (const [label, widths] of Object.entries(overflow)) {
        if (label === "offenders") continue;
        const [clientWidth, scrollWidth] = widths as number[];
        expect(scrollWidth, `${label} horizontal overflow: ${JSON.stringify(overflow.offenders)}`).toBeLessThanOrEqual(clientWidth + 1);
    }
}
