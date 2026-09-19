import { chromium } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";

async function run() {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();

    console.log("Navigating to login...");
    await page.goto("http://127.0.0.1:3333/login");
    await page.waitForLoadState("networkidle");

    const emailInput = page.locator('input[type="email"], input[placeholder*="邮箱"], input[name="email"]').first();
    const passInput = page.locator('input[type="password"]').first();
    if (await emailInput.isVisible()) {
        console.log("Submitting login form...");
        await emailInput.fill("admin@example.com");
        await passInput.fill("Admin123456!");
        await page.locator('button[type="submit"]').first().click();
        await page.waitForTimeout(1500);
    }

    console.log("Navigating to canvas...");
    await page.goto("http://127.0.0.1:3333/canvas");
    await page.waitForLoadState("networkidle");
    console.log("Current URL after login:", page.url());

    // Create a new canvas or open first project
    const projectCard = page.locator('[data-canvas-project-card], .canvas-card, [href^="/canvas/"]').first();
    if (await projectCard.isVisible()) {
        console.log("Opening existing canvas project...");
        await projectCard.click();
    } else {
        const createBtn = page.locator('button:has-text("新建画布"), button:has-text("新建项目"), [data-action="create-canvas"]').first();
        if (await createBtn.isVisible()) {
            console.log("Clicking create canvas button...");
            await createBtn.click();
        }
    }
    await page.waitForTimeout(2000);
    console.log("Canvas URL:", page.url());

    // Check for canvas nodes
    const imageNode = page.locator('[data-node-id], .react-flow__node').first();
    if (await imageNode.isVisible()) {
        console.log("Found canvas node, clicking to open prompt panel...");
        await imageNode.dblclick();
        await page.waitForTimeout(1000);
    }

    const promptPanel = page.locator('[data-canvas-node-prompt-panel]').first();
    const panelVisible = await promptPanel.isVisible().catch(() => false);
    console.log("Prompt panel visible:", panelVisible);

    if (panelVisible) {
        const genBar = promptPanel.locator('[data-canvas-generation-bar]');
        const borderTop = await genBar.evaluate((el) => window.getComputedStyle(el).borderTopWidth);
        console.log("Generation bar border-top-width:", borderTop);

        const creditCost = promptPanel.locator('[data-canvas-credit-cost]');
        const creditCount = await creditCost.count();
        console.log("Credit cost elements found:", creditCount);

        const modelPicker = promptPanel.locator('.canvas-composer-model-picker');
        const modelText = promptPanel.locator('.canvas-model-picker-text');
        const modelTextVisible = await modelText.isVisible().catch(() => false);
        const modelTextContent = (await modelText.textContent().catch(() => ""))?.trim();
        console.log("Model picker text visible:", modelTextVisible, "Text:", modelTextContent);

        const screenshotPath = path.resolve(process.cwd(), "public/screenshots/canvas-prompt-panel-verified.png");
        await promptPanel.screenshot({ path: screenshotPath });
        console.log("Saved prompt panel screenshot to:", screenshotPath);
    } else {
        const screenshotPath = path.resolve(process.cwd(), "public/screenshots/canvas-page-current.png");
        await page.screenshot({ path: screenshotPath, fullPage: true });
        console.log("Saved canvas page screenshot to:", screenshotPath);
    }

    await browser.close();
}

run().catch((err) => {
    console.error("Verification failed:", err);
    process.exit(1);
});
