import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";

import type { AdminRequestTrafficReport, AdminTrafficSummary, AdminTrafficTaskReport, RequestTrafficSummary, TrafficItem } from "../src/lib/admin-traffic-types";
import { formatTrafficBytes, type TrafficDisplayUnit } from "../src/lib/traffic-format";

type TrafficFilter = {
    start: string;
    end: string;
    channelId?: string;
    model?: string;
    connectionMode?: string;
    port?: number;
};

type SettingsChannel = { id: string; name?: string };
type TrafficFixtureBytes = { uploadBytes: number; downloadBytes: number; totalBytes: number };
type TrafficFixtureRoute = { mode: string; port: number; payloadBytes: number; rawBytes: TrafficFixtureBytes; wireAudit?: { connectionCount?: number } };
type TrafficFixtureRequest = TrafficFixtureBytes & { routes: Record<string, TrafficFixtureRoute> };
type TrafficFixtureManifest = { meterPorts?: Record<string, number>; rawExpected?: Record<string, TrafficFixtureRequest>; payloadExpected?: Record<string, TrafficFixtureBytes> };

const modelLabels: Record<string, string> = {
    __shared_browser__: "共享浏览器流量",
    __unattributed__: "未归属模型",
};

const connectionModeLabels: Record<string, string> = {
    direct: "直连",
    generic: "通用代理",
    magic: "魔法代理",
    chained: "链式代理",
    unknown: "未标记",
};

function envText(name: string) {
    return process.env[name]?.trim() || "";
}

async function readTrafficFixtureManifest() {
    const path = envText("DREAMYO_TRAFFIC_E2E_MANIFEST_PATH") || envText("DREAMYO_TRAFFIC_E2E_FIXTURE_MANIFEST") || envText("DREAMYO_TRAFFIC_FIXTURE_MANIFEST");
    if (!path) throw new Error("真实 Dola 流量回归必须提供隔离 fixture manifest：DREAMYO_TRAFFIC_E2E_MANIFEST_PATH");
    return JSON.parse(await readFile(path, "utf8")) as TrafficFixtureManifest;
}

function modelLabel(value: string) {
    return modelLabels[value] || value.trim() || "未归属模型";
}

function connectionModeLabel(item: TrafficItem) {
    const mode = item.connectionMode.trim().toLowerCase();
    if (item.model === "__shared_browser__" && mode === "unknown") return "共享代理（按端口）";
    if (!mode && !item.model.trim()) return "共享连接";
    return connectionModeLabels[mode] || "未标记";
}

function displayedBytes(value: number, unit: TrafficDisplayUnit) {
    const formatted = formatTrafficBytes(value, unit);
    return `${formatted.value} ${formatted.unit}`;
}

function trafficPanel(root: Page | Locator, title = "全局流量统计") {
    return root.locator("section.admin-panel-surface").filter({ hasText: title }).first();
}

async function setAdminTheme(page: Page, request: APIRequestContext, site: Record<string, unknown>, theme: "light" | "dark") {
    const response = await request.patch("/api/admin/settings", { data: { site: { ...site, adminTheme: theme } } });
    expect(response.ok(), await response.text()).toBe(true);
    await page.reload({ waitUntil: "domcontentloaded" });
    if (theme === "dark") await expect(page.locator("html")).toHaveClass(/dark/);
    else await expect(page.locator("html")).not.toHaveClass(/dark/);
}

async function openTrafficUnitSetting(page: Page) {
    await page.goto("/admin?section=settings", { waitUntil: "domcontentloaded" });
    const tab = page.getByRole("tab", { name: "数据维护", exact: true });
    await expect(tab).toBeVisible();
    await tab.click();
    const section = page.locator("#admin-settings-lifecycle");
    await expect(section).toBeVisible();
    await expect(section.getByTestId("admin-traffic-display-unit")).toBeVisible();
    return section;
}

async function setTrafficDisplayUnit(page: Page, request: APIRequestContext, unit: TrafficDisplayUnit) {
    const section = await openTrafficUnitSetting(page);
    const label = unit === "GB" ? "GB（十进制）" : "MB（十进制）";
    const group = section.getByTestId("admin-traffic-display-unit");
    const selected = group.locator(".ant-radio-button-wrapper-checked").filter({ hasText: label });
    if ((await selected.count()) === 0) {
        const responsePromise = page.waitForResponse((response) => response.url().includes("/api/admin/settings") && response.request().method() === "PATCH");
        await group.getByText(label, { exact: true }).click();
        const response = await responsePromise;
        const responseText = await response.text();
        expect(response.ok(), responseText).toBe(true);
        const payload = JSON.parse(responseText) as { settings?: { trafficUnit?: string } };
        expect(payload.settings?.trafficUnit).toBe(unit);
    }

    const persisted = await request.get("/api/admin/settings");
    const persistedText = await persisted.text();
    expect(persisted.ok(), persistedText).toBe(true);
    const persistedPayload = JSON.parse(persistedText) as { settings?: { trafficUnit?: string } };
    expect(persistedPayload.settings?.trafficUnit).toBe(unit);

    await page.reload({ waitUntil: "domcontentloaded" });
    const reloadedSection = page.locator("#admin-settings-lifecycle");
    await expect(page.getByRole("tab", { name: "数据维护", exact: true })).toBeVisible();
    await page.getByRole("tab", { name: "数据维护", exact: true }).click();
    await expect(reloadedSection.getByTestId("admin-traffic-display-unit").locator(".ant-radio-button-wrapper-checked").filter({ hasText: label })).toBeVisible();
}

