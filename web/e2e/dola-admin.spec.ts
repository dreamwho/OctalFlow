import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { e2eSettingsPatch } from "./support";
import { protocolModelConfig } from "../src/lib/channel-protocol-registry";

test.describe.configure({ mode: "serial" });

const READY_COOKIE = "session=e2e-ready-cookie; uid=101";
const EXPIRED_COOKIE = "session=e2e-expired-cookie; uid=102";
const BOOM_COOKIE = "session=e2e-boom-cookie; uid=103";
const REFRESH_ROUTE = /\/api\/admin\/dola\/accounts\/[^/]+\/refresh$/;

test("DOLA accepted 额度拒绝会换号，记录消耗，并保持管理员取消终态", async ({ page, request }) => {
    const defaults = e2eSettingsPatch();
    const upstreamModel = "dola-seedance-2-5";
    const logicalModel = "e2e-dola-video";
    const patch = {
        systemChannels: [...defaults.systemChannels, { id: "dola", name: "Dola API", baseUrl: "", apiKey: "", enabled: true, apiFormat: "openai", models: [upstreamModel], advancedConfig: { protocol: "dola", authMode: "provider-managed", modelCapabilities: { [upstreamModel]: "video" }, modelConfigs: { [upstreamModel]: protocolModelConfig("dola", "video", upstreamModel) } } }],
        logicalModels: [...defaults.logicalModels, { id: logicalModel, name: logicalModel, capability: "video", enabled: true, bindings: [{ id: `dola:${upstreamModel}`, channelId: "dola", upstreamModel, enabled: true, priority: 1 }] }],
        modelPointCosts: { ...defaults.modelPointCosts, [logicalModel]: 0 },
    };
    const saved = await request.patch("/api/admin/settings", { data: patch });
    expect(saved.ok(), await saved.text()).toBe(true);
    const group = "额度回归专用";
    const imported = await request.post("/api/admin/dola/accounts", { data: { items: [{ cookie: "session=quota-exhausted", name: "额度耗尽夹具", group }, { cookie: "session=quota-reply", name: "额度可用夹具", group }] } });
    expect(imported.ok(), await imported.text()).toBe(true);
    const gateway = await request.patch("/api/admin/dola/gateway", { data: { rotationLimit: 2, dispatchGroups: [group] } });
    expect(gateway.ok(), await gateway.text()).toBe(true);
    try {
        const headers = { "x-dreamyo-logical-model": logicalModel, "x-dreamyo-upstream-model": upstreamModel };
        const submitted = await request.post("/api/ai/system/dola/v1/videos", { headers, data: { model: upstreamModel, prompt: "本地额度回归", duration: 15, ratio: "16:9" } });
        expect(submitted.ok(), await submitted.text()).toBe(true);
        const first = await submitted.json();
        expect(first.status).toBe("accepted");
        expect(first.quota[0]).toMatchObject({ remaining: 2, taskCost: 2, consumed: 2, observedTotal: 4, limit: null });
        const overview = await request.get("/api/admin/dola");
        const accounts = (await overview.json()).data.accounts;
        expect(accounts.find((item: { name: string }) => item.name === "额度耗尽夹具")).toMatchObject({ status: "quota_exhausted" });
        const created = await request.post("/api/video-generation-tasks", { data: { config: { model: logicalModel, size: "16:9", vquality: "720", videoSeconds: 15 }, prompt: "取消状态回归", source: "canvas" } });
        expect(created.ok(), await created.text()).toBe(true);
        const logs = async () => ((await (await request.get("/api/admin/dola/logs?source=runtime")).json()).data.items as Array<{ taskId?: string; phase: string; statusCode: number; lifecycle?: Array<{ message: string }> }>);
        let taskId = "";
        await expect.poll(async () => { taskId = (await logs()).find((item) => item.taskId && item.taskId !== first.id)?.taskId || ""; return taskId; }).not.toBe("");
        await openDolaAccounts(page);
        await page.getByRole("tab", { name: "请求日志" }).click();
        await page.getByRole("button").filter({ hasText: taskId }).first().click();
        await page.getByRole("button", { name: "取消任务", exact: true }).click();
        await page.locator(".ant-popconfirm").getByRole("button", { name: "取消任务", exact: true }).click();
        await expect(page.locator(".ant-drawer").getByText(/已取消 ·/)).toBeVisible();
        // A late successful transport response must not resurrect the cancelled row.
        await request.get(`/api/ai/system/dola/v1/videos/${taskId}`, { headers });
        expect((await logs()).find((item) => item.taskId === taskId)).toMatchObject({ phase: "cancelled", statusCode: 200 });
        await page.reload({ waitUntil: "domcontentloaded" });
        await page.getByRole("tab", { name: "请求日志" }).click();
        const row = page.getByRole("button").filter({ hasText: taskId }).first();
        await expect(row.getByText("已取消", { exact: true }).first()).toBeVisible();
        await row.click();
        for (const width of [1280, 390, 430]) {
            await page.setViewportSize({ width, height: 900 });
            const drawer = page.locator(".ant-drawer-content-wrapper:visible");
            await expect.poll(async () => { const bounds = await drawer.boundingBox(); return Boolean(bounds && bounds.x >= -1 && bounds.x + bounds.width <= width + 1); }).toBe(true);
            const content = await drawer.locator(".ant-drawer-body").evaluate((element) => ({ width: element.clientWidth, scrollWidth: element.scrollWidth }));
            expect(content.scrollWidth).toBeLessThanOrEqual(content.width + 1);
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
            await page.screenshot({ path: `.e2e-artifacts/dola-cancelled-${width}.png` });
        }
    } finally {
        await request.patch("/api/admin/settings", { data: defaults });
        await request.patch("/api/admin/dola/gateway", { data: { dispatchGroups: [] } });
    }
});

