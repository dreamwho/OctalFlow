import { expect, test, type Locator, type Page } from "@playwright/test";

const tabLabels = ["账号与渠道", "反代网关与 API 密钥", "魔法代理", "请求日志"] as const;
const chatGptTabLabels = [...tabLabels, "统计报表", "代理管理", "IPWO 配置"];

async function setTheme(page: Page, theme: "light" | "dark") {
    if (page.url() === "about:blank") await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.evaluate((nextTheme) => localStorage.setItem("octalaicanvas:admin_theme_store", JSON.stringify({ state: { theme: nextTheme }, version: 0 })), theme);
    await page.reload({ waitUntil: "domcontentloaded" });
    if (theme === "dark") await expect(page.locator("html")).toHaveClass(/dark/);
    else await expect(page.locator("html")).not.toHaveClass(/dark/);
}

async function expectWithinViewport(page: Page, locator: Locator) {
    await expect(locator).toBeVisible();
    const [bounds, viewport] = await Promise.all([
        locator.evaluate((element) => {
            const rect = element.getBoundingClientRect();
            return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
        }),
        page.evaluate(() => ({ width: document.documentElement.clientWidth, height: window.innerHeight })),
    ]);
    expect(bounds.width).toBeGreaterThan(0);
    expect(bounds.height).toBeGreaterThan(0);
    expect(bounds.left).toBeGreaterThanOrEqual(-1);
    expect(bounds.right).toBeLessThanOrEqual(viewport.width + 1);
    expect(bounds.top).toBeGreaterThanOrEqual(-1);
    expect(bounds.bottom).toBeLessThanOrEqual(viewport.height + 1);
}

async function expectNoHorizontalOverflow(page: Page) {
    const bounds = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
    expect(bounds.scroll).toBeLessThanOrEqual(bounds.width + 1);
}

async function expectModalWithinViewport(page: Page) {
    await expect(page.getByRole("dialog").last()).toBeVisible();
    await expectWithinViewport(page, page.locator(".ant-modal:visible").last());
}

