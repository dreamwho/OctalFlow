import { expect, test } from "@playwright/test";

test("Nano Banana 2.1 can be selected and saved in the GeminiAI image catalog on desktop and mobile", async ({ page, request }, testInfo) => {
    const model = "gemini-nano-banana-2.1";
    let synchronized = false;
    let saved = false;
    await page.route("**/api/admin/geminiai", (route) =>
        route.fulfill({
            json: {
                code: 0,
                msg: "OK",
                data: {
                    configured: true,
                    healthy: true,
                    accounts: [],
                    accountsAvailable: true,
                    models: synchronized ? [{ id: model, name: model, capabilities: ["image"], source: "geminiai", enabled: saved }] : [],
                    channels: saved ? [{ id: "geminiai", name: "Gemini AI Studio", models: [model], modelCount: 1 }] : [],
                },
            },
        }),
    );
    await page.route("**/api/admin/geminiai/models/sync", (route) => {
        synchronized = true;
        return route.fulfill({ json: { code: 0, data: [], msg: "OK" } });
    });
    await page.route("**/api/admin/geminiai/models", (route) => {
        expect(route.request().method()).toBe("PUT");
        expect(route.request().postDataJSON()).toEqual({ models: [model] });
        saved = true;
        return route.fulfill({ json: { code: 0, data: [], msg: "OK" } });
    });

    for (const [width, theme] of [[1440, "light"], [390, "light"], [430, "light"], [1440, "dark"], [390, "dark"], [430, "dark"]] as const) {
        synchronized = false;
        saved = false;
        await page.setViewportSize({ width, height: 940 });
        const currentSettings = await (await request.get("/api/admin/settings")).json();
        const changed = await request.patch("/api/admin/settings", { data: { site: { ...currentSettings.settings.site, adminTheme: theme } } });
        expect(changed.ok()).toBe(true);
        await page.goto("/admin?section=geminiai");
        if (theme === "dark") await expect(page.locator("html")).toHaveClass(/dark/);
        else await expect(page.locator("html")).not.toHaveClass(/dark/);
        await page.getByRole("button", { name: "获取账号模型", exact: true }).click();
        const selection = page.getByRole("checkbox", { name: `选择 ${model} 保存到 Gemini AI Studio 渠道` });
        await expect(selection).toBeVisible();
        await expect(page.getByText("图片", { exact: true })).toBeVisible();
        await selection.check();
        await page.getByRole("button", { name: "保存所选模型", exact: true }).click();
        await expect(page.getByRole("button", { name: /保存所选模型/ })).toBeDisabled();
        await expect(selection).toBeChecked();
        await page.reload();
        await expect(selection).toBeChecked();
        await expect(page.getByText("已保存", { exact: true })).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        await selection.scrollIntoViewIfNeeded();
        await page.screenshot({ path: testInfo.outputPath(`nano-banana-21-${theme}-${width}.png`) });
    }
});