async function openDolaAccounts(page: Page) {
    // 本地手动实例的 RSC 再校验会误判匿名并跳转登录页（与被测改动无关）；阻断 RSC 请求保持初始渲染
    await page.route(/_rsc/, (route) => route.abort());
    await page.goto("/admin?section=dolaApi", { waitUntil: "domcontentloaded" });
    await expect(page.locator(".admin-dashboard-shell[data-hydrated='true']")).toBeVisible();
    await expect(page.getByRole("button", { name: "检测全部登录状态" })).toBeVisible();
}

function accountRow(page: Page, name: string) {
    return page.getByRole("row", { name: new RegExp(`${name}(?:\\s|$)`) });
}

test("参考图上传出口与 Dola 提交代理独立展示四种方式", async ({ page }) => {
    let binding = { enabled: false, target: "" };
    await page.route("**/api/admin/generic-proxy/proxy/generic-bindings", async (route) => {
        if (route.request().method() === "POST") {
            const body = route.request().postDataJSON() as { provider: string; enabled: boolean; target?: string };
            if (body.provider === "dolaUpload") binding = { enabled: body.enabled, target: body.target || "" };
        }
        await route.fulfill({ json: { code: 0, data: { bindings: { dolaUpload: binding }, revision: "fixture" }, msg: "" } });
    });
    await page.route("**/api/admin/generic-proxy/proxies", (route) => route.fulfill({ json: { code: 0, data: { groups: [{ id: "residential", name: "住宅代理", nodes: [{ id: "node-1", name: "台湾节点" }] }] }, msg: "" } }));
    await openDolaAccounts(page);
    await page.getByRole("tab", { name: "代理管理" }).click();
    await expect(page.getByText("Dola API · 代理管理")).toBeVisible();
    await expect(page.getByText("Dola 参考图上传 · 代理管理")).toBeVisible();
    const upload = page.getByText("Dola 参考图上传 · 代理管理").locator("xpath=ancestor::section[1]");
    await expect(upload.getByText("直连", { exact: true }).first()).toBeVisible();
    await expect(upload.getByText("魔法代理", { exact: true })).toBeVisible();
    await expect(upload.getByText("通用代理", { exact: true })).toBeVisible();
    await expect(upload.getByText("链式代理", { exact: true })).toBeVisible();
    await upload.getByText("通用代理", { exact: true }).click();
    const generic = upload.getByRole("combobox", { name: "通用代理出口" });
    await expect(generic).toBeVisible();
    await generic.click();
    await page.getByText("节点 · 台湾节点（住宅代理）", { exact: true }).click();
    await expect.poll(() => binding).toEqual({ enabled: true, target: "node:node-1" });
    await upload.getByText("直连", { exact: true }).last().click();
    await expect(upload.getByText(/参考图通过服务器网络直连 ImageX/)).toBeVisible();
    await expect.poll(() => binding).toEqual({ enabled: false, target: "" });
    for (const width of [390, 430]) {
        await page.setViewportSize({ width, height: 844 });
        const bounds = await upload.getByRole("radiogroup", { name: "代理方式" }).boundingBox();
        expect(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width).toBe(true);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
});

test("导入的账号进入账号池并展示中文状态", async ({ page, request }) => {
    const existing = await request.get("/api/admin/dola");
    expect(existing.ok(), await existing.text()).toBe(true);
    const previous = ((await existing.json()) as { data: { accounts: Array<{ id: string }> } }).data.accounts;
    for (const account of previous) {
        const deleted = await request.delete(`/api/admin/dola/accounts/${account.id}`);
        expect(deleted.ok(), await deleted.text()).toBe(true);
    }

    const imported = await request.post("/api/admin/dola/accounts", {
        data: {
            items: [
                { cookie: READY_COOKIE, name: "e2e-ready", sourceFileName: "e2e.txt", sourceOrdinal: 1 },
                { cookie: EXPIRED_COOKIE, name: "e2e-expired", sourceFileName: "e2e.txt", sourceOrdinal: 2 },
                { cookie: BOOM_COOKIE, name: "e2e-boom", sourceFileName: "e2e.txt", sourceOrdinal: 3 },
            ],
        },
    });
    expect(imported.ok(), await imported.text()).toBe(true);

    await openDolaAccounts(page);
    await expect(accountRow(page, "e2e-ready").getByText("登录有效 · 可轮询")).toBeVisible();
    await expect(accountRow(page, "e2e-expired")).toBeVisible();
    await expect(accountRow(page, "e2e-boom")).toBeVisible();
});

test("账号池可按账号名称和 ID 搜索", async ({ page, request }) => {
    const overview = await request.get("/api/admin/dola");
    const accounts = ((await overview.json()) as { data: { accounts: Array<{ id: string; name: string }> } }).data.accounts;
    const account = accounts.find((item) => item.name === "e2e-ready");
    expect(account).toBeTruthy();
    await openDolaAccounts(page);
    const search = page.getByPlaceholder("搜索账号 ID 或名称");
    await search.fill("e2e-ready");
    await expect(accountRow(page, "e2e-ready")).toBeVisible();
    await expect(accountRow(page, "e2e-expired")).toHaveCount(0);
    await search.fill(account!.id);
    await expect(accountRow(page, "e2e-ready")).toBeVisible();
    await expect(accountRow(page, "e2e-expired")).toHaveCount(0);
    for (const width of [390, 430]) {
        await page.setViewportSize({ width, height: 844 });
        await expect(search).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
});

test("服务器账号测试使用远程浏览器并可关闭回收", async ({ page, request }) => {
    const logsBeforeResponse = await request.get("/api/admin/dola/logs?pageSize=1");
    const logsBefore = ((await logsBeforeResponse.json()) as { data: { total: number } }).data.total;
    await openDolaAccounts(page);
    await accountRow(page, "e2e-ready").getByRole("button", { name: "有头测试" }).click();
    const options = page.getByRole("dialog", { name: "有头测试 · e2e-ready", exact: true });
    await expect(options.getByText("远程窗口最长空闲时间（秒）")).toBeVisible();
    await options.getByRole("radio", { name: "魔法代理" }).click();
    await expect(options.getByText("请配置 Dola 魔法代理节点")).toBeVisible();
    await options.getByRole("radio", { name: "链式代理" }).click();
    await expect(options.getByText("请配置 Dola 链式代理跳板与落地节点")).toBeVisible();
    await options.getByRole("radio", { name: "直连" }).click();
    await options.getByRole("button", { name: "打开独立窗口" }).click();
    const remote = page.getByRole("dialog", { name: "Dola 有头测试" });
    await expect(remote.getByAltText("Dola 账号实际页面")).toBeVisible();
    await remote.getByRole("button", { name: "刷新画面" }).click();
    await remote.getByRole("button", { name: "Tab", exact: true }).click();
    for (const width of [390, 430]) {
        await page.setViewportSize({ width, height: 844 });
        await expect.poll(async () => {
            const bounds = await remote.boundingBox();
            return Boolean(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width);
        }).toBe(true);
    }
    const state = await request.get(`http://127.0.0.1:${process.env.DREAMYO_PROTOCOL_FIXTURE_PORT || 4010}/__state`);
    const requests = ((await state.json()) as { requests: Array<{ path: string; headless?: boolean; timeoutSeconds?: number }> }).requests;
    const started = requests.findLast((item) => item.path.endsWith("/accounts/headed-test"));
    expect(started).toBeTruthy();
    expect(started).toMatchObject({ headless: true, timeoutSeconds: 180 });
    await remote.getByRole("button", { name: "结束测试" }).click();
    await page.getByRole("dialog", { name: "结束有头测试" }).getByRole("button", { name: "不保存，关闭浏览器" }).click();
    await expect(remote).toBeHidden();
    const logsAfterResponse = await request.get("/api/admin/dola/logs?pageSize=1");
    expect(((await logsAfterResponse.json()) as { data: { total: number } }).data.total).toBe(logsBefore);
});

test("本地账号有头测试直接使用原生浏览器确认弹层", async ({ page, request }) => {
    const overview = await request.get("/api/admin/dola");
    const accounts = ((await overview.json()) as { data: { accounts: Array<{ name: string }> } }).data.accounts;
    if (!accounts.some((item) => item.name === "e2e-ready")) {
        const imported = await request.post("/api/admin/dola/accounts", { data: { items: [{ cookie: READY_COOKIE, name: "e2e-ready", sourceFileName: "e2e.txt", sourceOrdinal: 1 }] } });
        expect(imported.ok(), await imported.text()).toBe(true);
    }
    const leaseToken = "native-headed-test-lease-token";
    await page.route("**/api/admin/dola/accounts/*/headed-test", (route) => route.fulfill({ json: { code: 0, data: { verificationId: "native-headed-fixture", leaseToken, headless: false }, msg: "" } }));
    await page.route("**/api/admin/dola/verifications/native-headed-fixture/finalize", (route) => route.fulfill({ json: { code: 0, data: { status: "saved", changed: true, windowClosed: true }, msg: "" } }));
    await openDolaAccounts(page);
    await accountRow(page, "e2e-ready").getByRole("button", { name: "有头测试" }).click();
    const options = page.getByRole("dialog", { name: "有头测试 · e2e-ready", exact: true });
    await options.getByRole("button", { name: "打开独立窗口" }).click();
    await expect(options).toBeHidden();
    const native = page.getByRole("dialog", { name: /Dola 本机有头测试/ });
    await expect(native.getByText("请直接在本机 Camoufox 窗口操作")).toBeVisible();
    await expect(page.getByRole("dialog", { name: "Dola 有头测试", exact: true })).toHaveCount(0);
    for (const width of [390, 430]) {
        await page.setViewportSize({ width, height: 844 });
        const bounds = await native.boundingBox();
        expect(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width).toBe(true);
    }
    await native.getByRole("button", { name: "检测登录并保存 Cookie" }).click();
    await expect(native).toBeHidden();
});

test("返回进行中的本机测试仍使用原生窗口而非远程截图", async ({ page, request }) => {
    const accountsResponse = await request.get("/api/admin/dola");
    const accountsPayload = await accountsResponse.json() as { data: { accounts: Array<{ id: string; name: string }> } };
    const accountId = accountsPayload.data.accounts.find((item) => item.name === "e2e-ready")?.id;
    expect(accountId).toBeTruthy();
    let active = true;
    await page.route("**/api/admin/dola/verifications/active", (route) => route.fulfill({ json: { code: 0, data: active ? [{ verificationId: "native-return-fixture", accountId, createdAt: new Date().toISOString(), headless: false }] : [], msg: "" } }));
    await page.route("**/api/admin/dola/verifications/native-return-fixture/open", (route) => route.fulfill({ json: { code: 0, data: { leaseToken: "native-return-lease-token" }, msg: "" } }));
    await page.route("**/api/admin/dola/verifications/native-return-fixture/close", (route) => { active = false; return route.fulfill({ json: { code: 0, data: { status: "closed" }, msg: "" } }); });
    await openDolaAccounts(page);
    await accountRow(page, "e2e-ready").getByRole("button", { name: "返回有头测试" }).click();
    const native = page.getByRole("dialog", { name: /Dola 本机有头测试/ });
    await expect(native).toBeVisible();
    await expect(page.getByRole("dialog", { name: "Dola 有头测试", exact: true })).toHaveCount(0);
    await native.getByRole("button", { name: "不保存，关闭浏览器" }).click();
    await expect(native).toBeHidden();
    await expect(accountRow(page, "e2e-ready").getByRole("button", { name: "有头测试" })).toBeVisible();
});

test("检测 Cookie 有效的账号展示等待动画、可用状态与额度", async ({ page }) => {
    await openDolaAccounts(page);
    await page.route(REFRESH_ROUTE, async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 600));
        await route.continue();
    });
    const row = accountRow(page, "e2e-ready");
    const checkButton = row.getByRole("button", { name: "检测登录状态" });
    await checkButton.click();
    await expect(checkButton).toHaveClass(/ant-btn-loading/);
    await expect(page.getByText("检测完成：登录、页面签名与只读协议均已通过")).toBeVisible();
    await expect(row.getByText("登录有效 · 可轮询")).toBeVisible();
    await expect(row.getByText("5/100")).toBeVisible();
    await page.unroute(REFRESH_ROUTE);
});

