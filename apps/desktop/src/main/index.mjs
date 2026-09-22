import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { app, BrowserWindow, dialog, ipcMain, session, shell } from "electron";

import { resolveEdition } from "../shared/edition.mjs";
import { startDesktopRuntime } from "./runtime-controller.mjs";

const edition = await loadEdition();
app.setName(edition.productName);

if (!app.requestSingleInstanceLock()) app.quit();

let mainWindow;
let runtime;

app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
});

app.whenReady().then(async () => {
    registerIpc();
    mainWindow = createWindow();
    if (edition.id === "commercial" && edition.implementationStage === "foundation") {
        await mainWindow.loadURL(commercialFoundationPage());
        if (process.env.DREAMYO_DESKTOP_SMOKE === "1") {
            const status = await mainWindow.webContents.executeJavaScript(`({ localLogin: Boolean(document.querySelector('form')), stage: document.querySelector('main')?.dataset.stage })`);
            console.log(`[desktop-smoke] commercial ${JSON.stringify(status)}`);
            app.exit(status.localLogin || status.stage !== "foundation" ? 1 : 0);
        }
        return;
    }
    mainWindow.loadURL(loadingPage());
    runtime = await startDesktopRuntime({ app, edition });
    installSessionBoundary(runtime.origin, runtime.sessionToken);
    await runtime.ready;
    await mainWindow.loadURL(new URL(edition.startPath, runtime.origin).toString());
    if (process.env.DREAMYO_DESKTOP_SMOKE === "1") {
        if (edition.id === "admin") await mainWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => { const ready = () => document.body.innerText.includes('本地模式') && !document.body.innerText.includes('正在加载画布'); if (ready()) return resolve(true); const observer = new MutationObserver(() => { if (ready()) { observer.disconnect(); clearTimeout(timer); resolve(true); } }); const timer = setTimeout(() => { observer.disconnect(); reject(new Error('Canvas did not reach its ready state')); }, 30000); observer.observe(document.body, { childList: true, subtree: true, characterData: true }); })`);
        const state = await mainWindow.webContents.executeJavaScript(`Promise.all([fetch('/api/auth/session').then(r => r.json()), fetch('/api/billing/products').then(r => r.status)]).then(([session, billing]) => ({ role: session.user?.role || null, edition: session.desktop?.edition || null, billing, pathname: location.pathname, canvasVisible: document.body.innerText.includes('我的项目'), localModeVisible: document.body.innerText.includes('本地模式') }))`);
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
            const navigation = await mainWindow.webContents.executeJavaScript(`({ channel: Boolean(document.querySelector('[data-admin-section-key="channels"]')), users: Boolean(document.querySelector('[data-admin-section-key="users"]')), points: Boolean(document.querySelector('[data-admin-section-key="points"]')), setup: Boolean(document.querySelector('.admin-dashboard-setup-pill')) })`);
            console.log(`[desktop-smoke] admin navigation ${JSON.stringify(navigation)}`);
            if (!navigation.channel || navigation.users || navigation.points || navigation.setup) throw new Error("Administrator desktop navigation exposes cloud sections");
            if (process.env.DREAMYO_DESKTOP_SMOKE_DOLA === "1") {
                await mainWindow.loadURL(new URL("/admin?section=dolaApi", runtime.origin).toString());
                const dola = await mainWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => { const ready = () => document.body.innerText.includes('账号池') && document.body.innerText.includes('Dola API'); if (ready()) return resolve(true); const observer = new MutationObserver(() => { if (ready()) { observer.disconnect(); clearTimeout(timer); resolve(true); } }); const timer = setTimeout(() => { observer.disconnect(); reject(new Error('Dola account manager did not mount')); }, 30000); observer.observe(document.body, { childList: true, subtree: true, characterData: true }); })`);
                console.log(`[desktop-smoke] Dola account manager ${JSON.stringify({ mounted: dola })}`);
            }
            if (process.env.DREAMYO_DESKTOP_SMOKE_SCREENSHOT) {
                const screenshot = await mainWindow.webContents.capturePage();
                await writeFile(process.env.DREAMYO_DESKTOP_SMOKE_SCREENSHOT.replace(/\.png$/i, "-admin.png"), screenshot.toPNG());
            }
        }
        app.exit(0);
    }
}).catch((error) => {
    if (process.env.DREAMYO_DESKTOP_SMOKE === "1") {
        console.error(error);
        app.exit(1);
        return;
    }
    dialog.showErrorBox("Dreamyo 启动失败", error instanceof Error ? error.message : String(error));
    app.quit();
});

app.on("before-quit", () => runtime?.stop());
app.on("window-all-closed", () => app.quit());

function createWindow() {
    const window = new BrowserWindow({
        width: 1440,
        height: 960,
        minWidth: 1024,
        minHeight: 680,
        title: edition.windowTitle,
        show: false,
        backgroundColor: "#09090b",
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

function registerIpc() {
    ipcMain.handle("desktop:get-runtime-info", (event) => {
        assertTrustedSender(event);
        return { ...edition, origin: runtime?.origin || null, packaged: app.isPackaged, platform: process.platform };
    });
    ipcMain.handle("desktop:choose-directory", async (event) => {
        assertTrustedSender(event);
        const result = await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory", "createDirectory"] });
        return result.canceled ? null : result.filePaths[0] || null;
    });
    ipcMain.handle("desktop:open-external", async (event, url) => {
        assertTrustedSender(event);
        if (!isSafeExternalUrl(url)) throw new Error("Unsupported external URL");
        await shell.openExternal(url);
        return true;
    });
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
    return resolveEdition(manifest.edition);
}

function isSafeExternalUrl(value) {
    try {
        return new URL(value).protocol === "https:";
    } catch {
        return false;
    }
}

function loadingPage() {
    const title = encodeURIComponent(edition.windowTitle);
    return `data:text/html;charset=utf-8,<title>${title}</title><style>body{margin:0;background:%2309090b;color:%23fafafa;font:14px system-ui;display:grid;place-items:center;height:100vh}.box{text-align:center}.dot{width:36px;height:36px;margin:auto;border:3px solid %233f3f46;border-top-color:%2360a5fa;border-radius:50%;animation:s .8s linear infinite}@keyframes s{to{transform:rotate(360deg)}}</style><div class=box><div class=dot></div><p>正在启动 ${title} 本地服务…</p></div>`;
}

function commercialFoundationPage() {
    const content = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Dreamyo 商用桌面版</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#090e1c;color:#eaf0ff;font:15px system-ui}main{max-width:560px;padding:40px;border:1px solid #33415f;border-radius:20px;background:#15203a}h1{margin:0 0 18px;font-size:22px}p{line-height:1.8;color:#bbcae7}</style><main data-stage="foundation"><h1>商用桌面版正在开发</h1><p>云端登录、实时积分、混合模型路由和跨设备同步尚未接通。本版本暂不提供本地登录入口，以免把测试账号误当成云端账号。</p><p>现有 Web 版可以照常使用；管理员本地版可独立运行画布与本地上游配置。</p></main></html>`;
    return `data:text/html;charset=utf-8,${encodeURIComponent(content)}`;
}