test("account discovery and manual models persist, save and test through the native TCP fixture", async ({ page, request }, testInfo) => {
    const fixture = `http://127.0.0.1:${process.env.DREAMYO_PROTOCOL_FIXTURE_PORT}`;
    const generationRequests = async () => {
        const state = await (await request.get(`${fixture}/__state`)).json();
        return state.requests.filter((row: { path: string }) => /images\/generations|chat\/completions/.test(row.path)).length;
    };
    for (const [width, theme] of [[1440, "light"], [390, "light"], [430, "light"], [1440, "dark"], [390, "dark"], [430, "dark"]] as const) {
        const id = `gemini-manual-render-${width}-${theme}`;
        await page.setViewportSize({ width, height: 940 });
        const settings = await (await request.get("/api/admin/settings")).json();
        expect((await request.patch("/api/admin/settings", { data: { site: { ...settings.settings.site, adminTheme: theme } } })).ok()).toBe(true);
        await page.goto("/admin?section=geminiai");
        const initialRequests = await generationRequests();
        await page.getByRole("button", { name: "获取账号模型", exact: true }).click();
        await expect(page.getByRole("button", { name: "测试模型 gemini-account-render", exact: true })).toBeVisible();
        await page.getByRole("button", { name: "手动添加模型", exact: true }).click();
        const add = page.getByRole("dialog", { name: "手动添加模型", exact: true });
        await add.getByLabel("模型 ID", { exact: true }).fill(id);
        await add.getByLabel("显示名称（可选）").fill(`手动图片 ${width} ${theme}`);
        const bounds = await add.boundingBox();
        expect(bounds!.width).toBeLessThanOrEqual(width - 24);
        await add.getByRole("button", { name: /取\s*消/ }).click();
        await page.getByRole("button", { name: "手动添加模型", exact: true }).click();
        await expect(add.getByLabel("模型 ID", { exact: true })).toHaveValue("");
        await add.getByLabel("模型 ID", { exact: true }).fill(id);
        await add.getByLabel("显示名称（可选）").fill(`手动图片 ${width} ${theme}`);
        await add.getByRole("button", { name: "添加到目录", exact: true }).click();
        await expect(add).not.toBeVisible();
        const testButton = page.getByRole("button", { name: `测试模型 ${id}`, exact: true });
        await expect(testButton).toBeVisible();
        await page.reload();
        await expect(testButton).toBeVisible();
        expect(await generationRequests()).toBe(initialRequests);
        await testButton.click();
        const testDialog = page.getByRole("dialog", { name: "GeminiAIStudio 模型实测", exact: true });
        await expect(testDialog.getByRole("tab", { name: "图片", exact: true })).toHaveAttribute("aria-selected", "true");
        await expect(testDialog.getByText(`手动图片 ${width} ${theme}`, { exact: true })).toBeVisible();
        expect(await generationRequests()).toBe(initialRequests);
        await testDialog.getByRole("button", { name: "开始实测", exact: true }).click();
        await expect(testDialog.getByText(`实际模型：${id}`, { exact: true })).toBeVisible();
        const image = testDialog.getByAltText("GeminiAIStudio 本次生成图片 1");
        await expect(image).toBeVisible();
        await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBeGreaterThan(0);
        expect(await generationRequests()).toBe(initialRequests + 1);
        expect(await testDialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
        await image.scrollIntoViewIfNeeded();
        await expect.poll(() => testDialog.evaluate(el => el.getAnimations({ subtree: true }).some(animation => animation.playState === "running"))).toBe(false);
        await page.screenshot({ path: testInfo.outputPath(`manual-model-test-${theme}-${width}.png`) });
        await testDialog.getByRole("button", { name: /关\s*闭/ }).click();
        const selection = page.getByRole("checkbox", { name: `选择 手动图片 ${width} ${theme} 保存到 Gemini AI Studio 渠道`, exact: true });
        await selection.check();
        await page.getByRole("button", { name: "保存所选模型", exact: true }).click();
        await expect(page.getByRole("button", { name: /保存所选模型/ })).toBeDisabled();
        await page.reload();
        await expect(selection).toBeChecked();
        const saved = await (await request.get("/api/admin/settings")).json();
        const channel = saved.settings.systemChannels.find((row: { id: string }) => row.id === "geminiai");
        expect(channel.models).toContain(id);
        expect(channel.advancedConfig.modelCapabilities[id]).toBe("image");
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
});

test("manual text IDs reject duplicates and remain usable after account discovery fails", async ({ page, request }) => {
    const id = "gemini-manual-text";
    await page.setViewportSize({ width: 390, height: 940 });
    await page.goto("/admin?section=geminiai");
    const add = page.getByRole("dialog", { name: "手动添加模型", exact: true });
    await page.getByRole("button", { name: "手动添加模型", exact: true }).click();
    await add.getByText("文本对话", { exact: true }).click();
    await expect(add.getByRole("radio", { name: "文本对话", exact: true })).toBeChecked();
    await add.getByLabel("模型 ID", { exact: true }).fill(`models/${id}`);
    await add.getByRole("button", { name: "添加到目录", exact: true }).click();
    await expect(add).not.toBeVisible();
    const testButton = page.getByRole("button", { name: `测试模型 ${id}`, exact: true });
    await expect(testButton).toBeVisible();
    await page.getByRole("button", { name: "手动添加模型", exact: true }).click();
    await add.getByLabel("模型 ID", { exact: true }).fill(id);
    await add.getByRole("button", { name: "添加到目录", exact: true }).click();
    await expect(page.getByText("模型已存在，请在目录中选择或测试该模型", { exact: true })).toBeVisible();
    await expect(add).toBeVisible();
    await add.getByRole("button", { name: /取\s*消/ }).click();
    await page.route("**/api/admin/geminiai/models/sync", route => route.fulfill({ status: 502, json: { code: 502, data: null, msg: "当前 Google 授权已失效，请重新授权后获取模型目录" } }));
    await page.getByRole("button", { name: "获取账号模型", exact: true }).click();
    await expect(page.getByText("当前 Google 授权已失效，请重新授权后获取模型目录", { exact: true })).toBeVisible();
    await page.reload();
    await expect(testButton).toBeVisible();
    await testButton.click();
    const dialog = page.getByRole("dialog", { name: "GeminiAIStudio 模型实测", exact: true });
    await expect(dialog.getByRole("tab", { name: "文本", exact: true })).toHaveAttribute("aria-selected", "true");
    await dialog.getByRole("button", { name: "开始实测", exact: true }).click();
    await expect(dialog.getByText("协议测试文本返回成功", { exact: true })).toBeVisible();
    await expect(dialog.getByText(`实际模型：${id}`, { exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: /关\s*闭/ }).click();
    const selection = page.getByRole("checkbox", { name: `选择 ${id} 保存到 Gemini AI Studio 渠道`, exact: true });
    await selection.check();
    await page.getByRole("button", { name: "保存所选模型", exact: true }).click();
    await expect(page.getByRole("button", { name: /保存所选模型/ })).toBeDisabled();
    await page.reload();
    await expect(selection).toBeChecked();
    const settings = await (await request.get("/api/admin/settings")).json();
    const channel = settings.settings.systemChannels.find((row: { id: string }) => row.id === "geminiai");
    expect(channel.advancedConfig.modelCapabilities[id]).toBe("text");
});
