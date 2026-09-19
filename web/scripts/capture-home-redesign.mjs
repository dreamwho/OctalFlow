import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

async function main() {
  const outputDir = '/Users/dream/Desktop/Vibe Coding/PythonProject/Octal-Canvas/web/.regress-data';
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const browser = await chromium.launch({
    headless: true,
  });

  try {
    // 1. Desktop 1440x900
    console.log('Testing Desktop 1440x900...');
    const desktopContext = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
    });
    const desktopPage = await desktopContext.newPage();
    await desktopPage.goto('http://localhost:3333/', { waitUntil: 'networkidle' });
    await desktopPage.waitForTimeout(2000);

    const desktopScreenshotPath = path.join(outputDir, 'home-redesign-desktop.png');
    await desktopPage.screenshot({ path: desktopScreenshotPath, fullPage: false });
    console.log(`Desktop screenshot saved to ${desktopScreenshotPath}`);

    // Measure elements on Desktop
    const desktopMetrics = await desktopPage.evaluate(() => {
      // Find prompt container
      const textarea = document.querySelector('textarea');
      const composer = textarea ? textarea.closest('div[class*="composer"]') : null;
      const toolbar = composer ? composer.querySelector('div[class*="composerToolbar"]') : null;
      const leftControls = composer ? composer.querySelector('div[class*="leftControls"]') : null;
      const rightControls = composer ? composer.querySelector('div[class*="rightControls"]') : null;
      const submitBtn = composer ? composer.querySelector('button.octal-button--primary, button[aria-label="立即生成"]') : null;

      // Extract details for all tool controls in leftControls
      const toolButtons = leftControls ? Array.from(leftControls.querySelectorAll('button')).map(btn => {
        const rect = btn.getBoundingClientRect();
        return {
          text: btn.innerText.trim().replace(/\s+/g, ' '),
          width: rect.width,
          height: rect.height,
          left: rect.left,
          top: rect.top,
          className: btn.className,
        };
      }) : [];

      const composerRect = composer ? composer.getBoundingClientRect() : null;
      const toolbarRect = toolbar ? toolbar.getBoundingClientRect() : null;
      const leftRect = leftControls ? leftControls.getBoundingClientRect() : null;
      const rightRect = rightControls ? rightControls.getBoundingClientRect() : null;
      const submitRect = submitBtn ? submitBtn.getBoundingClientRect() : null;

      return {
        composerRect,
        toolbarRect,
        leftRect,
        rightRect,
        submitRect,
        toolButtons,
      };
    });

    console.log('Desktop Metrics:', JSON.stringify(desktopMetrics, null, 2));

    await desktopContext.close();

    // 2. Mobile 390x844
    console.log('Testing Mobile 390x844...');
    const mobileContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
    });
    const mobilePage = await mobileContext.newPage();
    await mobilePage.goto('http://localhost:3333/', { waitUntil: 'networkidle' });
    await mobilePage.waitForTimeout(2000);

    const mobileScreenshotPath = path.join(outputDir, 'home-redesign-mobile.png');
    await mobilePage.screenshot({ path: mobileScreenshotPath, fullPage: false });
    console.log(`Mobile screenshot saved to ${mobileScreenshotPath}`);

    // Measure elements on Mobile
    const mobileMetrics = await mobilePage.evaluate(() => {
      const textarea = document.querySelector('textarea');
      const composer = textarea ? textarea.closest('div[class*="composer"]') : null;
      const toolbar = composer ? composer.querySelector('div[class*="composerToolbar"]') : null;
      const leftControls = composer ? composer.querySelector('div[class*="leftControls"]') : null;
      const rightControls = composer ? composer.querySelector('div[class*="rightControls"]') : null;
      const submitBtn = composer ? composer.querySelector('button.octal-button--primary, button[aria-label="立即生成"]') : null;

      const toolButtons = leftControls ? Array.from(leftControls.querySelectorAll('button')).map(btn => {
        const rect = btn.getBoundingClientRect();
        return {
          text: btn.innerText.trim().replace(/\s+/g, ' '),
          width: rect.width,
          height: rect.height,
          left: rect.left,
          top: rect.top,
          className: btn.className,
        };
      }) : [];

      const composerRect = composer ? composer.getBoundingClientRect() : null;
      const toolbarRect = toolbar ? toolbar.getBoundingClientRect() : null;
      const leftRect = leftControls ? leftControls.getBoundingClientRect() : null;
      const rightRect = rightControls ? rightControls.getBoundingClientRect() : null;
      const submitRect = submitBtn ? submitBtn.getBoundingClientRect() : null;

      return {
        composerRect,
        toolbarRect,
        leftRect,
        rightRect,
        submitRect,
        toolButtons,
      };
    });

    console.log('Mobile Metrics:', JSON.stringify(mobileMetrics, null, 2));

    await mobileContext.close();

    // Write inspection metrics report JSON
    fs.writeFileSync(path.join(outputDir, 'metrics-inspection.json'), JSON.stringify({
      desktop: desktopMetrics,
      mobile: mobileMetrics,
    }, null, 2));

  } finally {
    await browser.close();
  }
}

main().catch(err => {
  console.error('Execution error:', err);
  process.exit(1);
});
