import { chromium } from '@playwright/test';

async function measure() {
  const browser = await chromium.launch({ headless: true });
  
  // Test viewports: standard 1440x900 (MacBook/laptop) and 1920x1080 (FHD desktop)
  const viewports = [
    { width: 1440, height: 900, name: '1440x900' },
    { width: 1920, height: 1080, name: '1920x1080' }
  ];

  for (const vp of viewports) {
    console.log(`\n======================================================`);
    console.log(`### Viewport: ${vp.name} (${vp.width}x${vp.height}) ###`);
    console.log(`======================================================\n`);

    const context = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();

    await page.goto('http://localhost:3333/', { waitUntil: 'networkidle' });
    await page.waitForTimeout(1000);

    const data = await page.evaluate(async () => {
      function getMetrics(el) {
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        const cs = window.getComputedStyle(el);
        return {
          tagName: el.tagName,
          id: el.id,
          className: el.className,
          rect: {
            x: Math.round(rect.x * 100) / 100,
            y: Math.round(rect.y * 100) / 100,
            top: Math.round(rect.top * 100) / 100,
            right: Math.round(rect.right * 100) / 100,
            bottom: Math.round(rect.bottom * 100) / 100,
            left: Math.round(rect.left * 100) / 100,
            width: Math.round(rect.width * 100) / 100,
            height: Math.round(rect.height * 100) / 100,
          },
          offsetWidth: el.offsetWidth,
          offsetHeight: el.offsetHeight,
          clientWidth: el.clientWidth,
          clientHeight: el.clientHeight,
          scrollWidth: el.scrollWidth,
          scrollHeight: el.scrollHeight,
          styles: {
            fontSize: cs.fontSize,
            fontWeight: cs.fontWeight,
            lineHeight: cs.lineHeight,
            padding: `${cs.paddingTop} ${cs.paddingRight} ${cs.paddingBottom} ${cs.paddingLeft}`,
            paddingTop: cs.paddingTop,
            paddingRight: cs.paddingRight,
            paddingBottom: cs.paddingBottom,
            paddingLeft: cs.paddingLeft,
            margin: `${cs.marginTop} ${cs.marginRight} ${cs.marginBottom} ${cs.marginLeft}`,
            border: `${cs.borderWidth} ${cs.borderStyle} ${cs.borderColor}`,
            borderRadius: cs.borderRadius,
            boxSizing: cs.boxSizing,
            minHeight: cs.minHeight,
            maxHeight: cs.maxHeight,
            minWidth: cs.minWidth,
            maxWidth: cs.maxWidth,
            display: cs.display,
            flexDirection: cs.flexDirection,
            justifyContent: cs.justifyContent,
            alignItems: cs.alignItems,
            gap: cs.gap,
            background: cs.background.slice(0, 80),
            color: cs.color,
          },
          text: el.innerText ? el.innerText.trim().slice(0, 100) : '',
        };
      }

      // 1. Prompt Card
      const cardEl = document.querySelector('[data-testid="home-agent-card"]') || 
                     document.querySelector('.home-agent-hero-module__4ddpXa__composer');
      const card = getMetrics(cardEl);

      // 2. Textarea
      const textareaEl = document.querySelector('#home-agent-prompt') || 
                         (cardEl ? cardEl.querySelector('textarea') : null);
      const textarea = getMetrics(textareaEl);

      // 3. Left toolbar buttons (image mode)
      const leftControls = cardEl ? cardEl.querySelector('.home-agent-hero-module__4ddpXa__leftControls') : null;
      const leftButtons = [];
      if (leftControls) {
        const btns = leftControls.querySelectorAll('button');
        btns.forEach((btn, idx) => {
          leftButtons.push({
            index: idx,
            metrics: getMetrics(btn),
          });
        });
      }

      // 4. Submit button
      const submitEl = document.querySelector('button[aria-label="立即生成"]') ||
                       document.querySelector('.octal-button--primary');
      const submit = getMetrics(submitEl);

      // 5. Page height & distribution
      const win = {
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        scrollX: window.scrollX,
        scrollY: window.scrollY,
      };

      const doc = {
        bodyScrollHeight: document.body.scrollHeight,
        bodyOffsetHeight: document.body.offsetHeight,
        bodyClientHeight: document.body.clientHeight,
        documentElementScrollHeight: document.documentElement.scrollHeight,
        documentElementClientHeight: document.documentElement.clientHeight,
      };

      // Header / Nav
      const headerEl = document.querySelector('header') || document.querySelector('nav');
      const header = getMetrics(headerEl);

      // Hero section
      const heroEl = document.querySelector('section');
      const hero = getMetrics(heroEl);

      // Elements inside Hero
      const heroElements = [];
      if (heroEl) {
        const children = heroEl.querySelectorAll('& > div, & > div > div');
        children.forEach((c) => {
          if (c.offsetHeight > 0) {
            heroElements.push({
              className: c.className.slice(0, 60),
              metrics: getMetrics(c),
            });
          }
        });
      }

      // Sections after Hero
      const sectionsAfterHero = [];
      let nextSib = heroEl ? heroEl.nextElementSibling : null;
      while (nextSib) {
        sectionsAfterHero.push({
          tagName: nextSib.tagName,
          className: nextSib.className ? nextSib.className.slice(0, 80) : '',
          metrics: getMetrics(nextSib),
        });
        nextSib = nextSib.nextElementSibling;
      }

      return {
        win,
        doc,
        header,
        hero,
        card,
        textarea,
        leftButtons,
        submit,
        heroElements,
        sectionsAfterHero,
      };
    });

    console.log('1. 提示词卡片 (data-testid="home-agent-card"):');
    console.log(JSON.stringify(data.card, null, 2));

    console.log('\n2. 左侧工具栏按钮（图片模式）:');
    data.leftButtons.forEach((b) => {
      console.log(`- 按钮 [${b.index}] text="${b.metrics.text.replace(/\n/g, ' ')}"`);
      console.log(`  width: ${b.metrics.rect.width}px, height: ${b.metrics.rect.height}px`);
      console.log(`  getBoundingClientRect: x=${b.metrics.rect.x}, y=${b.metrics.rect.y}, top=${b.metrics.rect.top}, bottom=${b.metrics.rect.bottom}`);
      console.log(`  fontSize: ${b.metrics.styles.fontSize}, fontWeight: ${b.metrics.styles.fontWeight}`);
      console.log(`  padding: ${b.metrics.styles.padding}`);
      console.log(`  display: ${b.metrics.styles.display}, gap: ${b.metrics.styles.gap}`);
    });

    // Now click "视频生成" tab to inspect video mode toolbar (especially "时长" button)
    console.log('\n--- 切换到“视频生成” Tab 测量时长按钮 ---');
    const videoTab = await page.locator('button:has-text("视频生成")').first();
    if (await videoTab.count() > 0) {
      await videoTab.click();
      await page.waitForTimeout(500);

      const videoData = await page.evaluate(() => {
        function getMetrics(el) {
          if (!el) return null;
          const rect = el.getBoundingClientRect();
          const cs = window.getComputedStyle(el);
          return {
            tagName: el.tagName,
            id: el.id,
            className: el.className,
            rect: {
              x: Math.round(rect.x * 100) / 100,
              y: Math.round(rect.y * 100) / 100,
              top: Math.round(rect.top * 100) / 100,
              right: Math.round(rect.right * 100) / 100,
              bottom: Math.round(rect.bottom * 100) / 100,
              left: Math.round(rect.left * 100) / 100,
              width: Math.round(rect.width * 100) / 100,
              height: Math.round(rect.height * 100) / 100,
            },
            styles: {
              fontSize: cs.fontSize,
              fontWeight: cs.fontWeight,
              lineHeight: cs.lineHeight,
              padding: `${cs.paddingTop} ${cs.paddingRight} ${cs.paddingBottom} ${cs.paddingLeft}`,
              paddingTop: cs.paddingTop,
              paddingRight: cs.paddingRight,
              paddingBottom: cs.paddingBottom,
              paddingLeft: cs.paddingLeft,
              margin: `${cs.marginTop} ${cs.marginRight} ${cs.marginBottom} ${cs.marginLeft}`,
              border: `${cs.borderWidth} ${cs.borderStyle} ${cs.borderColor}`,
              borderRadius: cs.borderRadius,
              boxSizing: cs.boxSizing,
              minHeight: cs.minHeight,
              minWidth: cs.minWidth,
              display: cs.display,
              gap: cs.gap,
            },
            text: el.innerText ? el.innerText.trim().slice(0, 100) : '',
          };
        }

        const cardEl = document.querySelector('[data-testid="home-agent-card"]') || 
                       document.querySelector('.home-agent-hero-module__4ddpXa__composer');
        const leftControls = cardEl ? cardEl.querySelector('.home-agent-hero-module__4ddpXa__leftControls') : null;
        const leftButtons = [];
        if (leftControls) {
          const btns = leftControls.querySelectorAll('button');
          btns.forEach((btn, idx) => {
            leftButtons.push({
              index: idx,
              metrics: getMetrics(btn),
            });
          });
        }
        return { leftButtons };
      });

      console.log('视频模式下的左侧工具栏按钮:');
      videoData.leftButtons.forEach((b) => {
        console.log(`- 按钮 [${b.index}] text="${b.metrics.text.replace(/\n/g, ' ')}"`);
        console.log(`  width: ${b.metrics.rect.width}px, height: ${b.metrics.rect.height}px`);
        console.log(`  getBoundingClientRect: x=${b.metrics.rect.x}, y=${b.metrics.rect.y}, top=${b.metrics.rect.top}, bottom=${b.metrics.rect.bottom}`);
        console.log(`  fontSize: ${b.metrics.styles.fontSize}, fontWeight: ${b.metrics.styles.fontWeight}`);
        console.log(`  padding: ${b.metrics.styles.padding}`);
      });
    }

    console.log('\n3. Textarea 的高度与字号:');
    console.log(JSON.stringify(data.textarea, null, 2));

    console.log('\n4. 右侧“立即生成”按钮的宽高与字号:');
    console.log(JSON.stringify(data.submit, null, 2));

    console.log('\n5. Hero section 以及页面整体的高度分布:');
    console.log(`Viewport: innerWidth=${data.win.innerWidth}, innerHeight=${data.win.innerHeight}`);
    console.log(`Document: scrollHeight=${data.doc.documentElementScrollHeight}, clientHeight=${data.doc.documentElementClientHeight}`);
    console.log(`Body: scrollHeight=${data.doc.bodyScrollHeight}, clientHeight=${data.doc.bodyClientHeight}`);
    console.log(`\nHeader:`);
    console.log(JSON.stringify(data.header ? { rect: data.header.rect, height: data.header.rect.height } : null, null, 2));
    console.log(`\nHero Section:`);
    console.log(JSON.stringify(data.hero ? {
      rect: data.hero.rect,
      minHeight: data.hero.styles.minHeight,
      padding: data.hero.styles.padding,
      margin: data.hero.styles.margin,
      display: data.hero.styles.display,
      offsetHeight: data.hero.offsetHeight,
      clientHeight: data.hero.clientHeight,
    } : null, null, 2));

    console.log(`\nCard position within Hero:`);
    if (data.card && data.hero) {
      console.log(`Hero top: ${data.hero.rect.top}, bottom: ${data.hero.rect.bottom}, height: ${data.hero.rect.height}`);
      console.log(`Card top: ${data.card.rect.top}, bottom: ${data.card.rect.bottom}, height: ${data.card.rect.height}`);
      console.log(`Hero bottom - Card bottom = ${data.hero.rect.bottom - data.card.rect.bottom}px`);
    }

    console.log(`\nSections after Hero:`);
    data.sectionsAfterHero.forEach((s, idx) => {
      console.log(`- Section [${idx}] <${s.tagName}> class="${s.className}"`);
      console.log(`  top: ${s.metrics.rect.top}, bottom: ${s.metrics.rect.bottom}, height: ${s.metrics.rect.height}`);
    });

    await context.close();
  }

  await browser.close();
}

measure().catch(console.error);
