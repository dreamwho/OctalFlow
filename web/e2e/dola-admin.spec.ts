import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const READY_COOKIE = "session=e2e-ready-cookie; uid=101";
const EXPIRED_COOKIE = "session=e2e-expired-cookie; uid=102";
const BOOM_COOKIE = "session=e2e-boom-cookie; uid=103";
const REFRESH_ROUTE = /\/api\/admin\/dola\/accounts\/[^/]+\/refresh$/;

async function openDolaAccounts(page: Page) {
    // 本地手动实例的 RSC 再校验会误判匿名并跳转登录页（与被测改动无关）；阻断 RSC 请求保持初始渲染
    await page.route(/_rsc/, (route) => route.abort());
    await page.goto("/admin?section=dolaApi", { waitUntil: "domcontentloaded" });
    await expect(page.locator(".admin-dashboard-shell[data-hydrated='true']")).toBeVisible();
    await expect(page.getByRole("button", { name: "检测全部登录状态" })).toBeVisible();
}

function accountRow(page: Page, name: string) {
    return page.getByRole("row", { name: new RegExp(name) });
}

test("导入的账号以待验证状态进入账号池并展示中文状态", async ({ page, request }) => {
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
    await expect(accountRow(page, "e2e-ready").getByText("未验证").first()).toBeVisible();
    await expect(accountRow(page, "e2e-expired").getByText("未验证").first()).toBeVisible();
    await expect(accountRow(page, "e2e-boom").getByText("未验证").first()).toBeVisible();
    await expect(accountRow(page, "e2e-ready").getByText("登录未检测")).toBeVisible();
});

test("检测 Cookie 有效的账号展示等待动画、可用状态与额度", async ({ page }) => {
    await openDolaAccounts(page);
    await page.route(REFRESH_ROUTE, async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 600));
        await route.continue();
    });
    const row = accountRow(page, "e2e-ready");
    const checkButton = row.getByRole("button", { name: "协议验证" });
    await checkButton.click();
    await expect(checkButton).toHaveClass(/ant-btn-loading/);
    await expect(page.getByText("检测完成：登录、页面签名与只读协议均已通过")).toBeVisible();
    await expect(row.getByText("可用")).toBeVisible();
    await expect(row.getByText("登录有效")).toBeVisible();
    await expect(row.getByText("5/100")).toBeVisible();
    await page.unroute(REFRESH_ROUTE);
});

test("检测 Cookie 失效的账号标记登录失效并清空额度", async ({ page }) => {
    await openDolaAccounts(page);
    const row = accountRow(page, "e2e-expired");
    await row.getByRole("button", { name: "协议验证" }).click();
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
    await expect(accountRow(page, "e2e-ready").getByRole("button", { name: "协议验证" })).toHaveClass(/ant-btn-loading/);
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

test("通信测试经 Provider 提交并可查询到完成状态", async ({ page }) => {
    await openDolaAccounts(page);
    await page.getByRole("button", { name: "通信测试" }).click();
    const modal = page.getByRole("dialog");
    await modal.getByRole("button", { name: "提交一次测试" }).click();
    await expect(page.getByText("测试请求已提交")).toBeVisible();
    await expect(modal.getByText("状态：submitted")).toBeVisible({ timeout: 15_000 });
    await modal.getByRole("button", { name: "查询状态" }).click();
    await expect(modal.getByText("状态：completed")).toBeVisible({ timeout: 15_000 });
});

test("后台主按钮保持标准紧凑尺寸", async ({ page }) => {
    await openDolaAccounts(page);
    const button = page.getByRole("button", { name: "通信测试" });
    const box = await button.boundingBox();
    expect(box).toBeTruthy();
    // 旧的 octal-theme 52px 大按钮回归会被此处拦下
    expect(box!.height).toBeLessThan(40);
});

test("账号池展示来源分类与 Google 授权标注", async ({ page }) => {
    const google = await page.request.post("/api/admin/dola/accounts", {
        data: { items: [{ cookie: "session=e2e-google-cookie; uid=201", name: "e2e-google", authType: "google", sourceFileName: "e2e.txt", sourceOrdinal: 1 }] },
    });
    expect(google.ok(), await google.text()).toBe(true);
    await openDolaAccounts(page);
    await page.getByRole("tab", { name: /Google 授权/ }).click();
    await expect(accountRow(page, "e2e-google")).toBeVisible();
    await expect(accountRow(page, "e2e-google").getByText("Google 授权")).toBeVisible();
    await expect(accountRow(page, "e2e-ready")).toHaveCount(0);
    await page.getByRole("tab", { name: /Cookie 导入/ }).click();
    await expect(accountRow(page, "e2e-ready")).toBeVisible();
    await expect(accountRow(page, "e2e-google")).toHaveCount(0);
});

test("Google 授权登录弹窗支持浏览器与手动两种模式", async ({ page }) => {
    await openDolaAccounts(page);
    await page.getByRole("button", { name: "Google 授权登录" }).click();
    const modal = page.getByRole("dialog");
    await expect(modal.getByText("授权流程说明")).toBeVisible();
    await expect(modal.getByRole("button", { name: "启动浏览器并授权" })).toBeVisible();
    // antd v6 会在下拉里渲染隐藏的 a11y listbox（role=option 不可点），必须在可见下拉容器内按文本点击
    const dropdown = page.locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden)");
    await modal.getByRole("combobox").click();
    await dropdown.getByText("录入已有 Google 授权 Session / Cookie").click();
    await expect(modal.getByPlaceholder(/粘贴由 Google 登录提取/)).toBeVisible();
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