async function setTrafficViewport(page: Page) {
    if (test.info().project.name === "chromium") await page.setViewportSize({ width: 1440, height: 932 });
}

async function expectNoHorizontalOverflow(page: Page) {
    const bounds = await page.evaluate(() => ({ clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth }));
    expect(bounds.scrollWidth).toBeLessThanOrEqual(bounds.clientWidth + 1);
}

async function expectRangePickerFitsViewport(page: Page, panel: Locator) {
    const picker = panel.locator(".ant-picker-range").first();
    await expect(picker).toBeVisible();
    const [bounds, viewport] = await Promise.all([picker.boundingBox(), page.evaluate(() => ({ width: document.documentElement.clientWidth, height: window.innerHeight }))]);
    expect(bounds?.width || 0).toBeGreaterThan(0);
    expect(bounds?.x || 0).toBeGreaterThanOrEqual(-1);
    expect((bounds?.x || 0) + (bounds?.width || 0)).toBeLessThanOrEqual(viewport.width + 1);
    expect((bounds?.y || 0) + (bounds?.height || 0)).toBeLessThanOrEqual(viewport.height + 1);
    expect(bounds?.width || 0).toBeLessThanOrEqual(viewport.width - 16);
    await expect(picker.locator("input").first()).toBeVisible();
    await picker.locator("input").first().click();
    const dropdown = page.locator(".ant-picker-dropdown:visible").last();
    await expect(dropdown).toBeVisible();
    const [dropdownBounds, dropdownViewport] = await Promise.all([dropdown.boundingBox(), page.evaluate(() => ({ width: document.documentElement.clientWidth, height: window.innerHeight }))]);
    expect(dropdownBounds?.width || 0).toBeGreaterThan(0);
    expect(dropdownBounds?.x || 0).toBeGreaterThanOrEqual(-1);
    expect((dropdownBounds?.x || 0) + (dropdownBounds?.width || 0)).toBeLessThanOrEqual(dropdownViewport.width + 1);
    expect(dropdownBounds?.y || 0).toBeGreaterThanOrEqual(-1);
    expect((dropdownBounds?.y || 0) + (dropdownBounds?.height || 0)).toBeLessThanOrEqual(dropdownViewport.height + 1);
    await page.keyboard.press("Escape");
}

async function saveTrafficEvidence(page: Page, panel: Locator, theme: "light" | "dark", testInfo: { outputPath: (path: string) => string }) {
    const measurement = await panel.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const picker = element.querySelector<HTMLElement>(".ant-picker-range")?.getBoundingClientRect();
        return {
            viewport: { width: document.documentElement.clientWidth, height: window.innerHeight },
            theme: document.documentElement.classList.contains("dark") ? "dark" : "light",
            panel: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            rangePicker: picker ? { x: picker.x, y: picker.y, width: picker.width, height: picker.height } : null,
            overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        };
    });
    const stem = `traffic-${measurement.viewport.width}-${theme}`;
    await page.screenshot({ path: testInfo.outputPath(`${stem}.png`), animations: "disabled" });
    await writeFile(testInfo.outputPath(`${stem}.json`), `${JSON.stringify(measurement, null, 2)}\n`, "utf8");
}

async function currentRange(panel: Locator) {
    const footer = panel.getByText(/当前筛选：/).last();
    await expect(footer).toBeVisible();
    const value = (await footer.textContent()) || "";
    const match = value.match(/当前筛选：(.+?) 至 (.+?)（/);
    if (!match) throw new Error(`无法读取流量统计时间范围：${value}`);
    return { start: match[1], end: match[2] };
}

async function readTraffic(request: APIRequestContext, filter: TrafficFilter) {
    const params = new URLSearchParams({ start: filter.start, end: filter.end });
    for (const [key, value] of Object.entries(filter)) {
        if (key === "start" || key === "end" || value === undefined || value === "") continue;
        params.set(key, String(value));
    }
    const response = await request.get(`/api/admin/traffic?${params}`);
    const text = await response.text();
    return { response, text, payload: response.ok() ? (JSON.parse(text) as { data: AdminTrafficSummary }) : null };
}

