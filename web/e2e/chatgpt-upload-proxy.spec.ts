import { expect, test } from "@playwright/test";

test("GPTAPI signed upload egress can be changed independently on desktop and mobile", async ({ page }) => {
    let mode = "auto";
    let magicNode = "";
    await page.route("**/api/admin/chatgpt-api/**", async (route) => {
        const path = new URL(route.request().url()).pathname.split("/chatgpt-api/")[1];
        const body = route.request().method() === "PATCH" ? route.request().postDataJSON() as { mode?: string; magicNode?: string } : {};
        let data: unknown = {};
        if (path === "upload-proxy") {
            if (body.mode) { mode = body.mode; magicNode = body.magicNode || ""; }
            data = { mode, magicNode, magicConfigured: true };
        } else if (path === "proxy-selection") data = { enabled: true, mode: "chained", native_source: "manual", magicConfigured: true, ipwoConfigured: false };
        else if (path === "accounts") data = { items: [], total: 0 };
        else if (path === "model-catalog") data = { chat_models: [], image_models: [], source: { chat: "config", image: "config" } };
        else if (path === "models") data = { models: [] };
        else if (path === "keys") data = { items: [] };
        else if (path === "gateway") data = { enabled: false };
        else if (path === "proxies") data = { groups: [], default_reference: { mode: "direct" }, fallback_reference: null };
        await route.fulfill({ json: { code: 0, data, msg: "" } });
    });
    await page.route("**/api/admin/magic-proxy", async (route) => {
        await route.fulfill({ json: { code: 0, data: {
            configured: true, runtimeAvailable: true, nodeCount: 1,
            nodes: [{ name: "Fixture 魔法节点", type: "ss" }, { name: "Fixture 上传节点", type: "ss" }], groups: [],
            bindings: { geminiai: { enabled: false }, geminiTools: { enabled: false }, chatgptApi: { enabled: true, node: "Fixture 魔法节点" } },
        }, msg: "" } });
    });

    await page.goto("/admin?section=chatgptApi", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("tab", { name: "代理管理", exact: true })).toBeVisible();
    await page.getByRole("tab", { name: "代理管理", exact: true }).click();
    await expect(page.getByRole("heading", { name: "图片数据上传出口" })).toBeVisible();
    const select = page.getByRole("combobox", { name: "图片数据上传代理模式" });
    const panel = page.getByRole("heading", { name: "图片数据上传出口" }).locator("xpath=ancestor::section[1]");
    await expect(panel.getByText("自动：魔法代理可用时使用魔法代理", { exact: true })).toBeVisible();
    await select.click();
    await page.getByText("跟随生成提交出口", { exact: true }).click();
    await page.getByRole("button", { name: "保存上传出口" }).click();
    await expect.poll(() => mode).toBe("submit");
    await expect(panel.getByText("跟随生成提交出口", { exact: true })).toBeVisible();
    await select.click();
    await page.getByText("自动：魔法代理可用时使用魔法代理", { exact: true }).last().click();
    await page.getByRole("combobox", { name: "图片上传魔法节点" }).click();
    await page.getByText("Fixture 上传节点", { exact: true }).last().click();
    await page.getByRole("button", { name: "保存上传出口" }).click();
    await expect.poll(() => magicNode).toBe("Fixture 上传节点");

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("tab", { name: "代理管理", exact: true }).click();
    await expect(panel.getByText("Fixture 上传节点", { exact: true })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    const bounds = await select.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return { left: rect.left, right: rect.right, width: rect.width };
    });
    expect(bounds.width).toBeGreaterThan(0);
    expect(bounds.left).toBeGreaterThanOrEqual(0);
    expect(bounds.right).toBeLessThanOrEqual(390);
});