test("GPTAPI preserves drafts, submits async account work, and stays responsive", async ({ page, request }, testInfo) => {
    const fixtureId = String(Math.floor(Date.now() / 1000)) + "_" + testInfo.workerIndex;
    const registration = await request.post("/api/auth/register", {
        data: {
            username: "chatgpt_fixture_" + fixtureId,
            displayName: "Fixture 管理员",
            password: "FixtureOnly!2026",
            installToken: "chatgpt-api-fixture-install-token-32chars",
        },
    });
    expect(registration.ok(), await registration.text()).toBe(true);
    await page.context().addCookies((await request.storageState()).cookies);

    let gatewayEnabled = false;
    let logFinished = false;
    let selected: string[] = [];
    let keys: Array<{ id: string; name: string; enabled: boolean }> = [];
    let accountReads = 0;
    let settingsReads = 0;
    const importedPayloads: Array<Record<string, unknown>> = [];
    let releaseBulk: (() => void) | undefined;
    const mutations: string[] = [];
    const progressChecks = new Map<string, number>();
    let proxyGroups: Array<Record<string, unknown>> = [];
    let proxyDefaults = { default_reference: { mode: "direct" }, fallback_reference: null } as Record<string, unknown>;
    let allQuotaRefresh = false;
    let proxySelection = { enabled: false, mode: "native", native_source: "manual" };
    let failProxySave = false;
    let ipwoSettings = { configured: false, has_api_url: false, protocol: "http", regions: "US", timeout_seconds: 30 };
    let ipwoTests = 0;
    const magicBindings = { geminiai: { enabled: false, node: "" }, geminiTools: { enabled: false, node: "" }, chatgptApi: { enabled: false, node: "Fixture 魔法节点" } };

    await page.route("**/api/admin/settings", async (route) => {
        if (route.request().method() !== "GET") return route.fallback();
        settingsReads += 1;
        await route.fulfill({
            json: {
                settings: {
                    systemChannels: [{ id: "fixture-chatgpt-channel" }],
                    logicalModels: [{ id: "fixture-text" }],
                    defaultModels: { chat: "fixture-text" },
                },
            },
        });
    });
    await page.route("**/api/admin/chatgpt-api/**", async (route) => {
        const url = new URL(route.request().url());
        const endpoint = url.pathname.split("/chatgpt-api/")[1];
        const method = route.request().method();
        const body = method === "GET" ? {} : (route.request().postDataJSON() as Record<string, unknown>);
        if (method !== "GET") mutations.push(method + " " + endpoint);

        let data: unknown;
        if (endpoint === "proxy-selection") {
            if (method === "PATCH" && failProxySave) {
                failProxySave = false;
                await route.fulfill({ status: 503, json: { code: 503, msg: "代理配置保存失败（隔离夹具）" } });
                return;
            }
            if (method === "PATCH") proxySelection = { ...proxySelection, ...body };
            data = { ...proxySelection, magicConfigured: true, ipwoConfigured: ipwoSettings.configured };
        } else if (endpoint === "ipwo") {
            if (method === "PATCH") {
                expect(body).not.toHaveProperty("password");
                ipwoSettings = { ...ipwoSettings, protocol: String(body.protocol), regions: String(body.regions), timeout_seconds: Number(body.timeout_seconds), configured: true, has_api_url: true };
            }
            data = ipwoSettings;
        } else if (endpoint === "ipwo/test") {
            ipwoTests++;
            await route.fulfill({
                contentType: "application/x-ndjson",
                body:
                    [
                        { stage: "配置校验", status: "success", message: "已读取加密配置", elapsed_ms: 1 },
                        { stage: "API 提取", status: "success", message: "已提取 1 个代理 IP", elapsed_ms: 30 },
                        ipwoTests === 1
                            ? { stage: "proxy_egress", status: "success", message: "测试完成（隔离夹具）", elapsed_ms: 150, exit_ip: "203.0.113.10", done: true }
                            : { stage: "proxy_egress", status: "error", message: "ipinfo.io [curl 56] CONNECT HTTP 407：代理要求身份认证，请检查代理使用授权", elapsed_ms: 150, done: true },
                    ]
                        .map((event) => JSON.stringify(event))
                        .join("\n") + "\n",
            });
            return;
        } else if (endpoint === "accounts") {
            if (method === "GET") {
                accountReads += 1;
                data = {
                    items: [
                        {
                            id: "fixture-account",
                            email: "fixture@example.test",
                            display_name: "Fixture",
                            source_plan_label: "Web / Plus",
                            status_label: "正常",
                            status_reason: "账号已启用，当前凭据可调用",
                            enabled: true,
                            quota_label: "10",
                            success_count: 1,
                            failure_count: 0,
                        },
                    ],
                    total: 1,
                };
            } else if (method === "POST") {
                expect(Buffer.byteLength(route.request().postData() || "")).toBeLessThanOrEqual(64 * 1024);
                importedPayloads.push(body);
                if (JSON.stringify(body).includes("fixture-bulk-0x"))
                    await new Promise<void>((resolve) => {
                        releaseBulk = resolve;
                    });
                data = { added: Array.isArray(body.accounts) ? body.accounts.length : 1, skipped: 0, synced: 0, errors: [], updated_ids: ["fixture-account"], removed_ids: [], status_label: "已完成", tone: "success" };
            } else if (method === "DELETE") {
                data = { progress_id: "fixture-delete-progress" };
            } else throw new Error("Unexpected accounts method " + method);
        } else if (endpoint === "accounts/batch-update") data = { progress_id: "fixture-account-toggle-progress" };
        else if (endpoint === "accounts/refresh") {
            allQuotaRefresh = (body.selection as { mode?: string } | undefined)?.mode === "all";
            if (allQuotaRefresh) expect(body).toEqual({ selection: { mode: "all" } });
            else expect(body).toEqual({ account_ids: ["fixture-account"] });
            data = { progress_id: allQuotaRefresh ? "fixture-all-refresh-progress" : "fixture-account-refresh-progress" };
        } else if (endpoint.startsWith("accounts/operations/")) {
            const progressId = decodeURIComponent(endpoint.slice("accounts/operations/".length));
            const checks = (progressChecks.get(progressId) || 0) + 1;
            progressChecks.set(progressId, checks);
            if (progressId === "fixture-import-progress") {
                data =
                    checks === 1
                        ? { total: 1, processed: 0, done: false, stage: "prepare_accounts", stage_label: "正在准备 1 个账号", status_label: "正在准备 1 个账号", tone: "info", message: "正在准备 1 个账号", error: null, events: [] }
                        : { total: 1, processed: 1, done: true, stage: "completed", stage_label: "已完成", status_label: "已完成", tone: "success", message: "任务完成 · 新增 1", error: null, events: [] };
            } else if (progressId === "fixture-account-refresh-progress") {
                data =
                    checks === 1
                        ? { total: 1, processed: 0, done: false, status_label: "正在刷新", tone: "info", message: "正在刷新额度", error: null, events: [] }
                        : { total: 1, processed: 1, done: true, stage: "completed", stage_label: "失败", status_label: "失败", tone: "danger", message: "额度刷新失败", error: "额度刷新失败", events: [] };
            } else if (progressId === "fixture-all-refresh-progress") {
                if (checks === 2) {
                    await route.fulfill({ status: 503, json: { code: 503, msg: "隔离夹具：进度连接中断" } });
                    return;
                }
                data = checks === 1 ? { total: 50, processed: 25, done: false, tone: "info", message: "刷新全部额度中" } : { total: 50, processed: 50, done: true, tone: "success", message: "全部额度刷新完成", status_label: "已完成" };
            } else throw new Error("Unexpected account progress " + progressId);
        } else if (endpoint === "model-catalog") data = { chat_models: ["fixture-text"], image_models: ["fixture-image"], source: { chat: "config", image: "config" } };
        else if (endpoint === "models") {
            if (method === "PUT") selected = body.models as string[];
            data = { models: selected };
        } else if (endpoint === "gateway") {
            if (method === "PATCH") gatewayEnabled = body.enabled === true;
            data = { enabled: gatewayEnabled };
        } else if (endpoint === "keys") {
            if (method === "POST") {
                keys = [{ id: "fixture-key-id", name: String(body.name), enabled: true }];
                data = { item: keys[0], raw_key: "fixture-only-created-secret" };
            } else data = { items: keys };
        } else if (endpoint.startsWith("keys/")) {
            const keyId = decodeURIComponent(endpoint.slice("keys/".length));
            if (method === "DELETE") keys = keys.filter((key) => key.id !== keyId);
            else if (method === "POST") keys = keys.map((key) => (key.id === keyId ? { ...key, enabled: body.enabled === true } : key));
            else throw new Error("Unexpected key method " + method);
            data = { item: keys.find((key) => key.id === keyId) || null };
        } else if (endpoint === "statistics")
            data = {
                time_range: url.searchParams.get("time_range"),
                runtime: {
                    runtime_mode: "native",
                    instance_name: "fixture-runtime",
                    distribution: "Fixture OS",
                    kernel_version: "1.0",
                    architecture: "arm64",
                    python_version: "3.14",
                    cpu_capacity: 8,
                    service_started_at: "2026-09-08T12:00:00",
                    service_uptime_seconds: 3600,
                    process_cpu_percent: 5,
                    process_memory_bytes: 104857600,
                    process_memory_percent: 2,
                    memory_scope: "system",
                    memory_percent: 40,
                    storage_percent: 20,
                    network_rx_bytes_per_sec: null,
                    network_tx_bytes_per_sec: null,
                },
                totals: { total: 3, success: 2, final_failed: 1, success_rate: 66.67, avg_success_duration_ms: 1200 },
                switching: { requests: 1, count: 2, recovered: 1, recovery_rate: 100 },
                buckets: Array.from({ length: 24 }, (_, index) => ({ label: `${String(index).padStart(2, "0")}:00`, start_at: `2026-09-08T${String(index).padStart(2, "0")}:00:00`, total_calls: index === 0 ? 3 : 0, success_calls: index === 0 ? 2 : 0, final_failed_calls: index === 0 ? 1 : 0 })),
                trend: { labels: ["12:00"], model_success_requests: { "fixture-text": [2] }, model_avg_success_duration_ms: { "fixture-text": [1200] } },
            };
        else if (endpoint === "proxies") data = { revision: "fixture", ...proxyDefaults, effective_default: { label: "直连" }, effective_fallback: { label: "关闭" }, groups: proxyGroups };
        else if (endpoint === "proxies/defaults") {
            proxyDefaults = body;
            data = body;
        } else if (endpoint === "proxies/groups") {
            const existing = proxyGroups.find((group) => group.id === body.id);
            const group = {
                ...existing,
                ...body,
                id: body.id || "fixture-proxy-group",
                can_delete: true,
                references: [],
                nodes: Array.isArray(body.nodes) ? body.nodes.map((node, index) => ({ ...node, id: node.id || `fixture-node-${index}`, url: "", health: { state: "unknown" } })) : existing?.nodes || [],
            };
            proxyGroups = [...proxyGroups.filter((item) => item.id !== group.id), group];
            data = { group };
        } else if (endpoint === "proxies/groups/test") data = { summary: { message: "代理测试完成（隔离夹具）" }, results: [{ node_id: "fixture-node-0", result: { ok: true, latency_ms: 70, error: null } }] };
        else if (endpoint === "proxies/nodes/import") data = { nodes: [{ url: "http://fixture:secret@127.0.0.1:8123", image_concurrency_limit: 30 }], invalid_count: 0, duplicate_count: 0 };
        else if (endpoint.startsWith("proxies/groups/") && method === "DELETE") {
            proxyGroups = [];
            data = { deleted_id: "fixture-proxy-group" };
        } else if (endpoint === "logs") data = { items: allQuotaRefresh ? [{ id: "fixture-quota-log", model: "账号额度刷新", presentation: { summary_text: logFinished ? "全部账号额度刷新 · 已完成" : "全部账号额度刷新 · 执行中" } }] : [], total: allQuotaRefresh ? 1 : 0 };
        else if (endpoint === "logs/fixture-quota-log") data = {
            id: "fixture-quota-log", model: "quota_refresh", endpoint: "/api/accounts/refresh",
            display_status: logFinished ? "success" : "running",
            presentation: { status: { label: logFinished ? "成功" : "执行中" } },
            started_at: "2026-09-08 12:00:00", ended_at: logFinished ? "2026-09-08 12:00:03" : "",
            request_text: "隔离请求详情内容",
            request_meta: { lifecycle: [{ time: "2026-09-08 12:00:00", status: "running", message: "等待上游返回" }, ...(logFinished ? [{ time: "2026-09-08 12:00:03", status: "success", message: "额度刷新结束" }] : [])] },
        };
        else throw new Error("Unexpected fixture route " + endpoint);
        await route.fulfill({ json: { code: 0, data, msg: "" } });
    });
    await page.route("**/api/admin/magic-proxy", async (route) => {
        if (route.request().method() === "PATCH") {
            const body = route.request().postDataJSON();
            const provider = body.provider as keyof typeof magicBindings;
            magicBindings[provider] = { ...magicBindings[provider], ...body };
        }
        await route.fulfill({ json: { code: 0, data: { configured: true, runtimeAvailable: true, nodeCount: 1, nodes: [{ name: "Fixture 魔法节点", type: "ss" }], groups: [], bindings: magicBindings } } });
    });
    await page.route("**/api/admin/gemini-tools", (route) =>
        route.fulfill({
            json: {
                code: 0,
                data: {
                    configured: true,
                    healthy: true,
                    accounts: [],
                    apiKeys: [],
                    gateway: { enabled: true, strategy: "round_robin", sessionStickiness: false },
                    logs: { items: [], total: 0, page: 1, pageSize: 50 },
                    models: [],
                },
                msg: "",
            },
        }),
    );

    await page.goto("/admin?section=chatgptApi", { waitUntil: "domcontentloaded" });
    await expect(page.getByText("fixture@example.test", { exact: true })).toBeVisible();
    await expect(page.getByText("账号已启用，当前凭据可调用", { exact: true })).toHaveCount(0);
    expect(await page.getByText("fixture@example.test", { exact: true }).evaluate((node) => parseFloat(getComputedStyle(node).fontSize))).toBeGreaterThanOrEqual(16);

    const imageModel = page.getByRole("checkbox", { name: "fixture-image", exact: true });
    await imageModel.check();
    await page.getByRole("tab", { name: "反代网关与 API 密钥", exact: true }).click();
    await expect(page.locator("[data-chatgpt-api-tab-panel='overview']")).toBeHidden();
    await page.getByRole("tab", { name: "账号与渠道", exact: true }).click();
    await expect(imageModel).toBeChecked();

    const settingsBeforeSave = settingsReads;
    await page.getByRole("button", { name: "同步至渠道与逻辑模型" }).click();
    await expect.poll(() => selected).toEqual(["fixture-image"]);
    await expect.poll(() => settingsReads).toBeGreaterThan(settingsBeforeSave);
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByRole("checkbox", { name: "fixture-image", exact: true })).toBeChecked();

    const accountReadsBeforeImport = accountReads;
    await page.getByRole("button", { name: "导入账号" }).click();
    await page.getByRole("tab", { name: "粘贴凭据", exact: true }).click();
    await page.getByRole("textbox", { name: "账号凭据" }).fill("fixture-access-token");
    await page
        .getByRole("dialog")
        .getByRole("button", { name: /导\s*入/ })
        .click();
    const accountOperation = page.locator("[data-chatgpt-account-operation]");
    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(page.getByText("账号导入已完成：新增 1 个，更新/跳过 0 个，失败 0 个", { exact: true })).toBeVisible();
    expect(importedPayloads).toEqual([{ tokens: ["fixture-access-token"], sync_after_import: false }]);
    await expect.poll(() => accountReads).toBeGreaterThan(accountReadsBeforeImport);
    await expect(accountOperation).toHaveCount(0);

    const accountReadsBeforeFailedRefresh = accountReads;
    await page.getByRole("button", { name: "刷新额度" }).click();
    await expect(accountOperation).toContainText("账号额度刷新");
    await expect.poll(() => accountReads).toBeGreaterThan(accountReadsBeforeFailedRefresh);
    await expect(accountOperation).toContainText("失败");
    await expect(accountOperation).toContainText("额度刷新失败");
    await page.getByRole("button", { name: "关闭待确认账号操作" }).click();

    await page.getByRole("button", { name: "刷新全部额度", exact: true }).click();
    await expect(accountOperation).toContainText("已处理 25 / 50");
    await expect(accountOperation.getByRole("progressbar")).toBeVisible();
    await expect(accountOperation).toContainText("任务仍可能在执行");
    await expect(page.getByRole("button", { name: "刷新全部额度", exact: true })).toBeDisabled();
    const quotaSubmissions = mutations.filter((value) => value === "POST accounts/refresh").length;
    await accountOperation.getByRole("button", { name: "恢复进度连接", exact: true }).click();
    await expect(accountOperation).toContainText("全部额度刷新完成");
    expect(mutations.filter((value) => value === "POST accounts/refresh")).toHaveLength(quotaSubmissions);
    await page.getByRole("tab", { name: "请求日志", exact: true }).click();
    await expect(page.getByText("全部账号额度刷新 · 执行中", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "查看详情", exact: true }).click();
    const logDrawer = page.getByRole("dialog", { name: "请求日志详情" });
    await expect(logDrawer).toContainText("执行中");
    await expect(logDrawer).toContainText("隔离请求详情内容");
    logFinished = true;
    await expect(logDrawer).toContainText("额度刷新结束");
    for (const width of [1440, 390, 430]) {
        await page.setViewportSize({ width, height: 900 });
        await logDrawer.getByText("请求 ID", { exact: true }).click({ trial: true });
        await expectWithinViewport(page, page.locator(".ant-drawer-content-wrapper:visible"));
        await expectNoHorizontalOverflow(page);
        await page.screenshot({ path: testInfo.outputPath(`gptapi-log-detail-${width}.png`) });
    }
    await logDrawer.getByRole("button", { name: "关闭", exact: true }).click();
    await expect(logDrawer).toBeHidden();
    await expect(page.getByText("全部账号额度刷新 · 已完成", { exact: true })).toBeVisible();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole("tab", { name: "账号与渠道", exact: true }).click();
    await page.getByRole("button", { name: "关闭待确认账号操作" }).click();

    await page.getByRole("button", { name: "导入账号" }).click();
    await page.getByRole("tab", { name: "文件导入", exact: true }).click();
    const fileInput = page.getByLabel("账号 JSON 文件");
    const submitFiles = page.getByRole("dialog").getByRole("button", { name: /^导\s*入$/ });
    await fileInput.setInputFiles({ name: "invalid.json", mimeType: "application/json", buffer: Buffer.from('{"access_token":"hidden-fixture-secret"') });
    await expect(page.getByRole("dialog")).toContainText("不是有效的 JSON 文件");
    await expect(submitFiles).toBeDisabled();
    await expect(page.getByRole("dialog")).not.toContainText("hidden-fixture-secret");
    const fileAccounts = Array.from({ length: 10 }, (_, index) => ({ access_token: "fixture-file-at-" + index, refresh_token: "fixture-file-rt-" + index, email: "file" + index + "@example.test" }));
    const jsonFiles = fileAccounts.flatMap((account, index) => [
        { name: "cpa-" + index + ".json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ ...account, proxy: "must-not-import" })) },
        { name: "sub2api-" + index + ".json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ accounts: [{ credentials: account }], proxies: [] })) },
    ]);
    await fileInput.setInputFiles(jsonFiles);
    await expect(page.getByRole("dialog")).toContainText("已选择 20 个文件，识别 10 个账号，去重 10 个");
    expect(importedPayloads).toHaveLength(1);
    await expect(page.getByRole("dialog")).not.toContainText("fixture-file-at-");
    await submitFiles.click();
    await expect.poll(() => importedPayloads.length).toBe(2);
    expect(importedPayloads[1]).toEqual({ accounts: fileAccounts, sync_after_import: false });
    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(page.getByText("账号导入已完成：新增 10 个，更新/跳过 0 个，失败 0 个", { exact: true })).toBeVisible();
    await expect(accountOperation).toHaveCount(0);

    await page.getByRole("button", { name: "导入账号" }).click();
    const fiftyAccounts = Array.from({ length: 50 }, (_, index) => ({ access_token: "fixture-bulk-" + index + "x".repeat(2500), refresh_token: "fixture-rt-" + index }));
    await fileInput.setInputFiles(fiftyAccounts.map((account, index) => ({ name: `bulk-${index}.json`, mimeType: "application/json", buffer: Buffer.from(JSON.stringify(account)) })));
    await expect(page.getByRole("dialog")).toContainText("识别 50 个账号");
    await expect(submitFiles).toBeEnabled();
    await submitFiles.click();
    await expect.poll(() => Boolean(releaseBulk)).toBe(true);
    await expect(page.getByRole("dialog").getByRole("status")).toContainText("已确认 0/50 个");
    await expect(page.getByRole("dialog").getByRole("button", { name: /取\s*消/ })).toBeDisabled();
    releaseBulk!();
    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(page.getByText("账号导入已完成：新增 50 个，更新/跳过 0 个，失败 0 个", { exact: true })).toBeVisible();
    expect(importedPayloads.slice(2).length).toBeGreaterThan(1);
    expect(importedPayloads.slice(2).flatMap((body) => body.accounts)).toEqual(fiftyAccounts);

    await page.getByRole("tab", { name: "反代网关与 API 密钥", exact: true }).click();
    const gatewaySwitch = page.getByRole("switch", { name: "启用 ChatGPT 网关" });
    await expect(gatewaySwitch).toBeVisible();
    await gatewaySwitch.click();
    await expect(gatewaySwitch).toBeChecked();
    await page.getByRole("button", { name: "创建密钥", exact: true }).click();
    await page.getByRole("textbox", { name: "密钥名称" }).fill("Fixture key");
    await page
        .getByRole("dialog")
        .getByRole("button", { name: /创\s*建/ })
        .click();
    await expect(page.getByRole("textbox", { name: "新建 API 密钥" })).toHaveValue("fixture-only-created-secret");
    await page.getByRole("button", { name: "已保存，关闭" }).click();
    await expect(page.getByRole("textbox", { name: "新建 API 密钥" })).not.toBeVisible();
    await page.getByRole("switch", { name: "启用密钥 Fixture key" }).click();
    await expect(page.getByRole("switch", { name: "启用密钥 Fixture key" })).not.toBeChecked();
    await page
        .locator("[data-chatgpt-api-tab-panel='gateway']")
        .getByRole("button", { name: /删\s*除/ })
        .click();
    await page
        .getByRole("button", { name: /删\s*除/ })
        .last()
        .click();
    await expect(page.getByText("尚未创建 API 密钥", { exact: true })).toBeVisible();

    await page.getByRole("tab", { name: "代理管理", exact: true }).click();
    await expect(page.getByText("暂无代理组", { exact: true })).toBeVisible();
    await page.getByRole("switch", { name: "使用代理管理", exact: true }).click();
    await expect(page.getByRole("switch", { name: "使用代理管理", exact: true })).toBeChecked();
    await page.getByRole("tab", { name: "魔法代理", exact: true }).click();
    await page.getByRole("switch", { name: "使用魔法代理", exact: true }).click();
    await expect(page.getByRole("switch", { name: "使用魔法代理", exact: true })).toBeChecked();
    expect(proxySelection).toMatchObject({ enabled: true, mode: "magic" });
    await page.getByRole("tab", { name: "代理管理", exact: true }).click();
    await expect(page.getByRole("switch", { name: "使用代理管理", exact: true })).not.toBeChecked();
    await page.getByRole("switch", { name: "使用代理", exact: true }).click();
    await expect(page.getByRole("switch", { name: "使用代理", exact: true })).not.toBeChecked();
    expect(proxySelection).toMatchObject({ enabled: false, mode: "magic" });
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByRole("switch", { name: "使用代理", exact: true })).not.toBeChecked();
    await page.getByRole("tab", { name: "代理管理", exact: true }).click();
    failProxySave = true;
    await page.getByRole("switch", { name: "使用代理管理", exact: true }).click();
    await expect(page.getByText("代理配置保存失败（隔离夹具）", { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("switch", { name: "使用代理管理", exact: true })).not.toBeChecked();
    expect(proxySelection.enabled).toBe(false);
    await page.getByRole("button", { name: "新建代理组", exact: true }).click();
    await page.getByRole("textbox", { name: "代理组名称", exact: true }).fill("Fixture 代理组");
    await page.getByRole("button", { name: "批量导入节点", exact: true }).click();
    await page.getByRole("textbox", { name: "代理节点批量内容", exact: true }).fill("http://fixture:secret@127.0.0.1:8123 30");
    await page.getByRole("button", { name: "解析并添加", exact: true }).click();
    await expect(page.getByLabel("节点 1 代理地址", { exact: true })).toHaveValue("http://fixture:secret@127.0.0.1:8123");
    await page.getByRole("textbox", { name: "节点 1 名称", exact: true }).fill("Fixture 节点");
    await page
        .getByRole("dialog")
        .getByRole("button", { name: /^保\s*存$/ })
        .click();
    await expect(page.getByRole("heading", { name: "Fixture 代理组", exact: true })).toBeVisible();
    const proxyPanel = page.locator("[data-chatgpt-proxy-manager]");
    await proxyPanel.getByRole("button", { name: "测试代理组", exact: true }).click();
    await expect(page.getByText("代理测试完成（隔离夹具）", { exact: true })).toBeVisible();
    await expect(proxyPanel.getByText("可用", { exact: true })).toBeVisible();
    await proxyPanel.getByRole("button", { name: "测试节点", exact: true }).click();
    await proxyPanel.getByRole("button", { name: /^编\s*辑$/ }).click();
    await expect(page.getByLabel("节点 1 代理地址", { exact: true })).toHaveValue("");
    await page
        .getByRole("dialog")
        .getByRole("button", { name: /^保\s*存$/ })
        .click();
    await page.getByRole("combobox", { name: "默认出口", exact: true }).click();
    await page.getByTitle("已保存代理组", { exact: true }).click();
    await page.getByRole("combobox", { name: "默认出口代理组", exact: true }).click();
    await page.getByTitle("Fixture 代理组", { exact: true }).click();
    await page.getByRole("button", { name: "保存出口", exact: true }).click();
    await expect.poll(() => proxyDefaults.default_reference).toEqual({ mode: "group", group_id: "fixture-proxy-group" });
    await page.getByRole("tab", { name: "统计报表", exact: true }).click();
    await expect(page.getByText("模型成功量与耗时", { exact: true })).toBeVisible();
    await page.getByText("7 天", { exact: true }).click();
    await expect(page.getByText("平均成功耗时", { exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "运行环境", exact: true })).toContainText("fixture-runtime");
    await page.getByRole("region", { name: "调用活跃度", exact: true }).getByRole("button").first().click();
    await expect(page.getByRole("tooltip")).toContainText("总计 3，成功 2，最终失败 1");
    await page.getByRole("heading", { name: "运行环境", exact: true }).click();
    await page.getByRole("region", { name: "运行环境", exact: true }).screenshot({ path: testInfo.outputPath("statistics-runtime-desktop.png") });

    await page.getByRole("tab", { name: "IPWO 配置", exact: true }).click();
    await expect(page.getByRole("button", { name: "测试 IPWO 连接", exact: true })).toBeDisabled();
    await page.getByLabel("IPWO API 提取链接", { exact: true }).fill("https://www.ipwo.net/api/proxy/get_proxy_ip?num=100&regions=US&protocol=http&return_type=txt");
    await page.getByRole("button", { name: "保存 IPWO 配置", exact: true }).click();
    await expect(page.getByLabel("IPWO API 提取链接", { exact: true })).toHaveValue("");
    expect(ipwoTests).toBe(0);
    await page.getByRole("switch", { name: "使用IPWO代理", exact: true }).click();
    await expect(page.getByRole("switch", { name: "使用IPWO代理", exact: true })).toBeChecked();
    expect(proxySelection).toMatchObject({ enabled: true, mode: "native", native_source: "ipwo" });
    await page.getByRole("button", { name: "测试 IPWO 连接", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "IPWO 连接测试 · 过程日志" })).toBeVisible();
    await expect(page.getByRole("log", { name: "IPWO 测试日志" })).toContainText("已提取 1 个代理 IP");
    await expect(page.getByRole("log", { name: "IPWO 测试日志" })).toContainText("203.0.113.10");
    expect(ipwoTests).toBe(1);
    await expectModalWithinViewport(page);
    await page.screenshot({ path: testInfo.outputPath("ipwo-test-desktop.png"), animations: "disabled" });
    await page
        .getByRole("dialog")
        .getByRole("button", { name: /^关\s*闭$/ })
        .click();

    await page.getByRole("tab", { name: "魔法代理", exact: true }).click();
    await expect(page.getByRole("switch", { name: "使用魔法代理", exact: true })).not.toBeChecked();
    await page.getByRole("switch", { name: "使用代理", exact: true }).click();
    await expect(page.getByRole("switch", { name: "使用代理", exact: true })).not.toBeChecked();

    for (const width of [1440, 390, 430]) {
        await page.setViewportSize({ width, height: 932 });
        for (const theme of ["light", "dark"] as const) {
            await setTheme(page, theme);
            await expect(page.getByText("fixture@example.test", { exact: true })).toBeVisible();
            const tabList = page.getByRole("tablist");
            await expectWithinViewport(page, tabList);
            for (const label of chatGptTabLabels) {
                const tab = page.getByRole("tab", { name: label, exact: true });
                await tab.click();
                await expect(tab).toHaveAttribute("aria-selected", "true");
                await expectWithinViewport(page, tab);
                if (label === "统计报表") {
                    await expect(page.getByText("模型成功量与耗时", { exact: true })).toBeVisible();
                    const heatmap = page.getByRole("region", { name: "调用活跃度", exact: true });
                    await heatmap.getByRole("button").first().click();
                    await expect(page.getByRole("tooltip")).toContainText("总计 3");
                    await expectNoHorizontalOverflow(page);
                    await heatmap.screenshot({ path: testInfo.outputPath(`statistics-activity-${width}-${theme}.png`) });
                }
                if (label === "代理管理") {
                    await expect(page.getByRole("heading", { name: "Fixture 代理组", exact: true })).toBeVisible();
                    await expect(page.getByRole("button", { name: "刷新代理", exact: true })).toBeEnabled();
                }
                if (label === "请求日志") {
                    await page.getByRole("button", { name: "查看详情", exact: true }).click();
                    const details = page.getByRole("dialog", { name: "请求日志详情" });
                    await details.getByText("请求 ID", { exact: true }).click({ trial: true });
                    await expectWithinViewport(page, page.locator(".ant-drawer-content-wrapper:visible"));
                    await details.screenshot({ path: testInfo.outputPath(`log-detail-${width}-${theme}.png`) });
                    await details.getByRole("button", { name: "关闭", exact: true }).click();
                    await expect(details).toBeHidden();
                }
                await page.screenshot({ path: testInfo.outputPath("chatgpt-" + width + "-" + theme + "-" + chatGptTabLabels.indexOf(label) + ".png"), animations: "disabled" });
            }
            await expectNoHorizontalOverflow(page);
            await page.screenshot({ path: testInfo.outputPath("chatgpt-" + width + "-" + theme + ".png") });
        }
    }

    await page.setViewportSize({ width: 390, height: 844 });
    await setTheme(page, "dark");
    await expect(page.getByText("fixture@example.test", { exact: true })).toBeVisible();
    await page.getByRole("tab", { name: "IPWO 配置", exact: true }).click();
    await page.getByRole("button", { name: "测试 IPWO 连接", exact: true }).click();
    await expectModalWithinViewport(page);
    await expect(page.getByRole("log", { name: "IPWO 测试日志" })).toContainText("ipinfo.io [curl 56] CONNECT HTTP 407：代理要求身份认证，请检查代理使用授权");
    await page.getByRole("dialog").evaluate(async (element) => {
        await Promise.all(
            element
                .getAnimations({ subtree: true })
                .filter((animation) => Number.isFinite(animation.effect?.getComputedTiming().endTime))
                .map((animation) => animation.finished.catch(() => undefined)),
        );
    });
    await expectWithinViewport(page, page.getByRole("log", { name: "IPWO 测试日志" }));
    await page.getByRole("log", { name: "IPWO 测试日志" }).click({ trial: true });
    await page.screenshot({ path: testInfo.outputPath("ipwo-test-mobile.png") });
    await page
        .getByRole("dialog")
        .getByRole("button", { name: /^关\s*闭$/ })
        .click();
    await page.getByRole("tab", { name: "代理管理", exact: true }).click();
    await page
        .locator("[data-chatgpt-proxy-manager]")
        .getByRole("button", { name: /^编\s*辑$/ })
        .click();
    await expectModalWithinViewport(page);
    await page.getByRole("button", { name: "添加节点", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "节点 2 名称", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "删除节点 2", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "节点 2 名称", exact: true })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("proxy-editor-mobile.png"), animations: "disabled" });
    await page
        .getByRole("dialog")
        .getByRole("button", { name: /^取\s*消$/ })
        .click();
    await page.getByRole("tab", { name: "账号与渠道", exact: true }).click();
    await page.getByRole("button", { name: "导入账号" }).click();
    await expectModalWithinViewport(page);
    await expect(page.getByRole("button", { name: "选择 JSON 文件" })).toBeVisible();
    await page.getByLabel("账号 JSON 文件").setInputFiles(jsonFiles);
    await expect(page.getByRole("dialog")).toContainText("识别 10 个账号");
    await expect(page.getByRole("dialog")).not.toHaveClass(/ant-zoom-(appear|enter|leave)/);
    await page.screenshot({ path: testInfo.outputPath("account-file-import-mobile.png"), animations: "disabled" });
    await page
        .getByRole("dialog")
        .getByRole("button", { name: /取\s*消/ })
        .click();
    await page.getByRole("button", { name: "导入账号" }).click();
    await expect(page.getByRole("dialog")).not.toContainText("已选择 20 个文件");
    await page
        .getByRole("dialog")
        .getByRole("button", { name: /取\s*消/ })
        .click();

    await page.getByRole("tab", { name: "反代网关与 API 密钥", exact: true }).click();
    await page.getByRole("button", { name: "创建密钥", exact: true }).click();
    await expectModalWithinViewport(page);
    await page.getByRole("textbox", { name: "密钥名称" }).fill("Mobile fixture key");
    await page
        .getByRole("dialog")
        .getByRole("button", { name: /创\s*建/ })
        .click();
    await expect(page.getByRole("textbox", { name: "新建 API 密钥" })).toHaveValue("fixture-only-created-secret");
    await expectModalWithinViewport(page);
    await page.getByRole("button", { name: "已保存，关闭" }).click();

    await page.setViewportSize({ width: 1440, height: 932 });
    await setTheme(page, "light");
    await page.goto("/admin?section=geminiTools", { waitUntil: "domcontentloaded" });
    await page.getByRole("tab", { name: "魔法代理", exact: true }).click();
    await expect(page.locator("[data-gemini-tools-tab-panel='magic-proxy']")).toBeVisible();
    await expect(page.getByText("GeminiTools · 魔法代理", { exact: true })).toBeVisible();
    await page.getByRole("tab", { name: "反代网关与 API 密钥", exact: true }).click();
    await expect(page.locator("[data-gemini-tools-tab-panel='gateway']")).toBeVisible();
    await expect(page.getByText("API 密钥", { exact: true })).toBeVisible();
    for (const width of [1440, 390, 430]) {
        await page.setViewportSize({ width, height: 932 });
        for (const theme of ["light", "dark"] as const) {
            await setTheme(page, theme);
            for (const label of tabLabels) {
                const tab = page.getByRole("tab", { name: label, exact: true });
                await tab.click();
                await expectWithinViewport(page, tab);
            }
            await expectNoHorizontalOverflow(page);
            await page.screenshot({ path: testInfo.outputPath("gemini-" + width + "-" + theme + ".png") });
        }
    }

    expect(mutations).toEqual(expect.arrayContaining(["PUT models", "POST accounts", "PATCH gateway", "POST keys", "POST keys/fixture-key-id", "DELETE keys/fixture-key-id"]));
});