async function readTaskTraffic(request: APIRequestContext, filter: TrafficFilter) {
    const params = new URLSearchParams({ start: filter.start, end: filter.end, page: "1", pageSize: "20" });
    for (const [key, value] of Object.entries(filter)) {
        if (key === "start" || key === "end" || value === undefined || value === "") continue;
        params.set(key, String(value));
    }
    const response = await request.get(`/api/admin/traffic/tasks?${params}`);
    const text = await response.text();
    return { response, text, payload: response.ok() ? (JSON.parse(text) as { data: AdminTrafficTaskReport }) : null };
}

async function readRequestTraffic(request: APIRequestContext, requestId: string, taskId: string) {
    const response = await request.post("/api/admin/traffic/requests", { data: { requestIds: [requestId], taskIds: [taskId] } });
    const text = await response.text();
    return { response, text, payload: response.ok() ? (JSON.parse(text) as { data: AdminRequestTrafficReport }) : null };
}

function trafficTotals(items: TrafficItem[]) {
    return items.reduce(
        (totals, item) => ({
            uploadBytes: totals.uploadBytes + item.uploadBytes,
            downloadBytes: totals.downloadBytes + item.downloadBytes,
            totalBytes: totals.totalBytes + item.totalBytes,
        }),
        { uploadBytes: 0, downloadBytes: 0, totalBytes: 0 },
    );
}

function assertTrafficTotals(actual: Pick<RequestTrafficSummary, "uploadBytes" | "downloadBytes" | "totalBytes">, expected: Pick<RequestTrafficSummary, "uploadBytes" | "downloadBytes" | "totalBytes">, label: string) {
    expect(actual.uploadBytes, `${label} 上行`).toBe(expected.uploadBytes);
    expect(actual.downloadBytes, `${label} 下行`).toBe(expected.downloadBytes);
    expect(actual.totalBytes, `${label} 合计`).toBe(expected.totalBytes);
}

function configuredTrafficCorrelation() {
    return {
        taskId: envText("DREAMYO_TRAFFIC_E2E_TASK_ID") || envText("DREAMYO_TRAFFIC_E2E_TASK_IMAGE_ID") || "e2e-task-image",
        requestId: envText("DREAMYO_TRAFFIC_E2E_REQUEST_ID") || envText("DREAMYO_TRAFFIC_E2E_REQUEST_IMAGE_ID") || "e2e-request-image",
    };
}

function taskTrafficPanel(root: Page | Locator) {
    return root.locator("section.admin-panel-surface").filter({ hasText: "任务 / 请求流量" }).first();
}

function dolaRequestLogCard(page: Page) {
    return page.locator(".ant-card").filter({ hasText: "请求日志" }).last();
}

async function openDolaRequestLogs(page: Page) {
    await page.goto("/admin?section=dolaApi", { waitUntil: "domcontentloaded" });
    const tab = page.getByRole("tab", { name: "请求日志", exact: true });
    await expect(tab).toBeVisible();
    await tab.click();
    const card = dolaRequestLogCard(page);
    await expect(card.getByText("请求日志", { exact: true }).first()).toBeVisible();
    return card;
}

async function assertDolaLogTrafficSummary(card: Locator, expected: TrafficFixtureBytes, unit: TrafficDisplayUnit) {
    const row = card.locator("button").filter({ hasText: "e2e-image" }).filter({ hasText: "e2e-task-image" }).first();
    await expect(row).toBeVisible();
    await expect(row).toContainText("/v1/images");
    await expect(row).toContainText("fixture组 · fixture账号");
    const summary = row.getByTestId("request-traffic-summary");
    await expect(summary).toBeVisible();
    await expect(summary).toContainText(`↑ ${displayedBytes(expected.uploadBytes, unit)}`);
    await expect(summary).toContainText(`↓ ${displayedBytes(expected.downloadBytes, unit)}`);
    await expect(summary).toContainText(`合计 ${displayedBytes(expected.totalBytes, unit)}`);
    return row;
}

