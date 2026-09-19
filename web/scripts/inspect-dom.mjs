import { chromium } from '@playwright/test';

async function inspect() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto('http://localhost:3333/', { waitUntil: 'networkidle' });

  // Get all textareas or inputs
  const textareas = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('textarea')).map((el) => ({
      tagName: el.tagName,
      className: el.className,
      placeholder: el.placeholder,
      parentClassName: el.parentElement?.className,
      grandParentClassName: el.parentElement?.parentElement?.className,
    }));
  });

  // Check buttons
  const buttons = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('button')).map((el) => ({
      text: el.innerText.trim(),
      ariaLabel: el.getAttribute('aria-label'),
      className: el.className,
    }));
  });

  // Check search bar
  const search = await page.evaluate(() => {
    const el = document.querySelector('a[aria-label="搜索作品"], [class*="search"], [class*="Search"]');
    return el ? {
      outerHTML: el.outerHTML,
      className: el.className,
      box: el.getBoundingClientRect(),
    } : null;
  });

  console.log('DOM_INSPECT:', JSON.stringify({ textareas, buttons: buttons.slice(0, 15), search }, null, 2));

  await browser.close();
}

inspect().catch(console.error);
