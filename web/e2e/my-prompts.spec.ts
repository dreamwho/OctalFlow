import { randomUUID } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";
import { E2E_ADMIN } from "./support";

const ONE_PIXEL_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

test("my prompts accepts file, drop and paste covers and persists edits", async ({ page }) => {
    const suffix = randomUUID().slice(0, 8);
    const title = `上传提示词 ${suffix}`;
    const request = page.context().request;
    let promptId = "";
    try {
        const login = await request.post("/api/auth/login", { data: { username: E2E_ADMIN.username, password: E2E_ADMIN.password } });
        expect(login.ok(), await login.text()).toBe(true);
        await page.goto("/my-prompts", { waitUntil: "domcontentloaded" });
        await page.getByRole("button", { name: "添加提示词" }).click();
        const dialog = page.getByRole("dialog", { name: "添加提示词" });
        await expect(dialog).toBeVisible();
        const layout = await dialog.evaluate((element) => {
            const rect = element.getBoundingClientRect();
            return { left: rect.left, right: rect.right, viewport: window.innerWidth, documentWidth: document.documentElement.scrollWidth };
        });
        expect(layout.left).toBeGreaterThanOrEqual(0);
        expect(layout.right).toBeLessThanOrEqual(layout.viewport);
        expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewport);
        await expect(page.getByText("选择文件、拖拽图片到此处，或复制图片后直接粘贴")).toBeVisible();

        await page.getByLabel("选择提示词封面图片").setInputFiles({ name: "selected.png", mimeType: "image/png", buffer: ONE_PIXEL_PNG });
        await expect(page.getByAltText("提示词封面预览")).toBeVisible();

        await dispatchImageFile(page, "drop", "dropped.png");
        await expect(page.getByText("dropped.png", { exact: true })).toBeVisible();

        await dispatchImageFile(page, "paste", "pasted.png");
        await expect(page.getByText("pasted.png", { exact: true })).toBeVisible();

        await page.getByLabel("标题").fill(title);
        await page.getByLabel("提示词内容").fill("初始提示词内容");
        await page.getByRole("button", { name: "保存提示词" }).click();
        await expect(page.getByText("提示词已保存")).toBeVisible();
        await expect(page.getByText(title, { exact: true })).toBeVisible();

        const listResponse = await request.get("/api/my-prompts?page=1&pageSize=100");
        const list = (await listResponse.json()) as { items: Array<{ id: string; title: string; coverUrl: string }> };
        const created = list.items.find((item) => item.title === title);
        expect(created?.coverUrl).toMatch(/^\/api\/reference-assets\/permanent\//);
        promptId = created?.id || "";

        await page.reload({ waitUntil: "domcontentloaded" });
        await page.getByRole("button", { name: `编辑提示词 ${title}` }).click();
        await expect(page.getByRole("dialog", { name: "编辑提示词" })).toBeVisible();
        await expect(page.getByLabel("标题")).toHaveValue(title);
        await expect(page.getByLabel("提示词内容")).toHaveValue("初始提示词内容");
        await expect(page.getByAltText("提示词封面预览")).toBeVisible();

        await page.getByLabel("提示词内容").fill("编辑后的提示词内容");
        await page.getByRole("button", { name: "保存修改" }).click();
        await expect(page.getByText("提示词已更新")).toBeVisible();
        await page.reload({ waitUntil: "domcontentloaded" });
        await expect(page.getByText("编辑后的提示词内容", { exact: true })).toBeVisible();
    } finally {
        if (promptId) await request.delete(`/api/my-prompts/${encodeURIComponent(promptId)}`);
    }
});

async function dispatchImageFile(page: Page, kind: "drop" | "paste", name: string) {
    const target = kind === "drop" ? page.getByTestId("prompt-cover-dropzone") : page.getByLabel("标题");
    await target.evaluate(
        (element, { bytes, fileName, eventKind }) => {
            const transfer = new DataTransfer();
            transfer.items.add(new File([Uint8Array.from(atob(bytes), (character) => character.charCodeAt(0))], fileName, { type: "image/png" }));
            element.dispatchEvent(eventKind === "drop" ? new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }) : new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer }));
        },
        { bytes: ONE_PIXEL_PNG.toString("base64"), fileName: name, eventKind: kind },
    );
}