async function assertDolaLogTrafficDetail(detail: Locator, report: AdminRequestTrafficReport, manifest: TrafficFixtureManifest, expected: TrafficFixtureRequest, payloadExpected: TrafficFixtureBytes, unit: TrafficDisplayUnit) {
    const summary = report.items.find((item) => item.requestId === "e2e-request-image");
    expect(summary, "请求流量报告缺少 e2e-request-image").toBeTruthy();
    expect(summary).toMatchObject({ uploadBytes: expected.uploadBytes, downloadBytes: expected.downloadBytes, totalBytes: expected.totalBytes });
    expect(payloadExpected).toEqual(expect.objectContaining({ uploadBytes: expect.any(Number), downloadBytes: expect.any(Number), totalBytes: expect.any(Number) }));
    expect(payloadExpected.totalBytes).not.toBe(expected.totalBytes);

    const directExpected = expected.routes.upload;
    const chainedExpected = expected.routes.submit;
    const directMeterPort = manifest.meterPorts?.direct ?? directExpected.port;
    const chainedMeterPort = manifest.meterPorts?.chained ?? chainedExpected.port;
    expect(directExpected?.wireAudit?.connectionCount).toBe(1);
    expect(chainedExpected?.wireAudit?.connectionCount).toBe(1);
    const directUpload = summary!.items.find((item) => item.role === "upload" && item.connectionMode === directExpected.mode && item.port === directMeterPort);
    const chainedSubmit = summary!.items.find((item) => item.role === "submit" && item.connectionMode === chainedExpected.mode && item.port === chainedMeterPort);
    expect(directUpload, "请求流量报告缺少独立 rawExpected 直连上传明细").toMatchObject(directExpected.rawBytes);
    expect(chainedSubmit, "请求流量报告缺少独立 rawExpected 链式提交明细").toMatchObject(chainedExpected.rawBytes);
    expect(directExpected.payloadBytes).toBe(896);
    expect(chainedExpected.payloadBytes).toBe(11);
    expect(chainedExpected.rawBytes.uploadBytes).toBeGreaterThan(chainedExpected.payloadBytes);

    const rows = detail.locator("tbody tr");
    const directRow = rows.filter({ hasText: "直连" }).filter({ hasText: "上传" }).first();
    const chainedRow = rows.filter({ hasText: "链式代理" }).filter({ hasText: "提交" }).first();
    await expect(directRow).toBeVisible();
    await expect(chainedRow).toBeVisible();
    await expect(directRow.locator("td").nth(1)).toHaveText("直连");
    await expect(directRow.locator("td").nth(2)).toHaveText(`${directUpload!.address}:${directMeterPort ? directMeterPort : "直连"}`);
    await expect(directRow.locator("td").nth(3)).toHaveText("上传");
    await expect(directRow.locator("td").nth(4)).toHaveText(displayedBytes(directExpected.rawBytes.uploadBytes, unit));
    await expect(directRow.locator("td").nth(5)).toHaveText(displayedBytes(directExpected.rawBytes.downloadBytes, unit));
    await expect(chainedRow.locator("td").nth(1)).toHaveText("链式代理");
    await expect(chainedRow.locator("td").nth(2)).toHaveText(`${chainedSubmit!.address}:${chainedMeterPort ? chainedMeterPort : "直连"}`);
    await expect(chainedRow.locator("td").nth(3)).toHaveText("提交");
    await expect(chainedRow.locator("td").nth(4)).toHaveText(displayedBytes(chainedExpected.rawBytes.uploadBytes, unit));
    await expect(chainedRow.locator("td").nth(5)).toHaveText(displayedBytes(chainedExpected.rawBytes.downloadBytes, unit));
}

function isMeterUnavailable(status: number, text: string) {
    return status === 503 && /流量计量|traffic.?meter|尚未配置/i.test(text);
}

function configuredTarget() {
    const port = envText("DREAMYO_TRAFFIC_E2E_PORT");
    return {
        channelId: envText("DREAMYO_TRAFFIC_E2E_CHANNEL_ID"),
        channelName: envText("DREAMYO_TRAFFIC_E2E_CHANNEL_NAME"),
        model: envText("DREAMYO_TRAFFIC_E2E_MODEL"),
        connectionMode: envText("DREAMYO_TRAFFIC_E2E_CONNECTION_MODE"),
        port: port === "" ? undefined : Number(port),
    };
}

function matchesTarget(item: TrafficItem, target: ReturnType<typeof configuredTarget>) {
    return (
        (!target.channelId || item.channelId === target.channelId) &&
        (!target.channelName || item.channelName === target.channelName) &&
        (!target.model || item.model === target.model) &&
        (!target.connectionMode || item.connectionMode === target.connectionMode) &&
        (target.port === undefined || item.port === target.port)
    );
}

function assertTargetOptions(summary: AdminTrafficSummary, target: TrafficItem) {
    expect(summary.options.channels.some((channel) => channel.id === target.channelId)).toBe(true);
    expect(summary.options.models).toContain(target.model);
    expect(summary.options.connectionModes).toContain(target.connectionMode);
}

async function chooseSelectOption(page: Page, panel: Locator, placeholder: string, label: string) {
    const control = panel.locator(".ant-select").filter({ hasText: placeholder }).first();
    await expect(control).toBeVisible();
    const response = page.waitForResponse((item) => item.url().includes("/api/admin/traffic?") && item.request().method() === "GET");
    await control.click();
    const dropdown = page.locator(".ant-select-dropdown:visible").last();
    const option = dropdown.locator(".ant-select-item-option-content").filter({ hasText: label }).first();
    await expect(option).toBeVisible();
    await option.click();
    await response;
}

async function fillPort(page: Page, panel: Locator, port: number) {
    const input = panel.locator('input[placeholder="全部端口"]');
    await expect(input).toBeVisible();
    const response = page.waitForResponse((item) => item.url().includes("/api/admin/traffic?") && item.request().method() === "GET");
    await input.click();
    await input.fill(String(port));
    await input.press("Tab");
    await response;
    await expect(input).toHaveValue(String(port));
}

