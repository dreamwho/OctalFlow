import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { app, BrowserWindow, dialog, ipcMain, Menu, safeStorage, session, shell } from "electron";

import { createCloudDeviceAuth, isTemporaryCloudFailure } from "./cloud-device-auth.mjs";
import { disableAutoWorkspaceBackup, publicAutoBackupStatus, readAutoWorkspaceBackup, runAutoWorkspaceBackupIfDue, saveAutoWorkspaceBackup } from "./auto-workspace-backup.mjs";
import { resolveEdition } from "../shared/edition.mjs";
import { readOrCreateRuntimeSecrets, startDesktopRuntime } from "./runtime-controller.mjs";
import { createWorkspaceBackup, restoreWorkspaceBackup } from "./workspace-backup.mjs";
import { importWebAccounts } from "./import-web-accounts.mjs";

const edition = await loadEdition();
app.setName(edition.productName);

if (!app.requestSingleInstanceLock()) app.quit();

let mainWindow;
let runtime;
let cloudAuth;
let appearance = "dark";
let preparedWorkspaceOperation;
let preparedWebAccountImport;
let workspaceOperationRunning = false;
let autoBackupError = "";
let quittingAfterRuntimeStop = false;

app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
});

app.whenReady().then(async () => {
    registerIpc();
    appearance = await readAppearance();
    mainWindow = createWindow();
    mainWindow.loadURL(loadingPage());
    if (edition.id === "admin") {
        try {
            const result = await runAutoWorkspaceBackupIfDue({ userData: app.getPath("userData"), safeStorage });
            if (result.ran) console.info("Automatic workspace backup completed");
        } catch (error) {
            autoBackupError = error instanceof Error ? error.message : "自动备份失败";
            console.warn("Automatic workspace backup failed", autoBackupError);
        }
    }
    runtime = await startDesktopRuntime({ app, edition, safeStorage, onProgress: showStartupProgress });
    installSessionBoundary(runtime.origin, runtime.sessionToken);
    await runtime.ready;
    if (edition.id === "commercial") {
        installCommercialMenu();
        cloudAuth = createCloudDeviceAuth({ cloudOrigin: edition.cloudOrigin || process.env.DREAMYO_DESKTOP_CLOUD_ORIGIN, userData: app.getPath("userData"), safeStorage, packaged: app.isPackaged });
        let cloudAuthenticated = false;
        try {
            const user = await cloudAuth.current();
            if (user) {
                await bootstrapCommercialSession();
                cloudAuthenticated = true;
            }
        } catch (error) {
            if (isTemporaryCloudFailure(error)) {
                try {
                    const cached = await cloudAuth.cachedIdentity();
                    if (cached) {
                        await bootstrapOfflineSession(cached.id);
                        cloudAuthenticated = true;
                        console.warn("Commercial desktop opened cached local projects while cloud is unavailable");
                    }
                } catch (offlineError) { console.warn("Commercial desktop local restore unavailable", offlineError instanceof Error ? offlineError.message : "unknown"); }
            } else console.warn("Commercial desktop cloud session unavailable", error instanceof Error ? error.message : "unknown");
        }
        if (!cloudAuthenticated) await session.defaultSession.cookies.remove(runtime.origin, "dreamyo_session");
        await mainWindow.loadURL(new URL(cloudAuthenticated ? "/canvas" : "/desktop/connect", runtime.origin).toString());
    } else {
        await mainWindow.loadURL(new URL(edition.startPath, runtime.origin).toString());
    }
    if (process.env.DREAMYO_DESKTOP_SMOKE === "1") {
        if (process.env.DREAMYO_DESKTOP_SMOKE_WIDTH === "1024") mainWindow.setSize(1024, 768);
        if (edition.id === "commercial") {
            if (mainWindow.webContents.getURL().includes("/desktop/connect")) await mainWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => { const ready = () => document.querySelector('main[data-cloud-ready="true"]'); if (ready()) return resolve(true); const observer = new MutationObserver(() => { if (ready()) { observer.disconnect(); clearTimeout(timer); resolve(true); } }); const timer = setTimeout(() => { observer.disconnect(); reject(new Error('Cloud connection page did not hydrate')); }, 30000); observer.observe(document.body, { childList: true, subtree: true, attributes: true }); })`);
            const status = await mainWindow.webContents.executeJavaScript(`({ path: location.pathname, localLogin: Boolean(document.querySelector('form')), connectVisible: document.body.innerText.includes('连接云端账号') })`);
            console.log(`[desktop-smoke] commercial ${JSON.stringify(status)}`);
            if (process.env.DREAMYO_DESKTOP_SMOKE_SCREENSHOT) {
                await mainWindow.webContents.executeJavaScript("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
                await writeFile(process.env.DREAMYO_DESKTOP_SMOKE_SCREENSHOT, (await mainWindow.webContents.capturePage()).toPNG());
            }
            await exitDesktop(status.localLogin || !["/desktop/connect", "/canvas"].includes(status.path) || (status.path === "/desktop/connect" && !status.connectVisible) ? 1 : 0);
            return;
        }
        if (edition.id === "admin") await mainWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => { const ready = () => Boolean(document.querySelector('[data-desktop-workspace="true"]')) && Boolean(document.querySelector('button[aria-label="新建项目"]:not([disabled])')); if (ready()) return resolve(true); const observer = new MutationObserver(() => { if (ready()) { observer.disconnect(); clearTimeout(timer); resolve(true); } }); const timer = setTimeout(() => { observer.disconnect(); reject(new Error('Canvas did not reach its ready state')); }, 30000); observer.observe(document.body, { childList: true, subtree: true, attributes: true }); })`);
        const state = await mainWindow.webContents.executeJavaScript(`Promise.all([fetch('/api/auth/session').then(r => r.json()), fetch('/api/billing/products').then(r => r.status)]).then(([session, billing]) => ({ role: session.user?.role || null, edition: session.desktop?.edition || null, billing, pathname: location.pathname, canvasVisible: document.body.innerText.includes('项目库'), localModeVisible: Boolean(document.querySelector('[data-desktop-workspace="true"]')) }))`);
        console.log(`[desktop-smoke] ${JSON.stringify(state)}`);
        if (edition.id === "admin" && (state.role !== "admin" || state.edition !== "admin" || state.billing !== 403 || state.pathname !== "/canvas" || !state.canvasVisible || !state.localModeVisible)) throw new Error("Desktop administrator smoke test failed");
        if (edition.id === "admin" && process.env.DREAMYO_DESKTOP_SMOKE_PROJECT_FILE) {
            const stateFile = process.env.DREAMYO_DESKTOP_SMOKE_PROJECT_FILE;
            if (process.env.DREAMYO_DESKTOP_SMOKE_PROJECT_PHASE === "create") {
                const project = await mainWindow.webContents.executeJavaScript(`fetch('/api/canvas/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: '桌面持久化验收项目' }) }).then(r => r.json()).then(r => r.data?.project)`);
                if (!project?.id) throw new Error("Desktop project creation failed");
                await writeFile(stateFile, project.id, "utf8");
                console.log("[desktop-smoke] project created");
            } else if (process.env.DREAMYO_DESKTOP_SMOKE_PROJECT_PHASE === "verify") {
                const id = (await readFile(stateFile, "utf8")).trim();
                const project = await mainWindow.webContents.executeJavaScript(`fetch('/api/canvas/projects/${encodeURIComponent(id)}').then(r => r.json()).then(r => r.data?.project)`);
                if (project?.title !== "桌面持久化验收项目") throw new Error("Desktop project did not survive restart");
                const removed = await mainWindow.webContents.executeJavaScript(`fetch('/api/canvas/projects', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [${JSON.stringify(id)}] }) }).then(r => r.json())`);
                if (removed.code !== 0) throw new Error("Desktop project cleanup failed");
                console.log("[desktop-smoke] project persisted across restart and cleaned up");
            }
        }
        if (process.env.DREAMYO_DESKTOP_SMOKE_SCREENSHOT) {
            const screenshot = await mainWindow.webContents.capturePage();
            await writeFile(process.env.DREAMYO_DESKTOP_SMOKE_SCREENSHOT, screenshot.toPNG());
        }
        if (edition.id === "admin") {
            await mainWindow.loadURL(new URL("/admin?section=channels", runtime.origin).toString());
            await mainWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => { const ready = () => document.querySelector('.admin-dashboard-shell[data-hydrated="true"]') && !document.querySelector('[aria-label="正在加载管理后台"]'); if (ready()) return resolve(true); const observer = new MutationObserver(() => { if (ready()) { observer.disconnect(); clearTimeout(timer); resolve(true); } }); const timer = setTimeout(() => { observer.disconnect(); reject(new Error('Admin navigation did not mount: ' + location.pathname + ' ' + document.body.innerText.slice(0, 240))); }, 30000); observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true }); })`);
            const navigation = await mainWindow.webContents.executeJavaScript(`({ channel: Boolean(document.querySelector('[data-admin-section-key="channels"]')), users: Boolean(document.querySelector('[data-admin-section-key="users"]')), points: Boolean(document.querySelector('[data-admin-section-key="points"]')), setup: Boolean(document.querySelector('.admin-dashboard-setup-pill')), desktopSettings: Boolean(document.querySelector('[data-desktop-settings="true"]')), webSidebar: Boolean(document.querySelector('[data-admin-navigation="true"]')), appSidebar: Boolean(document.querySelector('[aria-label="桌面应用导航"]')), closeSettings: Boolean(document.querySelector('[aria-label="关闭设置并返回上一页面"]')), workspaceWidth: Math.round(document.querySelector('[data-desktop-workspace="true"]')?.getBoundingClientRect().width || 0), viewportWidth: innerWidth })`);
            console.log(`[desktop-smoke] admin navigation ${JSON.stringify(navigation)}`);
            if (!navigation.channel || !navigation.desktopSettings || navigation.webSidebar || navigation.appSidebar || !navigation.closeSettings || navigation.workspaceWidth !== navigation.viewportWidth || navigation.users || navigation.points || navigation.setup) throw new Error("Administrator desktop settings did not occupy the workspace");
            await mainWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => { const ready = () => Boolean(document.querySelector('.ant-table')); if (ready()) return resolve(true); const observer = new MutationObserver(() => { if (ready()) { observer.disconnect(); clearTimeout(timer); resolve(true); } }); const timer = setTimeout(() => { observer.disconnect(); reject(new Error('Channel table did not mount')); }, 30000); observer.observe(document.body, { childList: true, subtree: true }); })`);
            const layout = await mainWindow.webContents.executeJavaScript(`({ navWidth: Math.round(document.querySelector('[data-desktop-settings="true"]')?.getBoundingClientRect().width || 0), contentWidth: Math.round(document.querySelector('.admin-dashboard-content')?.getBoundingClientRect().width || 0), tableRight: Math.round(document.querySelector('.ant-table')?.getBoundingClientRect().right || 0), viewportWidth: innerWidth })`);
            console.log(`[desktop-smoke] settings layout ${JSON.stringify(layout)}`);
            if (layout.tableRight > layout.viewportWidth || layout.contentWidth < 700) throw new Error("Administrator settings content is clipped");
            if (process.env.DREAMYO_DESKTOP_SMOKE_DOLA === "1") {
                await mainWindow.loadURL(new URL("/admin?section=dolaApi", runtime.origin).toString());
                const dola = await mainWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => { const ready = () => document.body.innerText.includes('账号池') && document.body.innerText.includes('账号轮换次数上限'); if (ready()) return resolve(true); const observer = new MutationObserver(() => { if (ready()) { observer.disconnect(); clearTimeout(timer); resolve(true); } }); const timer = setTimeout(() => { observer.disconnect(); reject(new Error('Dola account manager did not mount')); }, 30000); observer.observe(document.body, { childList: true, subtree: true, characterData: true }); })`);
                console.log(`[desktop-smoke] Dola account manager ${JSON.stringify({ mounted: dola })}`);
            }
            if (process.env.DREAMYO_DESKTOP_SMOKE_SCREENSHOT) {
                await mainWindow.webContents.executeJavaScript("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
                const screenshot = await mainWindow.webContents.capturePage();
                await writeFile(process.env.DREAMYO_DESKTOP_SMOKE_SCREENSHOT.replace(/\.png$/i, "-admin.png"), screenshot.toPNG());
            }
            const returned = await mainWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => { document.querySelector('[aria-label="关闭设置并返回上一页面"]')?.click(); const ready = () => location.pathname === '/canvas' && Boolean(document.querySelector('[aria-label="桌面应用导航"]')); if (ready()) return resolve(true); const observer = new MutationObserver(() => { if (ready()) { observer.disconnect(); clearTimeout(timer); resolve(true); } }); const timer = setTimeout(() => { observer.disconnect(); reject(new Error('Closing settings did not return to the previous page')); }, 30000); observer.observe(document.body, { childList: true, subtree: true, attributes: true }); })`);
            console.log(`[desktop-smoke] settings close ${JSON.stringify({ returned })}`);
            await mainWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => { const ready = () => Boolean(document.querySelector('button[aria-label="新建项目"]:not([disabled])')); if (ready()) return resolve(true); const observer = new MutationObserver(() => { if (ready()) { observer.disconnect(); clearTimeout(timer); resolve(true); } }); const timer = setTimeout(() => { observer.disconnect(); reject(new Error('Canvas did not recover after closing settings')); }, 30000); observer.observe(document.body, { childList: true, subtree: true, attributes: true }); })`);
        }
        await exitDesktop(0);
    }
}).catch(async (error) => {
    if (process.env.DREAMYO_DESKTOP_SMOKE === "1") {
        console.error(error);
        await exitDesktop(1);
        return;
    }
    dialog.showErrorBox("Dreamyo 启动失败", error instanceof Error ? error.message : String(error));
    app.quit();
});

app.on("before-quit", (event) => {
    if (quittingAfterRuntimeStop || !runtime) return;
    event.preventDefault();
    quittingAfterRuntimeStop = true;
    void runtime.stop().catch((error) => console.error("Desktop runtime shutdown failed", error)).finally(() => app.quit());
});
app.on("window-all-closed", () => app.quit());

async function exitDesktop(code) {
    const current = runtime;
    runtime = null;
    if (current) await current.stop();
    app.exit(code);
}

function createWindow() {
    const window = new BrowserWindow({
        width: 1440,
        height: 960,
        minWidth: 1024,
        minHeight: 680,
        title: edition.windowTitle,
        show: false,
        backgroundColor: appearance === "dark" ? "#101322" : "#f5f7ff",
        ...(process.platform === "darwin" ? { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 17, y: 24 } } : {}),
        ...(process.platform === "win32" ? { titleBarStyle: "hidden", titleBarOverlay: { color: appearance === "dark" ? "#080b14" : "#f9faff", symbolColor: appearance === "dark" ? "#f1f1ff" : "#1c2242", height: 36 } } : {}),
        webPreferences: {
            preload: path.resolve(import.meta.dirname, "../preload/index.cjs"),
            contextIsolation: true,
            sandbox: true,
            nodeIntegration: false,
            webSecurity: true,
        },
    });
    window.once("ready-to-show", () => window.show());
    window.webContents.setWindowOpenHandler(({ url }) => {
        if (isSafeExternalUrl(url)) void shell.openExternal(url);
        return { action: "deny" };
    });
    window.webContents.on("will-navigate", (event, url) => {
        if (runtime && isRuntimeUrl(url, runtime.origin)) return;
        event.preventDefault();
        if (isSafeExternalUrl(url)) void shell.openExternal(url);
    });
    return window;
}

function installSessionBoundary(origin, token) {
    session.defaultSession.webRequest.onBeforeSendHeaders({ urls: [`${origin}/*`] }, (details, callback) => {
        details.requestHeaders["x-dreamyo-desktop-token"] = token;
        callback({ requestHeaders: details.requestHeaders });
    });
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
}

async function readAppearance() {
    try {
        const stored = JSON.parse(await readFile(path.join(app.getPath("userData"), "appearance.json"), "utf8"));
        return stored.theme === "light" ? "light" : "dark";
    } catch { return "dark"; }
}

function registerIpc() {
    ipcMain.handle("desktop:get-runtime-info", (event) => {
        assertTrustedSender(event);
        return { ...edition, origin: runtime?.origin || null, packaged: app.isPackaged, platform: process.platform };
    });
    ipcMain.handle("desktop:get-appearance", (event) => {
        assertTrustedSender(event);
        return appearance;
    });
    ipcMain.handle("desktop:set-appearance", async (event, theme) => {
        assertTrustedSender(event);
        if (edition.id !== "admin" || (theme !== "dark" && theme !== "light")) throw new Error("无效的本地主题");
        await mkdir(app.getPath("userData"), { recursive: true });
        await writeFile(path.join(app.getPath("userData"), "appearance.json"), JSON.stringify({ theme }), { mode: 0o600 });
        appearance = theme;
        setNativeAppearance(theme);
        return true;
    });
    ipcMain.handle("desktop:choose-directory", async (event) => {
        assertTrustedSender(event);
        const result = await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory", "createDirectory"] });
        return result.canceled ? null : result.filePaths[0] || null;
    });
    ipcMain.handle("desktop:open-data-directory", async (event) => {
        assertTrustedSender(event);
        if (edition.id !== "admin") throw new Error("仅管理员本地版可打开完整工作区目录");
        const directory = app.getPath("userData");
        const error = await shell.openPath(directory);
        if (error) throw new Error(error);
        return true;
    });
    ipcMain.handle("desktop:prepare-web-account-import", async (event) => {
        assertTrustedSender(event);
        if (edition.id !== "admin" || workspaceOperationRunning) throw new Error("当前无法导入 WEB 账号");
        const result = await dialog.showOpenDialog(mainWindow, { title: "选择包含 .data 和 .env.local 的 WEB 项目目录", properties: ["openDirectory"] });
        if (result.canceled || !result.filePaths[0]) return null;
        preparedWebAccountImport = { directory: result.filePaths[0], token: randomUUID() };
        return { token: preparedWebAccountImport.token };
    });
    ipcMain.on("desktop:begin-web-account-import", (event, token) => {
        try {
            assertTrustedSender(event);
            if (edition.id !== "admin" || workspaceOperationRunning || !preparedWebAccountImport || token !== preparedWebAccountImport.token) throw new Error("账号导入请求无效");
            const operation = preparedWebAccountImport;
            preparedWebAccountImport = undefined;
            workspaceOperationRunning = true;
            void performWebAccountImport(operation.directory).finally(() => { workspaceOperationRunning = false; });
        } catch (error) { dialog.showErrorBox("WEB 账号导入失败", error instanceof Error ? error.message : String(error)); }
    });
    ipcMain.handle("desktop:prepare-workspace-operation", async (event, kind) => {
        assertTrustedSender(event);
        if (edition.id !== "admin" || (kind !== "backup" && kind !== "restore")) throw new Error("当前版本不支持工作区备份恢复");
        if (workspaceOperationRunning) throw new Error("已有工作区操作正在进行");
        const result = await dialog.showOpenDialog(mainWindow, {
            title: kind === "backup" ? "选择工作区备份保存位置" : "选择 .dreamyo-workspace 备份文件夹",
            properties: kind === "backup" ? ["openDirectory", "createDirectory"] : ["openDirectory"],
        });
        if (result.canceled || !result.filePaths[0]) return null;
        preparedWorkspaceOperation = { kind, directory: result.filePaths[0], token: randomUUID() };
        return { token: preparedWorkspaceOperation.token };
    });
    ipcMain.handle("desktop:get-auto-backup", async (event) => {
        assertTrustedSender(event);
        if (edition.id !== "admin") throw new Error("当前版本不支持自动备份");
        try { return { ...publicAutoBackupStatus(await readAutoWorkspaceBackup({ userData: app.getPath("userData"), safeStorage })), lastError: autoBackupError }; }
        catch (error) { return { enabled: false, lastError: autoBackupError || (error instanceof Error ? error.message : "自动备份配置无法读取") }; }
    });
    ipcMain.handle("desktop:configure-auto-backup", async (event, password, intervalDays) => {
        assertTrustedSender(event);
        if (edition.id !== "admin" || workspaceOperationRunning) throw new Error("当前无法设置自动备份");
        const result = await dialog.showOpenDialog(mainWindow, { title: "选择启动自动备份目录", properties: ["openDirectory", "createDirectory"] });
        if (result.canceled || !result.filePaths[0]) return null;
        const status = await saveAutoWorkspaceBackup({ userData: app.getPath("userData"), safeStorage, destination: result.filePaths[0], password, intervalDays });
        autoBackupError = "";
        return { ...status, lastError: "" };
    });
    ipcMain.handle("desktop:disable-auto-backup", async (event) => {
        assertTrustedSender(event);
        if (edition.id !== "admin") throw new Error("当前版本不支持自动备份");
        await disableAutoWorkspaceBackup({ userData: app.getPath("userData") });
        autoBackupError = "";
        return { enabled: false, lastError: "" };
    });
    ipcMain.on("desktop:begin-workspace-operation", (event, token, password) => {
        try {
            assertTrustedSender(event);
            if (workspaceOperationRunning || !preparedWorkspaceOperation || token !== preparedWorkspaceOperation.token) throw new Error("工作区操作无效");
            const operation = preparedWorkspaceOperation;
            preparedWorkspaceOperation = undefined;
            workspaceOperationRunning = true;
            void performWorkspaceOperation(operation, password).finally(() => { workspaceOperationRunning = false; });
        } catch (error) { dialog.showErrorBox("工作区操作失败", error instanceof Error ? error.message : String(error)); }
    });
    ipcMain.handle("desktop:open-external", async (event, url) => {
        assertTrustedSender(event);
        if (!isSafeExternalUrl(url)) throw new Error("Unsupported external URL");
        await shell.openExternal(url);
        return true;
    });
    ipcMain.handle("desktop:cloud-start", async (event) => {
        assertTrustedSender(event);
        if (edition.id !== "commercial" || !cloudAuth) throw new Error("当前版本不支持云端设备授权");
        return cloudAuth.start(`${app.getName()} · ${process.platform}`);
    });
    ipcMain.handle("desktop:cloud-finish", async (event) => {
        assertTrustedSender(event);
        if (edition.id !== "commercial" || !cloudAuth) throw new Error("当前版本不支持云端设备授权");
        const result = await cloudAuth.finish();
        if (result.status === "authorized") {
            await bootstrapCommercialSession();
            await mainWindow.loadURL(new URL("/canvas", runtime.origin).toString());
        }
        return result;
    });
    ipcMain.handle("desktop:cloud-status", async (event) => {
        assertTrustedSender(event);
        return { configured: Boolean(cloudAuth?.configured), origin: cloudAuth?.origin || "" };
    });
    ipcMain.handle("desktop:cloud-logout", async (event) => {
        assertTrustedSender(event);
        await logoutCommercialSession();
        return true;
    });
    ipcMain.handle("desktop:cloud-storage", async (event, action, input) => {
        assertTrustedSender(event);
        if (!edition.cloudProjectBackups || !cloudAuth) throw new Error("当前版本不支持云端存储");
        return cloudAuth.cloudStorage(action, input);
    });
}

async function performWorkspaceOperation({ kind, directory }, password) {
    const route = "/admin?section=backup";
    try {
        await mainWindow.loadURL(loadingPage(kind === "backup" ? "正在备份完整工作区" : "正在恢复完整工作区"));
        await runtime?.stop();
        runtime = null;
        if (kind === "backup") {
            const folder = await createWorkspaceBackup({ userData: app.getPath("userData"), destination: directory, password, safeStorage });
            await startLocalRuntime(route);
            await dialog.showMessageBox(mainWindow, { type: "info", title: "工作区备份完成", message: "项目、媒体和本机配置已加密备份。", detail: `备份文件夹：${folder}` });
        } else {
            const result = await restoreWorkspaceBackup({ userData: app.getPath("userData"), source: directory, password, safeStorage, onCommit: async () => {
                appearance = await readAppearance();
                setNativeAppearance(appearance);
                await startLocalRuntime(route);
            } });
            appearance = result.theme;
            await dialog.showMessageBox(mainWindow, { type: "info", title: "工作区恢复完成", message: "项目、媒体和本机配置已恢复。", detail: "应用已重新启动本地服务。" });
        }
    } catch (error) {
        if (!runtime) {
            try { appearance = await readAppearance(); setNativeAppearance(appearance); await startLocalRuntime(route); }
            catch (restartError) { console.error("Workspace recovery restart failed", restartError instanceof Error ? restartError.message : restartError); }
        }
        dialog.showErrorBox("工作区操作失败", error instanceof Error ? error.message : String(error));
    }
}

async function performWebAccountImport(directory) {
    const route = "/admin?section=backup";
    try {
        const secrets = await readOrCreateRuntimeSecrets(path.join(app.getPath("userData"), "runtime-secrets.bin"), safeStorage);
        await mainWindow.loadURL(loadingPage("正在导入本机 WEB 渠道账号"));
        await runtime?.stop();
        runtime = null;
        const counts = await importWebAccounts({ webRoot: directory, dataRoot: path.join(app.getPath("userData"), "data"), targetKey: secrets.encryptionKey });
        await startLocalRuntime(route);
        await dialog.showMessageBox(mainWindow, { type: "info", title: "WEB 账号导入完成", message: "账号已合并到桌面版本地账号池。", detail: `GeminiAIStudio ${counts.geminiai}、Dola API ${counts.dola}、GeminiTools ${counts.geminiTools}、GPTAPI ${counts.gptapi} 个新增账号。` });
    } catch (error) {
        if (!runtime) {
            try { await startLocalRuntime(route); }
            catch (restartError) { console.error("WEB account import restart failed", restartError instanceof Error ? restartError.message : restartError); }
        }
        dialog.showErrorBox("WEB 账号导入失败", error instanceof Error ? error.message : String(error));
    }
}

async function startLocalRuntime(route) {
    const next = await startDesktopRuntime({ app, edition, safeStorage, onProgress: showStartupProgress });
    runtime = next;
    installSessionBoundary(next.origin, next.sessionToken);
    try {
        await next.ready;
        await mainWindow.loadURL(new URL(route, next.origin).toString());
    } catch (error) {
        await next.stop();
        runtime = null;
        throw error;
    }
}

function showStartupProgress(_ready, pending) {
    if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.webContents.getURL().startsWith("data:text/html")) return;
    const message = pending.length ? `正在启动 ${pending.join("、")}` : "正在打开工作区";
    void mainWindow.webContents.executeJavaScript(`document.getElementById("startup-status").textContent = ${JSON.stringify(message)}`).catch(() => {});
}

function setNativeAppearance(theme) {
    if (process.platform === "win32") mainWindow.setTitleBarOverlay({ color: theme === "dark" ? "#080b14" : "#f9faff", symbolColor: theme === "dark" ? "#f1f1ff" : "#1c2242", height: 36 });
    mainWindow.setBackgroundColor(theme === "dark" ? "#101322" : "#f5f7ff");
}

function installCommercialMenu() {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
        { label: app.getName(), submenu: [{ role: "about" }, { type: "separator" }, { role: "quit" }] },
        { label: "账号", submenu: [{ label: "退出云端账号", click: () => void logoutCommercialSession().catch((error) => dialog.showErrorBox("退出登录失败", error instanceof Error ? error.message : String(error))) }] },
        { role: "editMenu" }, { role: "viewMenu" }, { role: "windowMenu" },
    ]));
}

async function logoutCommercialSession() {
    if (!cloudAuth || !runtime) return;
    let revokeError;
    try { await cloudAuth.logout(); }
    catch (error) { revokeError = error; }
    const cookies = await session.defaultSession.cookies.get({ url: runtime.origin, name: "dreamyo_session" });
    let localError;
    try {
        const response = await fetch(new URL("/api/desktop/cloud-logout", runtime.origin), {
            method: "POST",
            headers: { "x-dreamyo-desktop-token": runtime.sessionToken, ...(cookies[0] ? { Cookie: `dreamyo_session=${cookies[0].value}` } : {}) },
        });
        if (!response.ok) throw new Error(`本地会话退出失败（HTTP ${response.status}）`);
    } catch (error) { localError = error; }
    await session.defaultSession.cookies.remove(runtime.origin, "dreamyo_session");
    await mainWindow?.loadURL(new URL("/desktop/connect", runtime.origin).toString());
    if (revokeError || localError) throw revokeError || localError;
}

async function bootstrapCommercialSession() {
    const accessToken = cloudAuth?.getAccessToken();
    if (!accessToken || !runtime) throw new Error("云端设备登录尚未完成");
    const response = await fetch(new URL("/api/desktop/cloud-bootstrap", runtime.origin), {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-dreamyo-desktop-token": runtime.sessionToken, "x-dreamyo-desktop-main-token": runtime.mainToken },
        body: JSON.stringify({ accessToken }),
    });
    if (!response.ok) throw new Error(`本地账号绑定失败（HTTP ${response.status}）`);
    await installDesktopSessionCookie(response);
}

async function bootstrapOfflineSession(cloudUserId) {
    if (!runtime) throw new Error("本地 Runtime 未启动");
    const response = await fetch(new URL("/api/desktop/cloud-offline-bootstrap", runtime.origin), {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-dreamyo-desktop-token": runtime.sessionToken, "x-dreamyo-desktop-main-token": runtime.mainToken },
        body: JSON.stringify({ cloudUserId }),
    });
    if (!response.ok) throw new Error(`本地离线身份恢复失败（HTTP ${response.status}）`);
    await installDesktopSessionCookie(response);
}

async function installDesktopSessionCookie(response) {
    const cookie = response.headers.get("set-cookie")?.match(/(?:^|,\s*)dreamyo_session=([^;]+)/)?.[1];
    if (!cookie) throw new Error("本地账号绑定未返回 Session Cookie");
    await session.defaultSession.cookies.set({ url: runtime.origin, name: "dreamyo_session", value: cookie, httpOnly: true, sameSite: "lax" });
}

function assertTrustedSender(event) {
    if (!runtime || event.sender !== mainWindow?.webContents || event.senderFrame !== mainWindow.webContents.mainFrame || !isRuntimeUrl(event.senderFrame.url, runtime.origin)) {
        throw new Error("Desktop IPC requires the local application window");
    }
}

function isRuntimeUrl(value, origin) {
    try {
        return new URL(value).origin === origin;
    } catch {
        return false;
    }
}

async function loadEdition() {
    if (!app.isPackaged) return resolveEdition(process.env.DREAMYO_DESKTOP_EDITION || "commercial");
    const manifest = JSON.parse(await readFile(path.join(process.resourcesPath, "edition.json"), "utf8"));
    return { ...resolveEdition(manifest.edition), cloudOrigin: manifest.cloudOrigin || "" };
}

function isSafeExternalUrl(value) {
    try {
        const url = new URL(value);
        const loopback = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname.toLowerCase());
        return url.protocol === "https:" || (!app.isPackaged && url.protocol === "http:" && loopback);
    } catch {
        return false;
    }
}

function loadingPage(status = "正在启动本地服务") {
    const title = encodeURIComponent(edition.windowTitle);
    return `data:text/html;charset=utf-8,<title>${title}</title><style>body{margin:0;background:%23080b14;color:%23fafafa;font:14px system-ui;display:grid;place-items:center;height:100vh}.box{text-align:center}.dot{width:36px;height:36px;margin:auto;border:3px solid %233f3f46;border-top-color:%236366f1;border-radius:50%;animation:s .8s linear infinite}@keyframes s{to{transform:rotate(360deg)}}</style><div class=box><div class=dot></div><p id=startup-status>${encodeURIComponent(status)}…</p></div>`;
}
