import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const evidenceRoot = path.resolve(process.cwd(), "../docs/ui-rebuild-20260913/evidence");

test.describe.configure({ mode: "serial" });

test("admin brand settings persist, render in both themes, and recover from a bad logo", async ({ page, request }) => {
    test.setTimeout(120_000);
    const beforeResponse = await request.get("/api/admin/settings");
    expect(beforeResponse.ok(), await beforeResponse.text()).toBe(true);
    const before = ((await beforeResponse.json()) as { settings: { site: Record<string, unknown> } }).settings.site;
    const suffix = randomUUID().slice(0, 8);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><path fill="#18c7d8" d="M32 3 58 19v26L32 61 6 45V19z"/><circle cx="32" cy="32" r="11" fill="#fff"/></svg>`;
    const customLogo = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
    const site = { ...before, title: `dreamyo 品牌验收 ${suffix}`, logoUrl: customLogo, iconUrl: customLogo };

    try {
        const saved = await request.patch("/api/admin/settings", { data: { site } });
        expect(saved.ok(), await saved.text()).toBe(true);
        const persisted = await readSite(request);
        expect(persisted.logoUrl).toBe(customLogo);
        expect(persisted.iconUrl).toBe(customLogo);

        await mkdir(evidenceRoot, { recursive: true });
        for (const viewport of [
            { name: "desktop-1440", width: 1440, height: 900 },
            { name: "mobile-390", width: 390, height: 844 },
        ]) {
            await page.setViewportSize({ width: viewport.width, height: viewport.height });
            for (const theme of ["light", "dark"] as const) {
                await setTheme(page, theme);
                await page.goto("/admin?section=site", { waitUntil: "domcontentloaded" });
                await expect(page.locator("[data-hydrated='true']")).toBeVisible();
                await expect(page.getByRole("heading", { name: "网站设置", exact: true })).toBeVisible();
                const logoInput = page.locator("label").filter({ hasText: "Logo URL" }).locator("input").first();
                await expect(logoInput).toHaveValue(customLogo);
                await expect(page.getByText("已设置", { exact: true }).first()).toBeVisible();
                await expect(page.locator(`img[src^="data:image/svg+xml;base64,"]`).first()).toBeAttached();

                const measurement = await page.evaluate(
                    (payload) => {
                        const shell = document.querySelector<HTMLElement>(".admin-dashboard-shell");
                        const preview = [...document.querySelectorAll<HTMLImageElement>('img[src^="data:image/svg+xml;base64,"]')].find((image) => {
                            const rect = image.getBoundingClientRect();
                            return rect.width > 0 && rect.height > 0;
                        });
                        const shellRect = shell?.getBoundingClientRect();
                        const previewRect = preview?.getBoundingClientRect();
                        return {
                            route: location.pathname + location.search,
                            theme: document.documentElement.classList.contains("dark") ? "dark" : "light",
                            viewport: { width: innerWidth, height: innerHeight, zoom: visualViewport?.scale || 1 },
                            logo: previewRect ? { left: previewRect.left, top: previewRect.top, width: previewRect.width, height: previewRect.height } : null,
                            shell: shellRect ? { left: shellRect.left, top: shellRect.top, width: shellRect.width, height: shellRect.height } : null,
                            overflow: document.documentElement.scrollWidth > innerWidth || document.body.scrollWidth > innerWidth,
                            state: payload.state,
                        };
                    },
                    { state: "自定义Logo已持久化" },
                );
                expect(measurement.theme).toBe(theme);
                expect(measurement.logo?.width).toBeGreaterThan(0);
                expect(measurement.logo?.height).toBeGreaterThan(0);
                expect(measurement.overflow).toBe(false);
                const stem = `after-admin-brand-${theme}-${viewport.name}`;
                await page.screenshot({ path: path.join(evidenceRoot, `${stem}.png`), fullPage: false });
                await writeFile(path.join(evidenceRoot, `${stem}.json`), `${JSON.stringify({ ...measurement, buildId: await currentBuildId() }, null, 2)}\n`, "utf8");
            }
        }

        await page.goto("/admin?section=site", { waitUntil: "domcontentloaded" });
        const titleInput = page.locator("label").filter({ hasText: "网站标题" }).locator("input").first();
        await titleInput.fill(`dreamyo 保存回归 ${suffix}`);
        await page.getByRole("button", { name: "保存网站设置" }).click();
        await expect(page.getByText("网站信息已保存", { exact: true })).toBeVisible();
        const afterUiSave = await readSite(request);
        expect(afterUiSave.title).toBe(`dreamyo 保存回归 ${suffix}`);
        await page.reload({ waitUntil: "domcontentloaded" });
        await expect(titleInput).toHaveValue(`dreamyo 保存回归 ${suffix}`);

        const invalid = await request.patch("/api/admin/settings", { data: { site: { ...site, logoUrl: "https://127.0.0.1:9/invalid-logo.svg" } } });
        expect(invalid.ok(), await invalid.text()).toBe(true);
        await page.reload({ waitUntil: "domcontentloaded" });
        await expect(page.locator('img[src*="/brand/dreamyo/mark.png"]:visible').first()).toBeVisible({ timeout: 10_000 });
        await page.screenshot({ path: path.join(evidenceRoot, "after-admin-brand-invalid-fallback-light-desktop-1440.png"), fullPage: false });
        await writeFile(
            path.join(evidenceRoot, "after-admin-brand-invalid-fallback-light-desktop-1440.json"),
            `${JSON.stringify({ route: "/admin?section=site", theme: "light", viewport: { width: 1440, height: 900, zoom: 1 }, state: "无效Logo回退", fallback: "/brand/dreamyo/mark.png", buildId: await currentBuildId() }, null, 2)}\n`,
            "utf8",
        );

        await setTheme(page, "dark");
        await page.goto("/admin?section=site", { waitUntil: "domcontentloaded" });
        await expect(page.locator('img[src*="/brand/dreamyo/mark.png"]:visible').first()).toBeVisible({ timeout: 10_000 });
        const darkFallback = await page.evaluate(() => ({
            route: location.pathname + location.search,
            theme: document.documentElement.classList.contains("dark") ? "dark" : "light",
            viewport: { width: innerWidth, height: innerHeight, zoom: visualViewport?.scale || 1 },
            fallback: [...document.querySelectorAll<HTMLImageElement>('img[src*="/brand/dreamyo/mark.png"]')].some((image) => {
                const rect = image.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0;
            }),
            overflow: document.documentElement.scrollWidth > innerWidth || document.body.scrollWidth > innerWidth,
        }));
        expect(darkFallback.theme).toBe("dark");
        expect(darkFallback.fallback).toBe(true);
        expect(darkFallback.overflow).toBe(false);
        await page.screenshot({ path: path.join(evidenceRoot, "after-admin-brand-invalid-fallback-dark-desktop-1440.png"), fullPage: false });
        await writeFile(path.join(evidenceRoot, "after-admin-brand-invalid-fallback-dark-desktop-1440.json"), `${JSON.stringify({ ...darkFallback, state: "无效Logo深色主题回退", buildId: await currentBuildId() }, null, 2)}\n`, "utf8");
    } finally {
        const restored = await request.patch("/api/admin/settings", { data: { site: before } });
        expect(restored.ok(), await restored.text()).toBe(true);
    }
});

async function readSite(request: APIRequestContext) {
    const response = await request.get("/api/admin/settings");
    expect(response.ok(), await response.text()).toBe(true);
    return ((await response.json()) as { settings: { site: Record<string, string> } }).settings.site;
}

async function setTheme(page: Page, theme: "light" | "dark") {
    await page.goto("/admin", { waitUntil: "domcontentloaded" });
    await page.evaluate((nextTheme) => localStorage.setItem("dreamyo:admin_theme_store", JSON.stringify({ state: { theme: nextTheme }, version: 0 })), theme);
    await page.reload({ waitUntil: "domcontentloaded" });
    if (theme === "dark") await expect(page.locator("html")).toHaveClass(/dark/);
    else await expect(page.locator("html")).not.toHaveClass(/dark/);
}

async function currentBuildId() {
    return (await readFile(path.resolve(process.cwd(), ".next/BUILD_ID"), "utf8")).trim();
}