async function assertSummaryCards(panel: Locator, summary: AdminTrafficSummary) {
    const values: Array<[string, number]> = [
        ["上行", summary.uploadBytes],
        ["下行", summary.downloadBytes],
        ["合计", summary.totalBytes],
    ];
    const cards = panel.locator('div[class*="grid-cols-1"][class*="sm:grid-cols-3"]').first();
    await expect(cards).toBeVisible();
    for (const [label, value] of values) {
        const card = cards.getByText(label, { exact: true }).locator("xpath=..");
        if (value === 0 && summary.items.length === 0 && !summary.coverage?.every((item) => ["ok", "available", "complete"].includes(item.status))) {
            await expect(card).toContainText("—");
        } else {
            await expect(card).toContainText(displayedBytes(value, summary.displayUnit || "MB"));
        }
    }
}

test.describe.configure({ mode: "serial" });

test("管理员首页展示全局流量统计入口并适配双主题视口", async ({ page, request }, testInfo) => {
    await setTrafficViewport(page);
    await page.goto("/admin?section=overview", { waitUntil: "domcontentloaded" });
    await expect(page.locator(".admin-dashboard-shell[data-hydrated='true']")).toBeVisible();
    const settingsResponse = await request.get("/api/admin/settings");
    expect(settingsResponse.ok(), await settingsResponse.text()).toBe(true);
    const settingsPayload = (await settingsResponse.json()) as { settings?: { site?: Record<string, unknown> } };
    const site = { ...(settingsPayload.settings?.site || {}) };
    const originalTheme = site.adminTheme === "light" ? "light" : "dark";

    try {
        for (const theme of ["light", "dark"] as const) {
            await setAdminTheme(page, request, site, theme);
            const panel = trafficPanel(page);
            await expect(panel.getByRole("heading", { name: "全局流量统计", exact: true })).toBeVisible();
            await expectRangePickerFitsViewport(page, panel);
            await expectNoHorizontalOverflow(page);
            await saveTrafficEvidence(page, panel, theme, testInfo);
        }
    } finally {
        await setAdminTheme(page, request, site, originalTheme);
    }
});

test("流量显示单位切换立即保存并在 API 与刷新后保持一致", async ({ page, request }) => {
    const initialResponse = await request.get("/api/admin/settings");
    const initialText = await initialResponse.text();
    expect(initialResponse.ok(), initialText).toBe(true);
    const initialSettings = JSON.parse(initialText) as { settings?: { trafficUnit?: string } };
    const originalUnit: TrafficDisplayUnit = initialSettings.settings?.trafficUnit === "GB" ? "GB" : "MB";
    const targetUnit: TrafficDisplayUnit = originalUnit === "GB" ? "MB" : "GB";

    try {
        await setTrafficDisplayUnit(page, request, targetUnit);
    } finally {
        if (targetUnit !== originalUnit) await setTrafficDisplayUnit(page, request, originalUnit);
    }
});

