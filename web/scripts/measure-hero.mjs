import { chromium } from "@playwright/test";

async function measure() {
    const browser = await chromium.launch({
        headless: true,
    });

    const viewports = [
        { name: "Desktop 1440x900", width: 1440, height: 900 },
        { name: "Desktop 1920x1080", width: 1920, height: 1080 },
    ];

    for (const vp of viewports) {
        console.log(`\n================================================================`);
        console.log(`MEASURING VIEWPORT: ${vp.name} (${vp.width} x ${vp.height})`);
        console.log(`================================================================\n`);

        const context = await browser.newContext({
            viewport: { width: vp.width, height: vp.height },
            deviceScaleFactor: 1,
        });
        const page = await context.newPage();

        try {
            await page.goto("http://localhost:3333/", {
                waitUntil: "networkidle",
                timeout: 30000,
            });
        } catch (err) {
            console.warn("Navigation warning:", err.message);
        }

        // Wait for composer or hero
        await page.waitForSelector('[data-testid="home-agent-card"], textarea, section', { timeout: 10000 }).catch(() => {});
        // Give React a moment to settle
        await page.waitForTimeout(1000);

        const data = await page.evaluate(() => {
            function getElementMetrics(el, label = "") {
                if (!el) return null;
                const rect = el.getBoundingClientRect();
                const cs = window.getComputedStyle(el);
                return {
                    label,
                    tagName: el.tagName.toLowerCase(),
                    className: (el.className && typeof el.className === "string") ? el.className.split(" ")[0] : "",
                    text: (el.innerText || el.textContent || "").trim().slice(0, 50),
                    rect: {
                        x: Math.round(rect.x * 100) / 100,
                        y: Math.round(rect.y * 100) / 100,
                        width: Math.round(rect.width * 100) / 100,
                        height: Math.round(rect.height * 100) / 100,
                        top: Math.round(rect.top * 100) / 100,
                        right: Math.round(rect.right * 100) / 100,
                        bottom: Math.round(rect.bottom * 100) / 100,
                        left: Math.round(rect.left * 100) / 100,
                    },
                    boxSizing: cs.boxSizing,
                    width: cs.width,
                    height: cs.height,
                    minWidth: cs.minWidth,
                    minHeight: cs.minHeight,
                    maxWidth: cs.maxWidth,
                    maxHeight: cs.maxHeight,
                    fontSize: cs.fontSize,
                    fontWeight: cs.fontWeight,
                    lineHeight: cs.lineHeight,
                    padding: `${cs.paddingTop} ${cs.paddingRight} ${cs.paddingBottom} ${cs.paddingLeft}`,
                    paddingTop: cs.paddingTop,
                    paddingRight: cs.paddingRight,
                    paddingBottom: cs.paddingBottom,
                    paddingLeft: cs.paddingLeft,
                    margin: `${cs.marginTop} ${cs.marginRight} ${cs.marginBottom} ${cs.marginLeft}`,
                    border: `${cs.borderTopWidth} ${cs.borderStyle} ${cs.borderColor}`,
                    borderRadius: cs.borderRadius,
                    display: cs.display,
                    flexDirection: cs.flexDirection,
                    justifyContent: cs.justifyContent,
                    alignItems: cs.alignItems,
                    gap: cs.gap,
                };
            }

            // 1. 提示词卡片 (data-testid="home-agent-card" 或包含 textarea 的卡片)
            let card = document.querySelector('[data-testid="home-agent-card"]');
            if (!card) {
                const ta = document.querySelector("textarea");
                if (ta) {
                    card = ta.closest('[class*="composer"]') || ta.parentElement?.parentElement;
                }
            }

            // 2. 左侧工具栏按钮（比例、时长、Skill、模型、素材）
            const addMediaBtn = document.querySelector('[data-testid="home-agent-add-media"]');
            const aspectRatioBtn = document.querySelector('[data-testid="home-agent-aspect-ratio"]');
            const durationBtn = document.querySelector('[data-testid="home-agent-duration"]');
            const skillBtn = document.querySelector('[data-testid="home-agent-skill-trigger"]');
            const modelBtn = document.querySelector('[data-testid="home-agent-model-trigger"]');
            const optimizeBtn = document.querySelector('[data-testid="home-agent-optimize-prompt"]');

            // Collect all buttons inside toolbar for complete picture
            const toolbarContainer = card ? card.querySelector('[class*="Toolbar"], [class*="composerTools"], [class*="toolsCluster"]') : null;
            const allToolbarButtons = toolbarContainer ? Array.from(toolbarContainer.querySelectorAll("button")).map(b => {
                return getElementMetrics(b, b.getAttribute("data-testid") || b.title || b.textContent.trim());
            }) : [];

            // 3. textarea 的高度与字号
            const textarea = document.querySelector('[data-testid="home-agent-textarea"]') || document.querySelector("textarea");
            let textareaDetails = null;
            if (textarea) {
                const taCs = window.getComputedStyle(textarea);
                const rect = textarea.getBoundingClientRect();
                textareaDetails = {
                    ...getElementMetrics(textarea, "textarea"),
                    scrollHeight: textarea.scrollHeight,
                    clientHeight: textarea.clientHeight,
                    offsetHeight: textarea.offsetHeight,
                    rows: textarea.rows,
                    placeholder: textarea.placeholder,
                };
            }

            // 4. 右侧“立即生成”按钮的宽高与字号
            const submitBtn = document.querySelector('[data-testid="home-agent-submit"]') || 
                              (card ? card.querySelector('button[type="submit"]') : null);

            // 5. Hero section 以及页面整体的高度分布
            const hero = document.querySelector('section[class*="hero"]') || document.querySelector('[data-design-board-hero]') || document.querySelector('section');
            const heroContent = hero ? hero.querySelector('[class*="heroContent"]') : null;
            const heroIntroGrid = hero ? hero.querySelector('[class*="heroIntroGrid"]') : null;
            const heroTitle = hero ? hero.querySelector('[class*="heroTitle"]') : null;
            const heroSubtitle = hero ? hero.querySelector('[class*="heroSubtitle"]') : null;
            const composerWrap = hero ? hero.querySelector('[class*="composerWrap"]') : null;
            const shortcutRow = hero ? hero.querySelector('[class*="shortcutRow"]') : null;
            const heroHighlights = hero ? hero.querySelector('[class*="heroHighlights"]') : null;

            // Header/Nav
            const header = document.querySelector("header");

            // Sections following hero
            const allSections = Array.from(document.querySelectorAll("main > *, body > div > *")).map(el => {
                const r = el.getBoundingClientRect();
                return {
                    tagName: el.tagName.toLowerCase(),
                    id: el.id,
                    className: (el.className && typeof el.className === "string") ? el.className.split(" ")[0] : "",
                    rect: {
                        top: Math.round(r.top),
                        bottom: Math.round(r.bottom),
                        height: Math.round(r.height),
                    },
                    minHeight: window.getComputedStyle(el).minHeight,
                    display: window.getComputedStyle(el).display,
                };
            }).filter(s => s.rect.height > 0);

            // Document metrics
            const docMetrics = {
                windowInnerWidth: window.innerWidth,
                windowInnerHeight: window.innerHeight,
                documentScrollHeight: document.documentElement.scrollHeight,
                documentClientHeight: document.documentElement.clientHeight,
                documentOffsetHeight: document.documentElement.offsetHeight,
                bodyScrollHeight: document.body.scrollHeight,
                bodyClientHeight: document.body.clientHeight,
            };

            return {
                docMetrics,
                hero: getElementMetrics(hero, "Hero Section"),
                heroContent: getElementMetrics(heroContent, "Hero Content"),
                heroIntroGrid: getElementMetrics(heroIntroGrid, "Hero Intro Grid"),
                heroTitle: getElementMetrics(heroTitle, "Hero Title"),
                heroSubtitle: getElementMetrics(heroSubtitle, "Hero Subtitle"),
                composerWrap: getElementMetrics(composerWrap, "Composer Wrap"),
                card: getElementMetrics(card, "Prompt Card (Composer)"),
                buttons: {
                    addMedia: getElementMetrics(addMediaBtn, "素材 (Add Media)"),
                    aspectRatio: getElementMetrics(aspectRatioBtn, "比例 (Aspect Ratio)"),
                    duration: getElementMetrics(durationBtn, "时长 (Duration)"),
                    skill: getElementMetrics(skillBtn, "Skill (技能)"),
                    model: getElementMetrics(modelBtn, "模型 (Model)"),
                    optimize: getElementMetrics(optimizeBtn, "优化提示词 (Optimize)"),
                },
                allToolbarButtons,
                textarea: textareaDetails,
                submitBtn: getElementMetrics(submitBtn, "立即生成 Button"),
                shortcutRow: getElementMetrics(shortcutRow, "Shortcut Row (快捷方式卡片)"),
                heroHighlights: getElementMetrics(heroHighlights, "Hero Highlights"),
                header: getElementMetrics(header, "Header"),
                allSections,
            };
        });

        console.log("=== 1. 提示词卡片 (data-testid='home-agent-card' 或包含 textarea 的卡片) ===");
        console.log(JSON.stringify(data.card, null, 2));

        console.log("\n=== 2. 左侧工具栏按钮（比例、时长、Skill、模型、素材） ===");
        for (const [key, btn] of Object.entries(data.buttons)) {
            console.log(`\n--- [${key}] ${btn ? btn.label : "NOT FOUND"} ---`);
            if (btn) {
                console.log(`  Rendered Size (rect): ${btn.rect.width}px × ${btn.rect.height}px`);
                console.log(`  BoundingClientRect: left=${btn.rect.left}, top=${btn.rect.top}, width=${btn.rect.width}, height=${btn.rect.height}`);
                console.log(`  Computed width/height: ${btn.width} × ${btn.height}, minHeight: ${btn.minHeight}`);
                console.log(`  Font Size: ${btn.fontSize}, Weight: ${btn.fontWeight}, LineHeight: ${btn.lineHeight}`);
                console.log(`  Padding: ${btn.padding}`);
                console.log(`  Border: ${btn.border}, Radius: ${btn.borderRadius}`);
                console.log(`  Display: ${btn.display}, Gap: ${btn.gap}`);
            }
        }

        console.log("\n=== 3. textarea 的高度与字号 ===");
        if (data.textarea) {
            console.log(`  Rendered Size (rect): ${data.textarea.rect.width}px × ${data.textarea.rect.height}px`);
            console.log(`  BoundingClientRect: left=${data.textarea.rect.left}, top=${data.textarea.rect.top}, width=${data.textarea.rect.width}, height=${data.textarea.rect.height}`);
            console.log(`  Computed height: ${data.textarea.height}, minHeight: ${data.textarea.minHeight}, maxHeight: ${data.textarea.maxHeight}`);
            console.log(`  Scroll/Client/Offset Height: scrollHeight=${data.textarea.scrollHeight}px, clientHeight=${data.textarea.clientHeight}px, offsetHeight=${data.textarea.offsetHeight}px`);
            console.log(`  Font Size: ${data.textarea.fontSize}, Weight: ${data.textarea.fontWeight}, LineHeight: ${data.textarea.lineHeight}`);
            console.log(`  Padding: ${data.textarea.padding}`);
        } else {
            console.log("  Textarea not found!");
        }

        console.log("\n=== 4. 右侧“立即生成”按钮的宽高与字号 ===");
        if (data.submitBtn) {
            console.log(`  Rendered Size (rect): ${data.submitBtn.rect.width}px × ${data.submitBtn.rect.height}px`);
            console.log(`  BoundingClientRect: left=${data.submitBtn.rect.left}, top=${data.submitBtn.rect.top}, width=${data.submitBtn.rect.width}, height=${data.submitBtn.rect.height}`);
            console.log(`  Computed width/height: ${data.submitBtn.width} × ${data.submitBtn.height}, minHeight: ${data.submitBtn.minHeight}`);
            console.log(`  Font Size: ${data.submitBtn.fontSize}, Weight: ${data.submitBtn.fontWeight}, LineHeight: ${data.submitBtn.lineHeight}`);
            console.log(`  Padding: ${data.submitBtn.padding}`);
            console.log(`  Border Radius: ${data.submitBtn.borderRadius}`);
        } else {
            console.log("  Submit button not found!");
        }

        console.log("\n=== 5. Hero section 以及页面整体的高度分布 ===");
        console.log(`  Viewport: ${data.docMetrics.windowInnerWidth}px × ${data.docMetrics.windowInnerHeight}px`);
        console.log(`  Document ScrollHeight: ${data.docMetrics.documentScrollHeight}px`);
        if (data.hero) {
            console.log(`  Hero rect: top=${data.hero.rect.top}px, bottom=${data.hero.rect.bottom}px, height=${data.hero.rect.height}px, width=${data.hero.rect.width}px`);
            console.log(`  Hero padding: ${data.hero.padding}, minHeight: ${data.hero.minHeight}`);
        }
        if (data.header) {
            console.log(`  Header rect: top=${data.header.rect.top}px, bottom=${data.header.rect.bottom}px, height=${data.header.rect.height}px`);
        }
        if (data.heroTitle) {
            console.log(`  Hero Title: height=${data.heroTitle.rect.height}px, top=${data.heroTitle.rect.top}px, bottom=${data.heroTitle.rect.bottom}px, font=${data.heroTitle.fontSize}`);
        }
        if (data.composerWrap) {
            console.log(`  Composer Wrap: top=${data.composerWrap.rect.top}px, bottom=${data.composerWrap.rect.bottom}px, height=${data.composerWrap.rect.height}px, width=${data.composerWrap.rect.width}px`);
        }
        if (data.shortcutRow) {
            console.log(`  Shortcut Row: top=${data.shortcutRow.rect.top}px, bottom=${data.shortcutRow.rect.bottom}px, height=${data.shortcutRow.rect.height}px, width=${data.shortcutRow.rect.width}px`);
        }
        if (data.heroHighlights) {
            console.log(`  Hero Highlights: top=${data.heroHighlights.rect.top}px, bottom=${data.heroHighlights.rect.bottom}px, height=${data.heroHighlights.rect.height}px, width=${data.heroHighlights.rect.width}px`);
        }

        console.log("\n  All Main Sections on page:");
        for (const s of data.allSections) {
            console.log(`    <${s.tagName} class="${s.className}" id="${s.id}">: top=${s.rect.top}px, bottom=${s.rect.bottom}px, height=${s.rect.height}px, minHeight=${s.minHeight}`);
        }

        // Take a full page screenshot to verify visually
        const screenshotPath = `/tmp/homepage-measure-${vp.width}x${vp.height}.png`;
        await page.screenshot({ path: screenshotPath, fullPage: false });
        console.log(`  Screenshot (viewport): ${screenshotPath}`);

        await context.close();
    }

    await browser.close();
}

measure().catch(err => {
    console.error("Error during measurement:", err);
    process.exit(1);
});