test("检测 Cookie 失效的账号标记登录失效并清空额度", async ({ page }) => {
    await openDolaAccounts(page);
    const row = accountRow(page, "e2e-expired");
    await row.getByRole("button", { name: "检测登录状态" }).click();
    await expect(page.getByText("检测完成：Cookie 已失效，需要重新导入或登录")).toBeVisible();
    await expect(row.getByText("登录失效").first()).toBeVisible();
    await expect(row.getByText("未知", { exact: true })).toBeVisible();
});

test("删除账号需要二次确认", async ({ page }) => {
    await openDolaAccounts(page);
    const row = accountRow(page, "e2e-boom");
    await row.getByRole("button", { name: /删\s*除/ }).click();
    await expect(page.getByText("删除该 Dola 账号？")).toBeVisible();
    await page.locator(".ant-popover").getByRole("button", { name: /删\s*除/ }).click();
    await expect(row).toHaveCount(0);
});

test("批量登录态协议检测展示进度并支持转后台与停止", async ({ page }) => {
    await openDolaAccounts(page);
    // 旧标签不是登录态真值，批量检测必须覆盖所有已启用账号，包括之前标记登录失效的账号。
    const seeded = await page.request.post("/api/admin/dola/accounts", {
        data: {
            items: [
                { cookie: "session=e2e-third-cookie; uid=104", name: "e2e-third", sourceFileName: "e2e.txt", sourceOrdinal: 3 },
                { cookie: "session=e2e-fourth-cookie; uid=105", name: "e2e-fourth", sourceFileName: "e2e.txt", sourceOrdinal: 4 },
            ],
        },
    });
    expect(seeded.ok(), await seeded.text()).toBe(true);
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator(".admin-dashboard-shell[data-hydrated='true']")).toBeVisible();

    // 阶段一：弹层进度 + 转入后台
    let call = 0;
    await page.route(REFRESH_ROUTE, async (route) => {
        const nth = ++call;
        await new Promise((resolve) => setTimeout(resolve, nth <= 2 ? 200 : 1500));
        await route.continue();
    });
    await page.getByRole("button", { name: "检测全部登录状态" }).click();
    const modal = page.getByRole("dialog");
    await expect(modal).toBeVisible();
    await expect(accountRow(page, "e2e-ready").getByRole("button", { name: "检测登录状态" })).toHaveClass(/ant-btn-loading/);
    await expect(modal.getByText("2/4")).toBeVisible();
    await modal.getByRole("button", { name: "转入后台" }).click();
    await expect(modal).toBeHidden();
    const cardButton = page.getByRole("button", { name: /正在检测全部登录态/ });
    await expect(cardButton).toBeVisible();
    await cardButton.click();
    await expect(modal).toBeVisible();
    await expect(page.getByRole("button", { name: "检测全部登录状态" })).toBeVisible({ timeout: 10_000 });
    await expect(modal.getByText("已完成")).toHaveCount(4);
    await modal.getByRole("button", { name: /关\s*闭/ }).click();
    await expect(modal).toBeHidden();
    await page.unroute(REFRESH_ROUTE);

    // 阶段二：弹层内停止刷新，剩余账号不再处理
    await page.route(REFRESH_ROUTE, async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        await route.continue();
    });
    await page.getByRole("button", { name: "检测全部登录状态" }).click();
    const stopModal = page.getByRole("dialog");
    await expect(stopModal).toBeVisible();
    await stopModal.getByRole("button", { name: "停止验证" }).click();
    await expect(page.getByText("已停止刷新，剩余账号未处理")).toBeVisible({ timeout: 10_000 });
    await expect(stopModal.getByText("已停止", { exact: true }).first()).toBeVisible();
    await page.unroute(REFRESH_ROUTE);
});

