import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

test.describe.configure({ mode: "serial" });

function node(id: string, type: string, x: number, y: number, width: number, height: number, metadata: Record<string, unknown>) {
    return { id, type, title: id, position: { x, y }, width, height, metadata };
}

async function createCanvasProject(request: APIRequestContext, project: Record<string, unknown>) {
    const response = await request.post("/api/canvas/projects", { data: { title: project.title, project } });
    expect(response.ok(), await response.text()).toBe(true);
    return ((await response.json()) as { data: { project: { id: string } } }).data.project;
}

async function deleteCanvasProject(request: APIRequestContext, id: string) {
    await request.delete("/api/canvas/projects", { data: { ids: [id] } });
}

test("bug1: @ 引用插入在光标位置而不是末尾", async ({ page, request }) => {
    const project = await createCanvasProject(request, {
        title: "画布引用位置回归",
        viewport: { x: 0, y: 0, k: 1 },
        nodes: [
            node("ref-img-a", "image", 60, 80, 300, 200, { content: "/api/reference-assets/permanent/test-a.png", status: "success", naturalWidth: 300, naturalHeight: 200 }),
            node("ref-img-b", "image", 420, 80, 300, 200, { content: "/api/reference-assets/permanent/test-b.png", status: "success", naturalWidth: 300, naturalHeight: 200 }),
        ],
        connections: [],
    });
    try {
        await page.goto(`/canvas/${project.id}`);
        await page.locator('[data-node-id="ref-img-a"]').click({ position: { x: 30, y: 30 } });
        const prompt = page.getByRole("textbox", { name: "节点提示词" });
        await expect(prompt).toBeVisible();
        // 文本中间留下光标：abc -> 光标移到 b 与 c 之间 -> 输入 @
        await prompt.click();
        await page.keyboard.type("abc");
        await page.keyboard.press("Home");
        await page.keyboard.press("ArrowRight");
        await page.keyboard.press("ArrowRight");
        await page.keyboard.type("@");
        await page.waitForTimeout(800);
        console.log("PROMPT VALUE AFTER @:", JSON.stringify(await prompt.textContent()));
        await page.screenshot({ path: ".e2e-artifacts/bug1-after-at.png" });
        const menu = page.locator('[data-canvas-resource-mention-menu="true"]');
        await expect(menu).toBeVisible();
        // 点击第二个已连接素材（图片2）
        await menu.locator("button", { hasText: "图片1" }).first().click();
        await page.waitForTimeout(800);
        const value = await prompt.textContent();
        console.log("PROMPT AFTER INSERT:", JSON.stringify(value));
        // 期望引用出现在 "ab" 与 "c" 之间：ab@图片2 c；而不是 abc @图片2
        expect(value?.replace(/\s+/g, "")).not.toContain("abc");
    } finally {
        await deleteCanvasProject(request, project.id);
    }
});

test("bug1b: 参考 chips 插入在光标位置", async ({ page, request }) => {
    const project = await createCanvasProject(request, {
        title: "画布参考chips回归",
        viewport: { x: 0, y: 0, k: 1 },
        nodes: [
            node("chip-img-a", "image", 60, 80, 300, 200, { content: "/api/reference-assets/permanent/test-a.png", status: "success", naturalWidth: 300, naturalHeight: 200 }),
            node("chip-img-b", "image", 420, 80, 300, 200, { content: "/api/reference-assets/permanent/test-b.png", status: "success", naturalWidth: 300, naturalHeight: 200 }),
        ],
        connections: [{ id: "conn-chip-1", fromNodeId: "chip-img-a", toNodeId: "chip-img-b" }],
    });
    try {
        await page.goto(`/canvas/${project.id}`);
        await page.locator('[data-node-id="chip-img-b"]').click({ position: { x: 30, y: 30 } });
        const prompt = page.getByRole("textbox", { name: "节点提示词" });
        await expect(prompt).toBeVisible();
        await prompt.click();
        await page.keyboard.type("abc");
        await page.keyboard.press("Home");
        await page.keyboard.press("ArrowRight");
        await page.keyboard.press("ArrowRight");
        // 打开「参考」Popover 并点击图片1 chips
        await page.getByRole("button", { name: "选择参考素材" }).click();
        await page.waitForTimeout(500);
        await page.getByRole("button", { name: "插入 图片1" }).click();
        await page.waitForTimeout(800);
        const value = await prompt.textContent();
        console.log("CHIPS PROMPT AFTER INSERT:", JSON.stringify(value));
        expect(value?.replace(/\s+/g, "")).not.toContain("abc图片1");
        expect(value?.replace(/\s+/g, "")).toContain("ab图片1");
    } finally {
        await deleteCanvasProject(request, project.id);
    }
});

