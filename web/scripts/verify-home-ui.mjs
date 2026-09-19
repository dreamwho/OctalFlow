import { chromium } from "@playwright/test";

async function main() {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();

    console.log("Navigating to http://127.0.0.1:3333/...");
    await page.goto("http://127.0.0.1:3333/", { waitUntil: "networkidle" });

    // 1. Check prompt card existence
    const card = page.locator('[data-testid="home-agent-card"]');
    await card.waitFor({ state: "visible", timeout: 10000 });
    console.log("Found home-agent-card!");

    // 2. Check left reference asset box
    const plusBox = card.locator('text=添加素材');
    const plusBoxVisible = await plusBox.isVisible();
    console.log("Reference Asset Box visible:", plusBoxVisible);

    // 3. Check mode toggle buttons in leftControls
    const imgModeBtn = card.locator('button:has-text("图片")');
    const videoModeBtn = card.locator('button:has-text("视频")');
    console.log("Mode buttons visible:", await imgModeBtn.isVisible(), await videoModeBtn.isVisible());

    // 4. Check unified preferences trigger
    const prefTrigger = card.locator('button:has-text("高画质")');
    console.log("Preferences trigger visible:", await prefTrigger.isVisible());

    // 5. Check placeholder hint
    const textarea = card.locator('textarea#home-agent-prompt');
    console.log("Textarea visible:", await textarea.isVisible());

    // Take screenshot of prompt card
    await card.screenshot({ path: "/tmp/home-agent-card.png" });
    console.log("Screenshot saved to /tmp/home-agent-card.png");

    // Click on video mode and take screenshot
    await videoModeBtn.click();
    await page.waitForTimeout(500);
    const videoPrefTrigger = card.locator('button:has-text("5s")');
    console.log("Video preferences trigger visible after toggle:", await videoPrefTrigger.isVisible());
    await card.screenshot({ path: "/tmp/home-agent-card-video.png" });
    console.log("Screenshot saved to /tmp/home-agent-card-video.png");

    await browser.close();
    console.log("All UI checks completed successfully!");
}

main().catch((err) => {
    console.error("Verification failed:", err);
    process.exit(1);
});