test("请求日志详情展示错误分类说明", async ({ page }) => {
    const imported = await page.request.post("/api/admin/dola/accounts", {
        data: { items: [{ cookie: BOOM_COOKIE, name: "e2e-boom", sourceFileName: "e2e-log.txt", sourceOrdinal: 1 }] },
    });
    expect(imported.ok(), await imported.text()).toBe(true);
    const importResults = ((await imported.json()) as { data: { results: Array<{ status: string; account?: { id: string } }> } }).data.results;
    const boomId = importResults.find((result) => result.account)?.account?.id;
    expect(boomId).toBeTruthy();
    const failedRefresh = await page.request.post(`/api/admin/dola/accounts/${boomId}/refresh`);
    expect(failedRefresh.ok(), await failedRefresh.text()).toBe(true);

    await openDolaAccounts(page);
    await page.getByRole("tab", { name: "请求日志" }).click();
    const failedRow = page.getByRole("button").filter({ hasText: "e2e-boom" }).first();
    await expect(failedRow).toBeVisible();
    await failedRow.click();
    await expect(page.getByText("错误分类")).toBeVisible();
    await expect(page.getByText(/上游账号触发生成频率\/数量限制/)).toBeVisible();
    await expect(page.getByText("upstream_rate_limited").last()).toBeVisible();
});

