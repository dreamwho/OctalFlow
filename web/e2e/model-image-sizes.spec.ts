import { expect, test, type APIRequestContext } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { e2eSettingsPatch } from "./support";

type TestSettings = {
    logicalModels: Array<{ id: string; bindings?: Array<Record<string, unknown>>; [key: string]: unknown }>;
};

test("admin image sizes persist and drive workbench and Canvas choices", async ({ page, request }) => {
    const seeded = await request.patch("/api/admin/settings", { data: e2eSettingsPatch() });
    expect(seeded.ok(), await seeded.text()).toBe(true);
    let projectId: string | undefined;

    try {
        await page.goto("/admin?section=channels");
        await expect(page.locator('.admin-dashboard-shell[data-hydrated="true"]:visible')).toHaveCount(1);
        await page.getByRole("tab", { name: "逻辑模型", exact: true }).click();
        await page.getByRole("button", { name: "编辑 e2e-image", exact: true }).click();

        const sizesField = page.getByText("支持尺寸 / 比例", { exact: true }).locator("xpath=..").getByRole("textbox").first();
        await sizesField.fill("");
        await sizesField.pressSequentially("1024x1024,1536x1024,");
        await expect(sizesField).toHaveValue("1024x1024,1536x1024,");
        await sizesField.fill("");
        await sizesField.pressSequentially("1024x1024，1536x1024，1024x1024");
        await expect(sizesField).toHaveValue("1024x1024，1536x1024，1024x1024");

        const saved = page.waitForResponse((response) => response.request().method() === "PATCH" && new URL(response.url()).pathname === "/api/admin/settings");
        await page.getByRole("button", { name: "应用修改", exact: true }).click();
        expect((await saved).ok()).toBe(true);
        await expect.poll(async () => (await readSettings(request)).logicalModels.find((item) => item.id === "e2e-image")?.bindings?.[0]?.capabilityProfile).toMatchObject({ aspectRatios: ["1024x1024", "1536x1024"] });

        await page.reload();
        await page.getByRole("tab", { name: "逻辑模型", exact: true }).click();
        await page.getByRole("button", { name: "编辑 e2e-image", exact: true }).click();
        await expect(page.getByText("支持尺寸 / 比例", { exact: true }).locator("xpath=..").getByRole("textbox").first()).toHaveValue("1024x1024, 1536x1024");
        const evidenceDir = path.resolve(process.cwd(), "../docs/generation-management/evidence");
        await mkdir(evidenceDir, { recursive: true });
        await page.screenshot({ path: path.join(evidenceDir, "image-sizes-admin.png") });

        const sessionResponse = await request.get("/api/auth/session", { headers: { "cache-control": "no-cache" } });
        expect(sessionResponse.ok()).toBe(true);
        const session = await sessionResponse.json() as { settings?: { logicalModels?: Array<{ id: string; bindings?: Array<{ capabilityProfile?: Record<string, unknown> }> }> } };
        const publicProfile = session.settings?.logicalModels?.find((model) => model.id === "e2e-image")?.bindings?.[0]?.capabilityProfile;
        expect(publicProfile).toEqual({ aspectRatios: ["1024x1024", "1536x1024"] });
        expect(publicProfile).not.toHaveProperty("unitCost");
        expect(publicProfile).not.toHaveProperty("timeoutMs");

        await page.goto("/create?mode=image");
        await expect(page.getByRole("button", { name: "图片比例：1024x1024", exact: true })).toBeVisible();
        await page.getByRole("button", { name: "图片比例：1024x1024", exact: true }).click();
        const workbenchSizeOptions = page.getByRole("listbox", { name: "图片比例" });
        const sizeOption = workbenchSizeOptions.getByRole("option", { name: "1536x1024", exact: true });
        await expect(sizeOption).toBeVisible();
        await page.screenshot({ path: path.join(evidenceDir, "image-sizes-workbench.png") });
        await sizeOption.click();
        await expect(page.getByRole("button", { name: "图片比例：1536x1024", exact: true })).toBeVisible();

        let submittedSize: unknown;
        await page.route("**/api/image-tasks", async (route) => {
            const body = await route.request().postDataJSON() as { config?: { size?: unknown }; size?: unknown };
            submittedSize = body.config?.size ?? body.size;
            await route.fulfill({ json: { task: { id: "e2e-image-size-only", status: "success", result: { url: "/design/home/aurora-background.webp", mimeType: "image/webp", width: 1536, height: 1024 } } } });
        });
        await page.route("**/api/image-tasks/**", async (route) => {
            if (route.request().method() === "GET") {
                await route.fulfill({ json: { task: { id: "e2e-image-size-only", status: "success", result: { url: "/design/home/aurora-background.webp", mimeType: "image/webp", width: 1536, height: 1024 } } } });
                return;
            }
            await route.continue();
        });
        await page.locator("#workbench-prompt").fill("尺寸配置回归");
        await page.getByRole("button", { name: /^立即生成/ }).click();
        await expect.poll(() => submittedSize).toBe("1536x1024");

        const projectResponse = await request.post("/api/canvas/projects", { data: {
            title: "模型尺寸选项回归",
            project: { nodes: [{ id: "image-size-config", type: "config", title: "生成配置", position: { x: 100, y: 100 }, width: 360, height: 440, metadata: { generationMode: "image", model: "e2e-image", size: "1024x1024", composerContent: "Canvas 尺寸选项" } }], connections: [] },
        } });
        expect(projectResponse.ok(), await projectResponse.text()).toBe(true);
        projectId = ((await projectResponse.json()) as { data: { project: { id: string } } }).data.project.id;
        await page.goto(`/canvas/${projectId}`);
        const configNode = page.locator('[data-node-id="image-size-config"]');
        await expect(configNode).toBeVisible();
        await configNode.getByRole("button", { name: /图片设置：/ }).click();
        const canvasSize = page.getByRole("button", { name: /选择图片比例.*1536×1024/ });
        await expect(canvasSize).toBeVisible();
        await page.screenshot({ path: path.join(evidenceDir, "image-sizes-canvas.png") });
        await expect(page.getByRole("button", { name: "打开图片自定义像素尺寸" })).toHaveCount(0);
        await canvasSize.click();

        await page.goto("/admin?section=channels");
        await expect(page.locator('.admin-dashboard-shell[data-hydrated="true"]:visible')).toHaveCount(1);
        await page.getByRole("tab", { name: "逻辑模型", exact: true }).click();
        await page.getByRole("button", { name: "编辑 e2e-image", exact: true }).click();
        const clearField = page.getByText("支持尺寸 / 比例", { exact: true }).locator("xpath=..").getByRole("textbox").first();
        await clearField.fill("");
        const emptySaved = page.waitForResponse((response) => response.request().method() === "PATCH" && new URL(response.url()).pathname === "/api/admin/settings");
        await page.getByRole("button", { name: "应用修改", exact: true }).click();
        expect((await emptySaved).ok()).toBe(true);
        await expect.poll(async () => (await readSettings(request)).logicalModels.find((item) => item.id === "e2e-image")?.bindings?.[0]?.capabilityProfile?.aspectRatios).toBeUndefined();

        await page.goto("/create?mode=image");
        await page.reload();
        await expect(page.getByRole("button", { name: "图片比例：16:9", exact: true })).toBeVisible();
        await page.getByRole("button", { name: "图片比例：16:9", exact: true }).click();
        const defaultSizes = page.getByRole("listbox", { name: "图片比例" });
        await expect(defaultSizes.getByRole("option", { name: "16:9", exact: true })).toBeVisible();
        await expect(defaultSizes.getByRole("option", { name: "1:1", exact: true })).toBeVisible();
        await expect(defaultSizes.getByRole("option", { name: /\d+x\d+/ })).toHaveCount(0);
    } finally {
        if (projectId) {
            const deleted = await request.delete("/api/canvas/projects", { data: { ids: [projectId] } });
            expect(deleted.ok(), await deleted.text()).toBe(true);
        }
        const restored = await request.patch("/api/admin/settings", { data: e2eSettingsPatch() });
        expect(restored.ok(), await restored.text()).toBe(true);
    }
});

async function readSettings(request: APIRequestContext) {
    const response = await request.get("/api/admin/settings", { headers: { "cache-control": "no-cache" } });
    expect(response.ok(), await response.text()).toBe(true);
    return (await response.json() as { settings: TestSettings }).settings;
}