test("bug1c: 未连接素材插入在光标位置", async ({ page, request }) => {
    const project = await createCanvasProject(request, {
        title: "画布未连接素材回归",
        viewport: { x: 0, y: 0, k: 1 },
        nodes: [
            node("unc-img-a", "image", 60, 80, 300, 200, { content: "/api/reference-assets/permanent/test-a.png", status: "success", naturalWidth: 300, naturalHeight: 200 }),
            node("unc-img-b", "image", 420, 80, 300, 200, { content: "/api/reference-assets/permanent/test-b.png", status: "success", naturalWidth: 300, naturalHeight: 200 }),
            node("unc-img-c", "image", 780, 80, 300, 200, { content: "/api/reference-assets/permanent/test-c.png", status: "success", naturalWidth: 300, naturalHeight: 200 }),
        ],
        connections: [{ id: "conn-unc-1", fromNodeId: "unc-img-a", toNodeId: "unc-img-c" }],
    });
    try {
        await page.goto(`/canvas/${project.id}`);
        await page.locator('[data-node-id="unc-img-c"]').click({ position: { x: 30, y: 30 } });
        const prompt = page.getByRole("textbox", { name: "节点提示词" });
        await expect(prompt).toBeVisible();
        await prompt.click();
        await page.keyboard.type("abc");
        await page.keyboard.press("Home");
        await page.keyboard.press("ArrowRight");
        await page.keyboard.press("ArrowRight");
        await page.keyboard.type("@");
        await page.waitForTimeout(600);
        const menu = page.locator('[data-canvas-resource-mention-menu="true"]');
        await expect(menu).toBeVisible();
        await menu.getByText("图片", { exact: true }).click();
        await page.waitForTimeout(600);
        const flyoutRow = page.locator('[data-canvas-resource-flyout="true"] button').first();
        await expect(flyoutRow).toBeVisible();
        await flyoutRow.click();
        await page.waitForTimeout(800);
        const value = await prompt.textContent();
        console.log("UNCONNECTED PROMPT AFTER INSERT:", JSON.stringify(value));
        expect(value?.replace(/\s+/g, "")).toMatch(/^ab图片\d+c$/);
    } finally {
        await deleteCanvasProject(request, project.id);
    }
});

test("bug5: 分类悬停需停留才弹出二级列表且移开后清除残留", async ({ page, request }) => {
    page.on("console", (m) => { const t = m.text(); if (t.includes("[dbg]")) console.log("BROWSER:", t); });
    const project = await createCanvasProject(request, {
        title: "画布分类悬停回归",
        viewport: { x: 0, y: 0, k: 1 },
        nodes: [
            node("hov-img-a", "image", 60, 80, 300, 200, { content: "/api/reference-assets/permanent/test-a.png", status: "success", naturalWidth: 300, naturalHeight: 200 }),
            node("hov-img-b", "image", 420, 80, 300, 200, { content: "/api/reference-assets/permanent/test-b.png", status: "success", naturalWidth: 300, naturalHeight: 200 }),
            node("hov-img-c", "image", 780, 80, 300, 200, { content: "/api/reference-assets/permanent/test-c.png", status: "success", naturalWidth: 300, naturalHeight: 200 }),
        ],
        connections: [{ id: "conn-hov-1", fromNodeId: "hov-img-a", toNodeId: "hov-img-c" }],
    });
    try {
        await page.goto(`/canvas/${project.id}`);
        await page.locator('[data-node-id="hov-img-c"]').click({ position: { x: 30, y: 30 } });
        const prompt = page.getByRole("textbox", { name: "节点提示词" });
        await expect(prompt).toBeVisible();
        await prompt.click();
        await page.keyboard.type("@");
        await page.waitForTimeout(500);
        const menu = page.locator('[data-canvas-resource-mention-menu="true"]');
        await expect(menu).toBeVisible();
        const flyout = page.locator('[data-canvas-resource-flyout="true"]');
        const categoryRow = menu.getByText("图片", { exact: true });

        // 悬停分类行：停留超过悬停意图延时后二级列表弹出
        await categoryRow.hover();
        await page.waitForTimeout(600);
        await expect(flyout).toBeVisible();

        // 鼠标移到菜单顶部无交互区域：分类高亮与二级列表应在关闭延时内清除（无残留）
        await menu.getByText("可能@的内容").hover();
        await page.waitForTimeout(800);
        await expect(flyout).toHaveCount(0);
    } finally {
        await deleteCanvasProject(request, project.id);
    }
});