test("成功日志自动展示两种视频链接并可复制无水印地址", async ({ page, context }) => {
    const taskId = "dola-11111111-1111-4111-8111-111111111111";
    const videoUrl = "https://v16-dola.dola.com/playback.mp4";
    const downloadUrl = "https://v16-dola.dola.com/original.mp4";
    await page.route("**/api/admin/dola/logs?*", (route) => route.fulfill({ json: { code: 0, data: { items: [{ id: "success-log", createdAt: new Date().toISOString(), source: "runtime", capability: "video", method: "POST", path: "/v1/videos", model: "dola-seedance-2-5", statusCode: 200, durationMs: 1000, phase: "success", taskId, requestPreview: JSON.stringify({ prompt: "原始测试提示词" }), responsePreview: JSON.stringify({ videoUrl }) }], total: 1, page: 1, pageSize: 20, stats: { total: 1, success: 1, failed: 0, needsReview: 0, pending: 0, averageDurationMs: 1000 } } } }));
    await page.route("**/api/admin/dola/logs/unwatermark", (route) => route.fulfill({ json: { code: 0, data: { taskId, videoUrl, downloadUrl, definition: "", codecType: "" } } }));
    await openDolaAccounts(page);
    await page.getByRole("tab", { name: "请求日志" }).click();
    await page.getByRole("button", { name: /生成完成.*站内调用/ }).first().click();
    const drawer = page.getByRole("dialog", { name: "Dola 请求详情" });
    await expect(drawer.getByText(videoUrl, { exact: true })).toBeVisible();
    await expect(drawer.getByText(downloadUrl, { exact: true })).toBeVisible();
    await expect(drawer.getByText("原始测试提示词")).toBeVisible();
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await drawer.getByText(downloadUrl, { exact: true }).locator("..").getByRole("button", { name: "复制" }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(downloadUrl);
    await expect(drawer.getByRole("link", { name: "下载无水印 MP4" })).toHaveAttribute("download", `${taskId}.mp4`);
});

test("通信测试经 Provider 提交并可查询到完成状态", async ({ page }) => {
    await openDolaAccounts(page);
    await page.getByRole("button", { name: "通信测试" }).click();
    const modal = page.getByRole("dialog");
    await modal.getByRole("button", { name: "提交一次测试" }).click();
    await expect(page.getByText("测试请求已提交")).toBeVisible();
    await expect(modal.getByText("状态：submitted")).toBeVisible({ timeout: 15_000 });
    await modal.getByRole("button", { name: "查询状态" }).click();
    await expect(modal.getByText("状态：completed")).toBeVisible({ timeout: 15_000 });
    await page.keyboard.press("Escape");
    await page.getByRole("tab", { name: "请求日志" }).click();
    await page.getByRole("button", { name: /生成完成.*后台实测/ }).first().click();
    await expect(page.getByRole("heading", { name: "Dola 会话回复" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Dola 会话回复" }).locator("..").getByText("你的视频生成好了。")).toBeVisible();
});

test("生成失败截图默认关闭并可在控制台开启", async ({ page, request }) => {
    await openDolaAccounts(page);
    await page.getByRole("tab", { name: "反代网关与 API 密钥" }).click();
    const switchControl = page.getByText("生成失败时抓取会话截图").locator("../..").getByRole("switch");
    await expect(switchControl).not.toBeChecked();
    await switchControl.click();
    await expect(switchControl).toBeChecked();
    const enabled = await request.get("/api/admin/dola/gateway");
    expect(((await enabled.json()) as { data: { captureFailureScreenshot: boolean } }).data.captureFailureScreenshot).toBe(true);
    await switchControl.click();
    await expect(switchControl).not.toBeChecked();
    const interval = page.getByRole("spinbutton");
    await interval.fill("30000");
    await page.getByRole("button", { name: /保\s*存/ }).click();
    await expect.poll(async () => {
        const gateway = await request.get("/api/admin/dola/gateway");
        return ((await gateway.json()) as { data: { pollIntervalMs: number } }).data.pollIntervalMs;
    }).toBe(30_000);
    await interval.fill("2500");
    await page.getByRole("button", { name: /保\s*存/ }).click();
});

test("后台主按钮保持标准紧凑尺寸", async ({ page }) => {
    await openDolaAccounts(page);
    const button = page.getByRole("button", { name: "通信测试" });
    const box = await button.boundingBox();
    expect(box).toBeTruthy();
    // 旧的 octal-theme 52px 大按钮回归会被此处拦下
    expect(box!.height).toBeLessThan(40);
});

test("手动导入 Google 授权会话后独立分组持久化并在账号池可见", async ({ page, request }) => {
    const imported = await request.post("/api/admin/dola/accounts/google-login", {
        data: { manualCookie: "Cookie: session=e2e-google-authorized; uid=901", name: "e2e-google-authorized" },
    });
    expect(imported.ok(), await imported.text()).toBe(true);
    const account = ((await imported.json()) as { data: { account: { id: string; group: string; authType: string } } }).data.account;
    expect(account).toMatchObject({ group: "Google 授权", authType: "google" });

    const overview = await request.get("/api/admin/dola");
    expect(overview.ok(), await overview.text()).toBe(true);
    const stored = ((await overview.json()) as { data: { accounts: Array<{ id: string; group: string; authType: string }> } }).data.accounts;
    expect(stored.find((item) => item.id === account.id)).toMatchObject({ group: "Google 授权", authType: "google" });

    await openDolaAccounts(page);
    await page.getByRole("tab", { name: /Google 授权/ }).click();
    await expect(accountRow(page, "e2e-google-authorized")).toBeVisible();
    await expect(accountRow(page, "e2e-google-authorized").getByText("Google 授权").first()).toBeVisible();
    await accountRow(page, "e2e-google-authorized").getByRole("checkbox").check();
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "导出选中 1 个 Cookie TXT" }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^Dola-Google-Cookies-\d{8}\.txt$/);
    expect(await readFile(await download.path(), "utf8")).toBe("session=e2e-google-authorized; uid=901\n");
    for (const width of [390, 430]) {
        await page.setViewportSize({ width, height: 844 });
        const exportButton = page.getByRole("button", { name: "导出选中 1 个 Cookie TXT" });
        await expect(exportButton).toBeVisible();
        const bounds = await exportButton.boundingBox();
        expect(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width, `viewport ${width}: ${JSON.stringify(bounds)}`).toBe(true);
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    let importedAuthType = "";
    await page.route("**/api/admin/dola/accounts", async (route) => {
        if (route.request().method() === "POST") {
            const body = route.request().postDataJSON() as { items: Array<{ authType?: string }> };
            importedAuthType = body.items[0]?.authType || "";
        }
        await route.continue();
    });
    await page.getByRole("button", { name: "导入 Cookie" }).click();
    const importModal = page.getByRole("dialog", { name: "导入 Dola Cookie 账号" });
    await importModal.locator('input[type="file"]').setInputFiles({ name: download.suggestedFilename(), mimeType: "text/plain", buffer: await readFile(await download.path()) });
    await expect(importModal.getByText("已解析 1 条", { exact: false })).toBeVisible();
    await importModal.getByRole("button", { name: "开始导入" }).click();
    await expect(importModal).toBeHidden();
    expect(importedAuthType).toBe("google");
});

test("浏览器授权返回未登录 Cookie 时拒绝保存账号", async ({ request }) => {
    const response = await request.post("/api/admin/dola/accounts/google-login", { data: { name: "e2e-premature-google" } });
    expect(response.ok()).toBe(false);
    expect(await response.text()).toContain("尚未通过登录检测");
    const overview = await request.get("/api/admin/dola");
    expect(overview.ok()).toBe(true);
    const accounts = ((await overview.json()) as { data: { accounts: Array<{ name: string }> } }).data.accounts;
    expect(accounts.some((account) => account.name === "e2e-premature-google")).toBe(false);
});

test("网页远程 Google 授权保存账号后关闭浏览器会话", async ({ page, request }) => {
    await openDolaAccounts(page);
    await page.getByRole("button", { name: "Google 授权登录" }).click();
    const setup = page.getByRole("dialog", { name: "添加 Dola Google 授权账号" });
    await setup.getByPlaceholder(/Google 账号 01/).fill("e2e-remote-google");
    await setup.getByRole("button", { name: "启动 Google 授权" }).click();
    const remote = page.getByRole("dialog", { name: "Dola Google 远程授权" });
    await expect(remote.getByText("请在画面中完成 Google 与 Dola 登录")).toBeVisible();
    await expect(remote.getByAltText("Dola 账号实际页面")).toBeVisible();
    for (const width of [390, 430]) {
        await page.setViewportSize({ width, height: 844 });
        await expect.poll(async () => {
            const bounds = await remote.boundingBox();
            return Boolean(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width);
        }, { message: `远程授权弹窗应完整位于 ${width}px 视口内` }).toBe(true);
        await expect(remote.getByRole("button", { name: "检测登录并保存账号" })).toBeVisible();
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await remote.getByAltText("Dola 账号实际页面").click();
    await remote.getByPlaceholder(/粘贴或输入文字/).fill("example");
    await remote.getByRole("button", { name: "发送文字" }).click();
    await remote.getByRole("button", { name: "检测登录并保存账号" }).click();
    await expect(remote).toBeHidden();
    await page.getByRole("tab", { name: /Google 授权/ }).click();
    await expect(accountRow(page, "e2e-remote-google").getByText("登录有效")).toBeVisible();
    const accountsResponse = await request.get("/api/admin/dola");
    const accounts = ((await accountsResponse.json()) as { data: { accounts: Array<{ id: string; name: string }> } }).data.accounts;
    const accountId = accounts.find((item) => item.name === "e2e-remote-google")?.id;
    expect(accountId).toBeTruthy();
    const exported = await request.post(`/api/admin/dola/accounts/${accountId}/export-cookie`);
    const exportedCookie = ((await exported.json()) as { data: { cookie: string } }).data.cookie;
    expect(exportedCookie).toBe(`session=e2e-ready-google-cookie; padding=${"a".repeat(1000)}`);
    const state = await request.get(`http://127.0.0.1:${process.env.DREAMYO_PROTOCOL_FIXTURE_PORT || 4010}/__state`);
    const requests = ((await state.json()) as { requests: Array<{ path: string }> }).requests;
    expect(requests.some((item) => item.path.includes("/google-finalize"))).toBe(true);
    expect(requests.some((item) => item.path.includes("/verifications/") && item.path.endsWith("/close"))).toBe(true);
});

test("取消网页远程 Google 授权会关闭浏览器会话", async ({ page, request }) => {
    const before = await request.get(`http://127.0.0.1:${process.env.DREAMYO_PROTOCOL_FIXTURE_PORT || 4010}/__state`);
    const prior = ((await before.json()) as { requests: Array<{ path: string }> }).requests.filter((item) => item.path.includes("/verifications/") && item.path.endsWith("/close")).length;
    await openDolaAccounts(page);
    await page.getByRole("button", { name: "Google 授权登录" }).click();
    await page.getByRole("dialog", { name: "添加 Dola Google 授权账号" }).getByRole("button", { name: "启动 Google 授权" }).click();
    const remote = page.getByRole("dialog", { name: "Dola Google 远程授权" });
    await expect(remote.getByAltText("Dola 账号实际页面")).toBeVisible();
    await remote.getByRole("button", { name: "取消授权" }).click();
    const confirmation = page.getByRole("dialog", { name: "结束 Google 授权" });
    await confirmation.getByRole("button", { name: "不保存，关闭浏览器" }).click();
    await expect(remote).toBeHidden();
    const after = await request.get(`http://127.0.0.1:${process.env.DREAMYO_PROTOCOL_FIXTURE_PORT || 4010}/__state`);
    const closed = ((await after.json()) as { requests: Array<{ path: string }> }).requests.filter((item) => item.path.includes("/verifications/") && item.path.endsWith("/close")).length;
    expect(closed).toBeGreaterThan(prior);
});

test("已关闭的 Google 授权会话再次关闭不报错", async ({ request }) => {
    const started = await request.post("/api/admin/dola/accounts/google-login/session", { data: { timeoutSeconds: 180 } });
    expect(started.ok()).toBe(true);
    const { verificationId, leaseToken } = ((await started.json()) as { data: { verificationId: string; leaseToken: string } }).data;
    const path = `/api/admin/dola/verifications/${verificationId}/close`;
    const first = await request.post(path, { data: { leaseToken } });
    expect(first.ok(), await first.text()).toBe(true);
    const second = await request.post(path, { data: { leaseToken } });
    expect(second.ok()).toBe(true);
    expect(((await second.json()) as { data: { status: string } }).data.status).toBe("closed");
});

test("本机授权入口显示独立浏览器操作并在取消时释放会话", async ({ page }) => {
    const verificationId = "e2e-native-google-session";
    const leaseToken = "e2e-native-google-lease-token";
    let closeCalls = 0;
    let requestedSelection: unknown;
    await page.route("**/api/admin/dola/accounts/google-login/session", async (route) => {
        requestedSelection = route.request().postDataJSON()?.proxySelection;
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ code: 0, data: { mode: "native", verificationId, leaseToken }, msg: "已打开本机授权浏览器" }) });
    });
    await page.route(`**/api/admin/dola/verifications/${verificationId}/close`, async (route) => {
        closeCalls++;
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ code: 0, data: { status: "closed" }, msg: "授权浏览器已关闭" }) });
    });
    await openDolaAccounts(page);
    await page.getByRole("button", { name: "Google 授权登录" }).click();
    const setup = page.getByRole("dialog", { name: "添加 Dola Google 授权账号" });
    await expect(setup.getByText("跟随 Dola 当前配置")).toBeVisible();
    for (const width of [390, 430]) {
        await page.setViewportSize({ width, height: 844 });
        await expect.poll(async () => {
            const bounds = await setup.boundingBox();
            return Boolean(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width);
        }, { message: `Google 授权弹窗应完整位于 ${width}px 视口内` }).toBe(true);
    }
    await setup.getByText("直连", { exact: true }).click();
    await setup.getByRole("button", { name: "启动 Google 授权" }).click();
    expect(requestedSelection).toEqual({ mode: "direct" });
    const native = page.getByRole("dialog", { name: "Dola Google 本机授权" });
    await expect(native.getByText("请直接在本机 Camoufox 窗口登录")).toBeVisible();
    await native.getByRole("button", { name: "不保存，关闭浏览器" }).click();
    await expect(native).toBeHidden();
    expect(closeCalls).toBe(1);
});