test("真实 TCP 计量可按时间、渠道、模型、模式和端口筛选并显示精确合计", async ({ page, request }) => {
    await setTrafficViewport(page);
    await page.goto("/admin?section=overview", { waitUntil: "domcontentloaded" });
    const panel = trafficPanel(page);
    await expect(panel.getByRole("heading", { name: "全局流量统计", exact: true })).toBeVisible();
    await expect(panel.getByText(/当前筛选：/).last()).toBeVisible();

    const todayRange = await currentRange(panel);
    const todayStart = Date.parse(todayRange.start);
    const quickRangeResponse = page.waitForResponse((item) => item.url().includes("/api/admin/traffic?") && item.request().method() === "GET");
    await panel.getByRole("button", { name: "近 7 天", exact: true }).click();
    await quickRangeResponse;
    const range = await currentRange(panel);
    expect(Date.parse(range.start)).toBeLessThan(todayStart);
    expect(Date.parse(range.end)).toBeGreaterThan(Date.parse(range.start));
    expect(Date.parse(range.end)).toBeLessThanOrEqual(Date.now());
    const initialResult = await readTraffic(request, range);
    if (isMeterUnavailable(initialResult.response.status(), initialResult.text)) {
        test.skip(true, "未配置真实流量计量服务，跳过真实 TCP 流量断言");
    }
    expect(initialResult.response.ok(), initialResult.text).toBe(true);
    const initial = initialResult.payload!.data;
    const targetConfig = configuredTarget();
    const matchingItems = initial.items.filter((item) => matchesTarget(item, targetConfig));
    expect(matchingItems.length, "流量计量夹具未返回 DREAMYO_TRAFFIC_E2E_* 指定的渠道、模型、模式或端口").toBeGreaterThan(0);
    const target = matchingItems.find((item) => item.totalBytes > 0);
    expect(target, "流量计量夹具必须提供至少一条有字节数的真实 TCP 记录").toBeTruthy();
    assertTargetOptions(initial, target!);

    await chooseSelectOption(page, panel, "全部渠道", target!.channelName || target!.channelId);
    await chooseSelectOption(page, panel, "全部模型", modelLabel(target!.model));
    await chooseSelectOption(page, panel, "全部模式", connectionModeLabel(target!));
    await fillPort(page, panel, target!.port);

    const selectedRange = await currentRange(panel);
    const selectedResult = await readTraffic(request, { ...selectedRange, channelId: target!.channelId, model: target!.model, connectionMode: target!.connectionMode, port: target!.port });
    expect(selectedResult.response.ok(), selectedResult.text).toBe(true);
    const selected = selectedResult.payload!.data;
    expect(selected.totalBytes).toBeGreaterThan(0);
    expect(selected.items.some((item) => item.channelId === target!.channelId && item.model === target!.model && item.connectionMode === target!.connectionMode && item.port === target!.port)).toBe(true);
    const expectedUpload = envText("DREAMYO_TRAFFIC_E2E_UPLOAD_BYTES");
    const expectedDownload = envText("DREAMYO_TRAFFIC_E2E_DOWNLOAD_BYTES");
    if (expectedUpload) expect(selected.uploadBytes).toBe(Number(expectedUpload));
    if (expectedDownload) expect(selected.downloadBytes).toBe(Number(expectedDownload));
    await assertSummaryCards(panel, selected);
    const selectedRow = panel
        .locator("tbody tr")
        .filter({ hasText: target!.channelName || target!.channelId })
        .filter({ hasText: modelLabel(target!.model) })
        .filter({ hasText: connectionModeLabel(target!) })
        .first();
    await expect(selectedRow).toBeVisible();
    await expect(selectedRow.getByText(target!.channelName || target!.channelId, { exact: true }).first()).toBeVisible();
    await expect(selectedRow.getByText(modelLabel(target!.model), { exact: true }).first()).toBeVisible();
    await expect(selectedRow.getByText(connectionModeLabel(target!), { exact: true }).first()).toBeVisible();

    const observedPorts = new Set(initial.items.filter((item) => item.channelId === target!.channelId && item.model === target!.model && item.connectionMode === target!.connectionMode).map((item) => item.port));
    const noMatchPort = Array.from({ length: 65_536 }, (_, value) => value).find((value) => !observedPorts.has(value));
    expect(noMatchPort, "真实流量夹具需要保留至少一个未使用端口用于空结果筛选").toBeDefined();
    await fillPort(page, panel, noMatchPort!);
    const emptyRange = await currentRange(panel);
    const emptyResult = await readTraffic(request, { ...emptyRange, channelId: target!.channelId, model: target!.model, connectionMode: target!.connectionMode, port: noMatchPort });
    expect(emptyResult.response.ok(), emptyResult.text).toBe(true);
    const empty = emptyResult.payload!.data;
    expect(empty.uploadBytes).toBe(0);
    expect(empty.downloadBytes).toBe(0);
    expect(empty.totalBytes).toBe(0);
    await expect(panel.getByText("暂无符合条件的流量", { exact: true })).toBeVisible();
    await assertSummaryCards(panel, empty);
    await expectNoHorizontalOverflow(page);
});

