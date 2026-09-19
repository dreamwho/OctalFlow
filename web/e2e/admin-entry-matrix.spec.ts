import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";

const evidenceRoot = path.resolve(process.cwd(), "../docs/ui-rebuild-20260913/evidence/admin-entry-matrix");
const viewports = [
    { name: "1672x941", width: 1672, height: 941 },
    { name: "1440x900", width: 1440, height: 900 },
    { name: "1366x768", width: 1366, height: 768 },
    { name: "1024x768", width: 1024, height: 768 },
    { name: "768x1024", width: 768, height: 1024 },
    { name: "430x932", width: 430, height: 932 },
    { name: "390x844", width: 390, height: 844 },
] as const;
const routes = [
    { id: "R20-admin-billing", path: "/admin/billing", state: "后台财务入口" },
    { id: "R21-admin-generation-operations", path: "/admin/generation-operations", expectedPath: /\/admin\?section=generationOperations$/, state: "后台生成运维入口" },
    { id: "R22-admin", path: "/admin", state: "后台总览入口" },
    { id: "R23-admin-setup", path: "/admin/setup", state: "后台初始化入口" },
] as const;

test("admin entry routes render their real redirects and layouts across the matrix", async ({ page }) => {
    test.setTimeout(240_000);
    await mkdir(evidenceRoot, { recursive: true });
    for (const viewport of viewports) {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        for (const theme of ["light", "dark"] as const) {
            await setAdminTheme(page, theme);
            for (const route of routes) {
                const response = await page.goto(route.path, { waitUntil: "domcontentloaded" });
                expect(response?.status() || 200).toBeLessThan(500);
                if (route.expectedPath) await expect(page).toHaveURL(route.expectedPath);
                await page.waitForLoadState("load");
                await expect(page.locator("main").first()).toBeVisible();
                const measurement = await page.evaluate(
                    (payload) => {
                        const main = document.querySelector<HTMLElement>("main");
                        const rect = main?.getBoundingClientRect();
                        return {
                            requestedPath: payload.requestedPath,
                            actualPath: location.pathname + location.search,
                            responseStatus: payload.status,
                            title: document.title,
                            theme: document.documentElement.classList.contains("dark") ? "dark" : "light",
                            viewport: { width: innerWidth, height: innerHeight, visualWidth: visualViewport?.width || 0, visualHeight: visualViewport?.height || 0, zoom: visualViewport?.scale || 1 },
                            heading: document.querySelector("h1, h2")?.textContent?.trim() || "",
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
                expect(measurement.heading).toBeTruthy();
                expect(measurement.overflow).toBe(false);
                const stem = `${route.id}-${theme}-${viewport.name}`;
                await page.screenshot({ path: path.join(evidenceRoot, `${stem}.png`), fullPage: false });
                await writeFile(path.join(evidenceRoot, `${stem}.json`), `${JSON.stringify({ ...measurement, state: route.state, buildId: await currentBuildId() }, null, 2)}\n`, "utf8");
            }
        }
    }
});

async function setAdminTheme(page: Page, theme: "light" | "dark") {
    await page.goto("/admin", { waitUntil: "domcontentloaded" });
    await page.evaluate((nextTheme) => localStorage.setItem("dreamyo:admin_theme_store", JSON.stringify({ state: { theme: nextTheme }, version: 0 })), theme);
    await page.reload({ waitUntil: "domcontentloaded" });
    if (theme === "dark") await expect(page.locator("html")).toHaveClass(/dark/);
    else await expect(page.locator("html")).not.toHaveClass(/dark/);
}

async function currentBuildId() {
    return (await readFile(path.resolve(process.cwd(), ".next/BUILD_ID"), "utf8")).trim();
}