test("账号池展示来源分类与 Google 授权标注", async ({ page }) => {
    const google = await page.request.post("/api/admin/dola/accounts", {
        data: { items: [{ cookie: "session=e2e-google-cookie; uid=201", name: "e2e-google", authType: "google", sourceFileName: "e2e.txt", sourceOrdinal: 1 }] },
    });
    expect(google.ok(), await google.text()).toBe(true);
    await openDolaAccounts(page);
    await page.getByRole("tab", { name: /Google 授权/ }).click();
    await expect(accountRow(page, "e2e-google")).toBeVisible();
    await expect(accountRow(page, "e2e-google").getByText("Google 授权").first()).toBeVisible();
    await expect(accountRow(page, "e2e-ready")).toHaveCount(0);
    await page.getByRole("tab", { name: /全部/ }).click();
    await expect(accountRow(page, "e2e-ready")).toBeVisible();
    await expect(accountRow(page, "e2e-google")).toBeVisible();
});

test("Google 授权登录弹窗支持浏览器与手动两种模式", async ({ page }) => {
    await openDolaAccounts(page);
    await page.getByRole("button", { name: "Google 授权登录" }).click();
    const modal = page.getByRole("dialog");
    await expect(modal.getByText("授权流程说明")).toBeVisible();
    await expect(modal.getByRole("button", { name: "启动 Google 授权" })).toBeVisible();
    // antd v6 会在下拉里渲染隐藏的 a11y listbox（role=option 不可点），必须在可见下拉容器内按文本点击
    const dropdown = page.locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden)");
    await modal.getByRole("combobox").click();
    await dropdown.getByText("录入已有 Google 授权 Session / Cookie").click();
    await expect(modal.getByPlaceholder(/Cookie: name=value/)).toBeVisible();
    await expect(modal.getByRole("button", { name: "确认添加" })).toBeVisible();
    await modal.getByRole("button", { name: /取\s*消/ }).click();
    await expect(modal).toBeHidden();
});

