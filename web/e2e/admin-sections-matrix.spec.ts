import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { ADMIN_SECTION_KEYS } from "../src/components/admin/admin-sections";

const evidenceRoot = path.resolve(process.cwd(), "../docs/ui-rebuild-20260913/evidence/admin-sections-matrix");
const viewports = [
    { name: "1672x941", width: 1672, height: 941 },
    { name: "1440x900", width: 1440, height: 900 },
    { name: "1366x768", width: 1366, height: 768 },
    { name: "1024x768", width: 1024, height: 768 },
    { name: "768x1024", width: 768, height: 1024 },
    { name: "430x932", width: 430, height: 932 },
    { name: "390x844", width: 390, height: 844 },
] as const;

test("all admin sections render C01 default states across the required viewport matrix", async ({ page }) => {
    test.setTimeout(900_000);
    await mkdir(evidenceRoot, { recursive: true });
    for (const viewport of viewports) {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        for (const theme of ["light", "dark"] as const) {
            await setAdminTheme(page, theme);
            for (const section of ADMIN_SECTION_KEYS) {
                const route = section === "overview" ? "/admin" : `/admin?section=${encodeURIComponent(section)}`;
                await page.goto(route, { waitUntil: "domcontentloaded" });
                await expect(page.locator("[data-hydrated='true']")).toBeVisible();
                const heading = page.locator(".admin-dashboard-intro h1:visible").first();
                await expect(heading).toBeVisible();
                const measurement = await page.evaluate(
                    (payload) => {
                        const shell = document.querySelector<HTMLElement>(".admin-dashboard-shell");
                        const content = document.querySelector<HTMLElement>(".admin-dashboard-content");
                        const h1 = document.querySelector<HTMLElement>(".admin-dashboard-intro h1");
                        const shellRect = shell?.getBoundingClientRect();
                        const contentRect = content?.getBoundingClientRect();
                        const headingRect = h1?.getBoundingClientRect();
                        return {
                            route: location.pathname + location.search,
                            section: payload.section,
                            theme: document.documentElement.classList.contains("dark") ? "dark" : "light",
                            viewport: { width: innerWidth, height: innerHeight, visualWidth: visualViewport?.width || 0, visualHeight: visualViewport?.height || 0, zoom: visualViewport?.scale || 1 },
                            heading: h1?.textContent?.trim() || "",
                            shell: shellRect ? { left: shellRect.left, top: shellRect.top, width: shellRect.width, height: shellRect.height } : null,
                            content: contentRect ? { left: contentRect.left, top: contentRect.top, width: contentRect.width, height: contentRect.height } : null,
                            headingRect: headingRect ? { left: headingRect.left, top: headingRect.top, width: headingRect.width, height: headingRect.height } : null,
                            overflow: document.documentElement.scrollWidth > innerWidth || document.body.scrollWidth > innerWidth,
                        };
                    },
                    { section },
                );
                expect(measurement.theme).toBe(theme);
                expect(measurement.viewport.width).toBe(viewport.width);
                expect(measurement.viewport.visualWidth).toBe(viewport.width);
                expect(measurement.viewport.height).toBe(viewport.height);
                expect(measurement.viewport.visualHeight).toBe(viewport.height);
                expect(measurement.heading).toBeTruthy();
                expect(measurement.overflow).toBe(false);
                const stem = `${section}-${theme}-${viewport.name}`;
                await page.screenshot({ path: path.join(evidenceRoot, `${stem}.png`), fullPage: false });
                await writeFile(path.join(evidenceRoot, `${stem}.json`), `${JSON.stringify({ ...measurement, state: "后台默认分区", buildId: await currentBuildId() }, null, 2)}\n`, "utf8");
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