test("任务、请求与全局报告按真实关联 ID 对齐并继承 MB/GB 单位", async ({ page, request }) => {
    test.skip(!envText("DREAMYO_TRAFFIC_METER_URL") || !envText("DREAMYO_TRAFFIC_METER_KEY"), "未配置真实流量计量服务，跳过任务与请求报告断言");
    await setTrafficViewport(page);
    await page.goto("/admin?section=overview", { waitUntil: "domcontentloaded" });
    const globalPanel = trafficPanel(page);
    await expect(globalPanel.getByRole("heading", { name: "全局流量统计", exact: true })).toBeVisible();
    const range = await currentRange(globalPanel);
    const correlation = configuredTrafficCorrelation();

    const settingsResponse = await request.get("/api/admin/settings");
    const settingsText = await settingsResponse.text();
    expect(settingsResponse.ok(), settingsText).toBe(true);
    const settingsPayload = JSON.parse(settingsText) as { settings?: { trafficUnit?: string } };
    const originalUnit: TrafficDisplayUnit = settingsPayload.settings?.trafficUnit === "GB" ? "GB" : "MB";

    try {
        for (const unit of ["MB", "GB"] as const) {
            const saved = await request.patch("/api/admin/settings", { data: { trafficUnit: unit } });
            const savedText = await saved.text();
            expect(saved.ok(), savedText).toBe(true);
            expect((JSON.parse(savedText) as { settings?: { trafficUnit?: string } }).settings?.trafficUnit).toBe(unit);

            const globalResult = await readTraffic(request, range);
            if (isMeterUnavailable(globalResult.response.status(), globalResult.text)) {
                test.skip(true, "真实流量计量服务不可用，跳过任务与请求报告断言");
            }
            expect(globalResult.response.ok(), globalResult.text).toBe(true);
            const [taskResult, requestResult] = await Promise.all([readTaskTraffic(request, range), readRequestTraffic(request, correlation.requestId, correlation.taskId)]);
            expect(taskResult.response.ok(), taskResult.text).toBe(true);
            expect(requestResult.response.ok(), requestResult.text).toBe(true);

            const global = globalResult.payload!.data;
            const taskReport = taskResult.payload!.data;
            const requestReport = requestResult.payload!.data;
            expect(global.displayUnit).toBe(unit);
            expect(taskReport.displayUnit).toBe(unit);
            expect(requestReport.displayUnit).toBe(unit);

            const task = taskReport.items.find((item) => item.taskId === correlation.taskId);
            expect(task, `任务报告缺少真实任务 ID ${correlation.taskId}`).toBeTruthy();
            const requestGroup = requestReport.items.find((item) => item.requestId === correlation.requestId);
            expect(requestGroup, `请求报告缺少真实请求 ID ${correlation.requestId}`).toBeTruthy();
            const taskRequestGroup = requestReport.tasks?.find((item) => item.taskId === correlation.taskId);
            expect(taskRequestGroup, `请求报告任务分组缺少真实任务 ID ${correlation.taskId}`).toBeTruthy();

            const globalTaskTotals = trafficTotals(global.items.filter((item) => item.taskId === correlation.taskId));
            const taskRouteTotals = trafficTotals(task!.items);
            const requestRouteTotals = trafficTotals(requestGroup!.items);
            assertTrafficTotals(task!, taskRouteTotals, "任务报告与任务路由明细");
            assertTrafficTotals(requestGroup!, requestRouteTotals, "请求报告与请求路由明细");
            assertTrafficTotals(task!, globalTaskTotals, "任务报告与全局报告");
            assertTrafficTotals(task!, requestGroup!, "任务报告与请求报告");
            assertTrafficTotals(task!, taskRequestGroup!, "任务报告与请求报告任务分组");
            expect(taskRouteTotals.totalBytes).toBeGreaterThan(0);
            expect(requestGroup!.items.some((item) => item.taskId === correlation.taskId)).toBe(true);

            await page.reload({ waitUntil: "domcontentloaded" });
            const refreshedGlobalPanel = trafficPanel(page);
            await expect(refreshedGlobalPanel.getByRole("heading", { name: "全局流量统计", exact: true })).toBeVisible();
            const taskPanel = taskTrafficPanel(page);
            await expect(taskPanel).toBeVisible();
            const taskRow = taskPanel.locator("tbody tr").filter({ hasText: correlation.taskId }).first();
            await expect(taskRow).toBeVisible();
            await expect(taskRow).toContainText(displayedBytes(task!.totalBytes, unit));
            const routeRows = taskPanel.locator("tbody tr:has(td:nth-child(2))").filter({ hasText: correlation.taskId });
            await expect(routeRows).toHaveCount(task!.items.length);
            for (const item of task!.items) {
                const routeRow = routeRows
                    .filter({ hasText: item.channelName || item.channelId })
                    .filter({ hasText: modelLabel(item.model) })
                    .filter({ hasText: connectionModeLabel(item) })
                    .first();
                await expect(routeRow).toBeVisible();
                await expect(routeRow).toContainText(displayedBytes(item.totalBytes, unit));
            }
            await expectNoHorizontalOverflow(page);
        }
    } finally {
        const restored = await request.patch("/api/admin/settings", { data: { trafficUnit: originalUnit } });
        expect(restored.ok(), await restored.text()).toBe(true);
    }
});