test("通信测试弹窗支持有头切换与凭据来源选择", async ({ page }) => {
    await openDolaAccounts(page);
    await page.getByRole("button", { name: "通信测试" }).click();
    const modal = page.getByRole("dialog");
    await expect(modal.getByRole("button", { name: "提交一次测试" })).toBeVisible();
    await modal.getByRole("switch").click();
    await expect(modal.getByRole("button", { name: "启动有头浏览器测试" })).toBeVisible();
    await expect(modal.getByText(/有头浏览器 \(Headed\)/)).toBeVisible();
    // antd v6 会在下拉里渲染隐藏的 a11y listbox（role=option 不可点），必须在可见下拉容器内按文本点击
    const dropdown = page.locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden)");
    await modal.getByRole("combobox").first().click();
    await dropdown.getByText("指定已有账号", { exact: true }).click();
    await expect(modal.locator("label", { hasText: "选择要测试的账号" })).toBeVisible();
    await modal.getByRole("combobox").first().click();
    await dropdown.getByText("临时自定义 Cookie (独立沙箱不入库)").click();
    await expect(modal.getByPlaceholder(/粘贴测试 Cookie/)).toBeVisible();
    await modal.getByRole("button", { name: /取\s*消/ }).click();
    await expect(modal).toBeHidden();
});

test("请求日志行内有头测试预填指定账号并有头模式", async ({ page }) => {
    await openDolaAccounts(page);
    await page.getByRole("tab", { name: "请求日志" }).click();
    const failedRow = page.getByRole("button").filter({ hasText: "e2e-boom" }).first();
    await expect(failedRow).toBeVisible();
    await failedRow.getByRole("button", { name: "有头测试" }).click();
    const modal = page.getByRole("dialog");
    await expect(modal.getByText(/有头浏览器 \(Headed\)/)).toBeVisible();
    await expect(modal.getByRole("button", { name: "启动有头浏览器测试" })).toBeVisible();
    await expect(modal.getByText("选择要测试的账号")).toBeVisible();
    await modal.getByRole("button", { name: /取\s*消/ }).click();
});