test("bug3: 点击连线后可以按 Delete 删除", async ({ page, request }) => {
    const project = await createCanvasProject(request, {
        title: "画布连线删除回归",
        viewport: { x: 0, y: 0, k: 1 },
        nodes: [
            node("edge-a", "image", 60, 80, 300, 200, { content: "/api/reference-assets/permanent/test-a.png", status: "success" }),
            node("edge-b", "image", 520, 80, 300, 200, { content: "/api/reference-assets/permanent/test-b.png", status: "success" }),
        ],
        connections: [{ id: "conn-del-1", fromNodeId: "edge-a", toNodeId: "edge-b" }],
    });
    try {
        await page.goto(`/canvas/${project.id}`);
        await expect(page.locator('[data-connection-id="conn-del-1"]')).toHaveCount(1);
        // 点击连线命中层的曲线中点（贝塞尔曲线包围盒中心不一定在曲线上）
        const midPoint = await page.evaluate(() => {
            const path = document.querySelector('[data-connection-id="conn-del-1"] path');
            if (!path) return null;
            const length = path.getTotalLength();
            const point = path.getPointAtLength(length / 2);
            const matrix = path.getScreenCTM();
            if (!matrix) return null;
            return { x: point.x * matrix.a + point.y * matrix.c + matrix.e, y: point.x * matrix.b + point.y * matrix.d + matrix.f };
        });
        console.log("EDGE MIDPOINT:", JSON.stringify(midPoint));
        await page.mouse.click(midPoint!.x, midPoint!.y);
        await page.waitForTimeout(400);
        const selected = await page.evaluate(() => !!document.querySelector('[data-connection-id] path[style*="drop-shadow"]'));
        console.log("EDGE SELECTED AFTER CLICK:", selected);
        expect(selected).toBe(true);
        await page.keyboard.press("Delete");
        await page.waitForTimeout(600);
        console.log("CONNECTIONS AFTER DELETE:", await page.locator("[data-connection-id]").count());
        await expect(page.locator('[data-connection-id="conn-del-1"]')).toHaveCount(0);
    } finally {
        await deleteCanvasProject(request, project.id);
    }
});

test("bug4: 粘贴图片立即创建节点并显示上传进度", async ({ page, request }) => {
    page.on("pageerror", (error) => console.log("PAGE ERROR:", String(error).slice(0, 300)));
    page.on("console", (message) => {
        const text = message.text();
        if (text.includes("[optimistic") || text.includes("PAGE ERROR")) console.log("BROWSER:", text.slice(0, 200));
    });
    const project = await createCanvasProject(request, {
        title: "画布粘贴上传回归",
        viewport: { x: 0, y: 0, k: 1 },
        nodes: [],
        connections: [],
    });
    try {
        await page.goto(`/canvas/${project.id}`);
        // 等待画布项目加载完成，避免粘贴的乐观节点被异步加载覆盖
        await expect(page.locator(".canvas-topbar")).toBeVisible({ timeout: 15000 });
        await page.waitForTimeout(1200);
        // 拦截上传接口延迟 2.5 秒，模拟慢速上传
        await page.route("**/api/reference-assets", async (route) => {
            await new Promise((resolve) => setTimeout(resolve, 2500));
            await route.continue();
        });
        const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
        await page.evaluate((base64) => {
            const bytes = Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0));
            const file = new File([bytes], "paste.png", { type: "image/png" });
            const dt = new DataTransfer();
            dt.items.add(file);
            const event = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
            document.body.dispatchEvent(event);
        }, png.toString("base64"));
        // 节点必须立即出现（上传未完成时）
        await page.waitForTimeout(600);
        const loadingNodes = await page.locator("[data-canvas-node-loading]").count();
        const imageNodes = await page.locator('[data-node-id^="image-"]').count();
        const anyNodes = await page.evaluate(() => Array.from(document.querySelectorAll("[data-node-id]")).map((el) => el.getAttribute("data-node-id")));
        const toast = await page.locator(".ant-message").innerText().catch(() => "");
        console.log("IMMEDIATE image nodes:", imageNodes, "| loading overlays:", loadingNodes, "| all nodes:", JSON.stringify(anyNodes), "| toast:", JSON.stringify(toast));
        const projectState = await request.get(`/api/canvas/projects/${project.id}`);
        const savedNodes = ((await projectState.json()) as { data?: { project?: { nodes?: unknown[] } } }).data?.project?.nodes;
        console.log("SAVED NODES:", JSON.stringify(savedNodes)?.slice(0, 400));
        await page.screenshot({ path: ".e2e-artifacts/bug4-immediate.png" });
        expect(imageNodes).toBeGreaterThanOrEqual(1);
        // 上传完成（2.5s 后）节点变为成功状态
        await page.waitForTimeout(5000);
        const loadingAfter = await page.locator("[data-canvas-node-loading]").count();
        console.log("loading overlays after upload:", loadingAfter);
        expect(loadingAfter).toBe(0);
    } finally {
        await deleteCanvasProject(request, project.id);
    }
});