test("Dola 请求日志列表与详情合并真实中心流量并保留路由明细", async ({ page, request }) => {
    test.skip(!envText("DREAMYO_TRAFFIC_METER_URL") || !envText("DREAMYO_TRAFFIC_METER_KEY"), "未配置真实流量计量服务，跳过 Dola 请求日志流量断言");

    const manifest = await readTrafficFixtureManifest();
    const settingsResponse = await request.get("/api/admin/settings");
    const settingsText = await settingsResponse.text();
    expect(settingsResponse.ok(), settingsText).toBe(true);
    const settingsPayload = JSON.parse(settingsText) as { settings?: { trafficUnit?: string } };
    const originalUnit: TrafficDisplayUnit = settingsPayload.settings?.trafficUnit === "GB" ? "GB" : "MB";
    const correlation = configuredTrafficCorrelation();
    expect(correlation.requestId).toBe("e2e-request-image");
    expect(correlation.taskId).toBe("e2e-task-image");
    const expected = manifest.rawExpected?.[correlation.requestId];
    const payloadExpected = manifest.payloadExpected?.[correlation.requestId];
    expect(expected, `fixture manifest 缺少 rawExpected.${correlation.requestId}`).toBeTruthy();
    expect(payloadExpected, `fixture manifest 缺少 payloadExpected.${correlation.requestId}`).toBeTruthy();
    expect(expected!.routes.upload, "fixture manifest 缺少直连上传 raw route").toBeTruthy();
    expect(expected!.routes.submit, "fixture manifest 缺少链式提交 raw route").toBeTruthy();

    const requestTraffic = await readRequestTraffic(request, correlation.requestId, correlation.taskId);
    expect(requestTraffic.response.ok(), requestTraffic.text).toBe(true);
    const report = requestTraffic.payload!.data;
    expect(report.items.find((item) => item.requestId === correlation.requestId)).toMatchObject({ uploadBytes: expected!.uploadBytes, downloadBytes: expected!.downloadBytes, totalBytes: expected!.totalBytes });

    try {
        for (const unit of ["MB", "GB"] as const) {
            const saved = await request.patch("/api/admin/settings", { data: { trafficUnit: unit } });
            const savedText = await saved.text();
            expect(saved.ok(), savedText).toBe(true);
            expect((JSON.parse(savedText) as { settings?: { trafficUnit?: string } }).settings?.trafficUnit).toBe(unit);

            const card = await openDolaRequestLogs(page);
            const row = await assertDolaLogTrafficSummary(card, expected!, unit);

            if (unit === "MB") {
                await row.click();
                const detail = page.getByTestId("request-traffic-detail");
                await expect(detail).toBeVisible();
                await assertDolaLogTrafficDetail(detail, report, manifest, expected!, payloadExpected!, unit);
                await page.locator(".ant-drawer:visible .ant-drawer-close").click();
                await expect(page.getByTestId("request-traffic-detail")).toHaveCount(0);
            }

            const summaryBeforeRefresh = await row.getByTestId("request-traffic-summary").innerText();
            const logsResponse = page.waitForResponse((response) => response.url().includes("/api/admin/dola/logs") && response.request().method() === "GET");
            await card.getByRole("button", { name: "刷新", exact: true }).click();
            await logsResponse;
            const refreshedRow = await assertDolaLogTrafficSummary(card, expected!, unit);
            expect((await refreshedRow.getByTestId("request-traffic-summary").innerText()).replace(/\s+/g, "")).toBe(summaryBeforeRefresh.replace(/\s+/g, ""));
        }
    } finally {
        const restored = await request.patch("/api/admin/settings", { data: { trafficUnit: originalUnit } });
        expect(restored.ok(), await restored.text()).toBe(true);
    }
});

test("渠道详情的流量统计标签按需加载并固定渠道范围", async ({ page, request }) => {
    test.skip(!envText("DREAMYO_TRAFFIC_METER_URL") || !envText("DREAMYO_TRAFFIC_METER_KEY"), "未配置真实流量计量服务，跳过渠道详情流量断言");
    await setTrafficViewport(page);

    const settingsResponse = await request.get("/api/admin/settings");
    expect(settingsResponse.ok(), await settingsResponse.text()).toBe(true);
    const settingsPayload = (await settingsResponse.json()) as { settings?: { systemChannels?: SettingsChannel[] } };
    const configuredId = envText("DREAMYO_TRAFFIC_E2E_CHANNEL_ID");
    const configuredName = envText("DREAMYO_TRAFFIC_E2E_CHANNEL_NAME");
    const channel = (settingsPayload.settings?.systemChannels || []).find((item) => (configuredId && item.id === configuredId) || (configuredName && item.name === configuredName));
    test.skip(!channel, "未配置可供渠道详情回归使用的真实 E2E 渠道");

    const trafficRequests: string[] = [];
    page.on("request", (item) => {
        if (item.url().includes("/api/admin/traffic?")) trafficRequests.push(item.url());
    });
    await page.goto("/admin?section=channels", { waitUntil: "domcontentloaded" });
    const search = page.getByPlaceholder("搜索渠道、地址、协议或模型");
    await expect(search).toBeVisible();
    await search.fill(channel!.name || channel!.id);
    const viewButton = page.getByRole("button", { name: /^查\s*看$/ }).first();
    await expect(viewButton).toBeVisible();
    await viewButton.click();
    const drawer = page.locator(".ant-drawer:visible").last();
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole("tab", { name: "流量统计", exact: true })).toBeVisible();
    expect(trafficRequests).toHaveLength(0);

    await drawer.getByRole("tab", { name: "流量统计", exact: true }).click();
    const panel = trafficPanel(drawer, "流量统计");
    await expect(panel).toBeVisible();
    await expect(panel.getByText("全部渠道", { exact: true })).toHaveCount(0);
    await expect.poll(() => trafficRequests.length).toBeGreaterThan(0);
    await expectNoHorizontalOverflow(page);
    const drawerBounds = await page.locator(".ant-drawer-content-wrapper:visible").last().boundingBox();
    expect(drawerBounds?.x || 0).toBeGreaterThanOrEqual(-1);
    expect((drawerBounds?.x || 0) + (drawerBounds?.width || 0)).toBeLessThanOrEqual((await page.evaluate(() => innerWidth)) + 1);
});
