import { chromium } from '@playwright/test';
import fs from 'node:fs';

async function verify() {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();

  console.log('Navigating to http://localhost:3333/...');
  await page.goto('http://localhost:3333/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);

  // Take full page screenshot
  console.log('Capturing full page screenshot to /tmp/homepage_final_v2.png...');
  await page.screenshot({ path: '/tmp/homepage_final_v2.png', fullPage: true });

  // 1. Search bar verification
  const searchButton = page.locator('a[aria-label="搜索作品"], [class*="headerSearchButton"]').first();
  await searchButton.waitFor({ state: 'visible' });
  const searchBox = await searchButton.boundingBox();
  const searchStyles = await searchButton.evaluate((el) => {
    const computed = window.getComputedStyle(el);
    const span = el.querySelector('span');
    const spanComputed = span ? window.getComputedStyle(span) : null;
    return {
      width: el.offsetWidth,
      height: el.offsetHeight,
      minWidth: computed.minWidth,
      text: el.innerText,
      spanWidth: span?.offsetWidth,
      spanOverflow: spanComputed?.overflow,
      spanText: span?.innerText,
    };
  });

  // Check notification / login adjacent elements
  const searchOverlap = await searchButton.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const nextEl = el.nextElementSibling;
    const nextRect = nextEl ? nextEl.getBoundingClientRect() : null;
    return {
      searchRect: { left: rect.left, right: rect.right, width: rect.width },
      nextRect: nextRect ? { left: nextRect.left, right: nextRect.right } : null,
      overlapsWithNext: nextRect ? rect.right > nextRect.left : false,
      gapWithNext: nextRect ? nextRect.left - rect.right : null,
    };
  });

  // 2. Composer prompt card verification
  const composerCard = page.locator('[class*="composer"]').first();
  await composerCard.waitFor({ state: 'visible' });
  const composerCardBox = await composerCard.boundingBox();
  const composerComputed = await composerCard.evaluate((el) => {
    const computed = window.getComputedStyle(el);
    return {
      width: el.offsetWidth,
      height: el.offsetHeight,
      minHeight: computed.minHeight,
      maxWidth: computed.maxWidth,
      padding: computed.padding,
    };
  });

  // Also check textarea and surrounding card
  const promptWrap = page.locator('[class*="composerWrap"]').first();
  const promptWrapBox = (await promptWrap.count() > 0) ? await promptWrap.boundingBox() : null;

  // 3. Generate button verification
  const generateBtn = page.locator('button[aria-label="立即生成"]').first();
  await generateBtn.waitFor({ state: 'visible' });
  const generateBox = await generateBtn.boundingBox();
  const generateDetails = await generateBtn.evaluate((el) => {
    const computed = window.getComputedStyle(el);
    const textSpan = el.querySelector('span') || el;
    const textSpanRect = textSpan.getBoundingClientRect();
    const btnRect = el.getBoundingClientRect();
    return {
      width: btnRect.width,
      height: btnRect.height,
      padding: computed.padding,
      paddingLeft: computed.paddingLeft,
      paddingRight: computed.paddingRight,
      fontSize: computed.fontSize,
      text: el.innerText.trim(),
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      isTextOverflowingX: textSpanRect.right > btnRect.right || textSpanRect.left < btnRect.left,
      isTextOverflowingY: textSpanRect.bottom > btnRect.bottom || textSpanRect.top < btnRect.top,
      buttonRect: { width: btnRect.width, height: btnRect.height },
      textSpanRect: { width: textSpanRect.width, height: textSpanRect.height },
    };
  });

  // 4. Model picker verification
  const modelPickerBtn = page.locator('button.canvas-composer-model-picker, button[aria-label*="模型"]').first();
  let modelPickerInfo = { found: false };
  if (await modelPickerBtn.count() > 0) {
    const btnBox = await modelPickerBtn.boundingBox();
    const btnText = await modelPickerBtn.innerText();
    
    // Click to open dropdown/dialog
    await modelPickerBtn.click();
    await page.waitForTimeout(600);

    // Look for popover/dialog content
    const popover = page.locator('[role="dialog"], [class*="ant-popover"], [class*="modelPicker"]').first();
    const popoverVisible = await popover.isVisible().catch(() => false);
    
    // Look for categories, groups, tabs, or options in dropdown
    const groupTitles = await page.locator('[class*="groupTitle"], [class*="category"], [role="group"] label, .ant-popover-content [class*="title"], [class*="provider"]').allTextContents().catch(() => []);
    const options = await page.locator('[class*="modelOption"], [role="option"], [class*="modelItem"], .ant-popover-content button').allTextContents().catch(() => []);

    // Take screenshot of model picker open
    await page.screenshot({ path: '/tmp/homepage_model_picker.png' });

    modelPickerInfo = {
      found: true,
      triggerBox: btnBox,
      triggerText: btnText.trim(),
      popoverVisible,
      groupTitles,
      optionCount: options.length,
      sampleOptions: options.slice(0, 8).map(s => s.trim().replace(/\s+/g, ' ')),
    };
  }

  const results = {
    searchBar: {
      box: searchBox,
      styles: searchStyles,
      overlap: searchOverlap,
      passWidthGe200: searchBox.width >= 200,
      passNoOverlap: !searchOverlap.overlapsWithNext,
    },
    composer: {
      cardBox: composerCardBox,
      wrapBox: promptWrapBox,
      computed: composerComputed,
      passWidthGe1040: composerCardBox.width >= 1040,
      passHeightGe300: composerCardBox.height >= 300,
    },
    generateBtn: {
      box: generateBox,
      details: generateDetails,
      passPadding: parseFloat(generateDetails.paddingLeft) >= 20,
      passNoOverflow: !generateDetails.isTextOverflowingX && !generateDetails.isTextOverflowingY && generateDetails.scrollWidth <= generateDetails.clientWidth,
    },
    modelPicker: modelPickerInfo,
  };

  console.log('VERIFICATION_RESULTS_JSON:' + JSON.stringify(results, null, 2));

  await browser.close();
}

verify().catch((err) => {
  console.error('Verification failed:', err);
  process.exit(1);
});
