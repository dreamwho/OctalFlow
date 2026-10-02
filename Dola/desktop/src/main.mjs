import { app, BrowserWindow, WebContentsView, clipboard, dialog, ipcMain, nativeImage, safeStorage, session, shell } from "electron";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { chmod, copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createWriteStream, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { WorkspaceStore, matchApiKey, newApiKey, parseCookie } from "./store.mjs";
import { MihomoManager, accountProxyId, configuredProxyId, genericMihomoNode, normalizeGenericProxyUrl, parseGenericProxyGroups } from "./proxy-runtime.mjs";
import { resolveDolaWatermarkUrlRemote } from "./watermark.mjs";
import { restoreTaskDraft } from "./task-draft.mjs";
import { fetchTrustedMedia, trustedMediaUrl } from "./media-url.mjs";
import { cookieImportItems } from "./cookie-batch.mjs";
import { credentialImportItems } from "./credential-batch.mjs";
import { isAllowedLoginUrl } from "./login-url.mjs";
import { completionRequestShape, parseManualSubmit } from "./manual-task.mjs";
import { registrationAction, registrationStepDelay, registrationTargetScript } from "./registration-flow.mjs";
import { baseUserAgent, defaultFingerprintParams, mergeMissingFingerprint } from "./browser-fingerprint.mjs";

const sourceRoot = path.dirname(fileURLToPath(import.meta.url));
const dolaUrl = "https://www.dola.com/chat";
let window;
let browserView;
let activeAccountId = "";
let browserBounds = { x: 310, y: 90, width: 760, height: 600 };
let store;
let provider;
let providerOrigin = "";
let providerKey = "";
let apiServer;
let apiOrigin = "";
let mihomo;
let observedTaskId = "";
const taskPolls = new Map();
const loginChecks = new Map();
let activeCookieListener;
let workspaceSubmissionView;
let registration;
let registrationNudgeTimer;
const loginPopups = new Set();
const pendingBrowserSubmits = new Map();
const registrationPageScript = `(() => {
  const buttons = [...document.querySelectorAll('button')].filter((button) => !button.disabled).map((button) => (button.innerText || button.getAttribute('aria-label') || '').trim());
  const has = (...labels) => buttons.some((button) => labels.includes(button));
  const text = document.body?.innerText || '';
  const visibleInput = (selector) => [...document.querySelectorAll(selector)].some((input) => {
    const rect = input.getBoundingClientRect();
    const style = getComputedStyle(input);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && !input.disabled;
  });
  return {
    origin: location.origin, path: location.pathname,
    blank: !text.trim() && performance.now() > 10000,
    pageUnavailable: text.includes('This page is temporarily unavailable') || text.includes('页面暂时不可用') || text.includes('页面暂时无法访问'),
    login: has('登录', 'Log in', 'Sign in'),
    googleLogin: buttons.some((button) => /(Google\\s*登录|Sign in with Google|Continue with Google)/i.test(button)),
    ageConfirm: (text.includes('已满18周岁') || /over 18|18\\+|18 years/i.test(text)) && has('确认', 'Confirm'),
    email: visibleInput('input[type="email"], #identifierId'),
    password: visibleInput('input[type="password"]'),
    notice: has('我了解', 'I understand'),
    allow: has('Allow', '允许', 'Cho phép'),
    oauthForDola: /dola\\.com|Dola Studio/i.test(text),
    deleted: text.includes('账号已被删除') || /account (?:was|has been) deleted/i.test(text),
    invalidAccount: text.includes('找不到您的 Google 账号') || text.includes("Couldn't find your Google Account"),
    invalidPassword: text.includes('密码错误') || text.includes('密码不正确') || text.includes('Wrong password'),
    serverError: text.includes('500.') && (text.includes('出现了错误') || /That.s an error/.test(text)),
    insecureBrowser: text.includes('此浏览器或应用可能不安全') || text.includes('This browser or app may not be secure'),
    challenge: text.includes('验证您的身份') || text.includes('验证您是人类') || text.includes("Verify it's you") || Boolean(document.querySelector('iframe[src*="recaptcha"]')),
  };
})()`;
const browserActionsScript = `(() => {
  if (document.getElementById('dola-studio-browser-actions')) return;
  const style = document.createElement('style');
  style.textContent = '#dola-studio-browser-actions{position:fixed;right:3px;top:50%;transform:translateY(-50%);z-index:2147483646;display:flex;flex-direction:column;gap:5px;pointer-events:none}#dola-studio-browser-actions button{width:27px;height:27px;padding:0;border:1px solid rgba(140,155,180,.4);border-radius:9px;background:rgba(20,29,48,.42);color:white;font:18px system-ui;cursor:pointer;opacity:.7;pointer-events:auto;transition:opacity .15s,background .15s}#dola-studio-browser-actions button:hover,#dola-studio-browser-actions button:focus-visible{opacity:.95;background:rgba(20,29,48,.75);outline:1px solid rgba(255,255,255,.5)}';
  const actions = document.createElement('div');
  actions.id = 'dola-studio-browser-actions';
  for (const [label, symbol, action] of [['返回上一页','←',() => history.back()],['刷新网页','↻',() => location.reload()],['下载当前无水印视频','↓',() => { location.href = 'dola-studio://download-video'; }],['关闭当前浏览器','×',() => { location.href = 'dola-studio://close'; }]]) {
    const button = document.createElement('button');
    button.type = 'button'; button.title = label; button.setAttribute('aria-label', label); button.textContent = symbol;
    button.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); action(); });
    actions.append(button);
  }
  document.documentElement.append(style, actions);
})()`;

// WebRTC 默认可能绕过代理直连暴露真实 IP；强制只走代理转发，避免账号代理被 ICE 候选泄漏。
app.commandLine.appendSwitch("force-webrtc-ip-handling-policy", "disable_non_proxied_udp");

const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) app.quit();
else app.whenReady().then(start).catch((error) => {
  dialog.showErrorBox("Dola Studio 启动失败", String(error?.message || error));
  app.quit();
});
app.on("second-instance", () => {
  if (window?.isMinimized()) window.restore();
  window?.show();
  window?.focus();
});
app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => {
  for (const timer of taskPolls.values()) clearTimeout(timer);
  clearInterval(registrationNudgeTimer);
  apiServer?.close();
  // provider 是 PyInstaller onefile：只 kill 引导进程会让 python、playwright
  // 驱动和已打开的 Camoufox 整棵树变孤儿（>15 秒提交的浏览器会存活数分钟）。
  // mac/linux 对整个进程组发 SIGTERM（uvicorn 优雅退出并关闭浏览器）；Windows
  // 用 taskkill 杀进程树；provider 内还有父进程看门狗兜底强退/崩溃场景。
  try {
    if (provider?.pid && process.platform !== "win32") process.kill(-provider.pid, "SIGTERM");
    else if (provider?.pid) spawn("taskkill", ["/pid", String(provider.pid), "/T", "/F"], { stdio: "ignore" });
  } catch {}
  provider?.kill();
  void mihomo?.close();
});

async function start() {
  if (!safeStorage.isEncryptionAvailable()) throw new Error("系统安全存储不可用，无法安全保存 Dola 登录态");
  const configPath = path.join(app.getPath("userData"), "workspace-location.json");
  let root = process.env.DOLA_WORKSPACE_DIR || path.join(app.getPath("documents"), "Dola Studio");
  if (!process.env.DOLA_WORKSPACE_DIR) try { root = JSON.parse(await readFile(configPath, "utf8")).root || root; } catch {}
  store = new WorkspaceStore(root, (value) => safeStorage.encryptString(value).toString("base64"), (value) => safeStorage.decryptString(Buffer.from(value, "base64")));
  await store.load();
  let interruptedSubmission = false;
  for (const task of store.state.tasks) if (task.source === "workspace-browser" && !task.conversationId && ["queued", "running", "accepted"].includes(task.status)) {
    task.status = "failed";
    task.error = "desktop_submission_interrupted";
    task.updatedAt = new Date().toISOString();
    interruptedSubmission = true;
  }
  if (interruptedSubmission) await store.save();
  const mihomoBinary = process.env.DOLA_MIHOMO_BINARY || path.join(app.isPackaged ? process.resourcesPath : path.resolve(sourceRoot, "../resources"), "sidecars", process.platform, process.arch, process.platform === "win32" ? "mihomo.exe" : "mihomo");
  mihomo = new MihomoManager(store.root, mihomoBinary);
  window = new BrowserWindow({
    width: 1500, height: 940, minWidth: 1100, minHeight: 680, title: "Dola Studio", backgroundColor: "#0b1022",
    ...(process.platform === "darwin" ? { titleBarStyle: "hiddenInset" } : {}),
    webPreferences: { preload: path.join(sourceRoot, "preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  registerIpc();
  await window.loadFile(path.join(sourceRoot, "index.html"));
  window.show();
  try { await startProvider(); window.webContents.send("dola:task", { type: "provider-ready" }); } catch (error) { window.webContents.send("dola:task", { type: "provider-error", message: String(error?.message || error) }); }
  await startApi();
  for (const task of store.state.tasks.filter((item) => ["queued", "running", "accepted"].includes(item.status) || item.error === "task_state_cookie_unavailable")) scheduleTaskPoll(task.id);
  if (process.env.DOLA_DESKTOP_REGISTRATION_TEST) {
    try {
      const [email, password] = String(process.env.DOLA_DESKTOP_REGISTRATION_TEST).split("|");
      if (!email || !password) throw new Error("DOLA_DESKTOP_REGISTRATION_TEST 需要 邮箱|密码");
      if (!providerOrigin) throw new Error("协议服务未就绪，无法保存登录态");
      window.setTitle("Dola Studio 批量注册测试");
      const fingerprintParams = process.env.DOLA_DESKTOP_REGISTRATION_FINGERPRINT ? process.env.DOLA_DESKTOP_REGISTRATION_FINGERPRINT.split(",").filter(Boolean) : defaultFingerprintParams();
      const proxyId = String(process.env.DOLA_DESKTOP_REGISTRATION_PROXY || "");
      const existing = store.state.accounts.find((item) => item.email?.toLowerCase() === email.toLowerCase());
      const account = existing?.email && store.password(existing.id) === password
        ? await store.updateAccount(existing.id, existing.proxyId === proxyId ? {} : { proxyId })
        : (await store.addCredentialAccounts(credentialImportItems({ text: `${email}|${password}` }), { group: "未分组", proxyId, fingerprintParams }))[0];
      console.log(`DOLA_REGISTRATION ${JSON.stringify({ event: "imported", email: account.email, fingerprint: account.fingerprint })}`);
      await startRegistration([account.id]);
      const shotDir = process.env.DOLA_DESKTOP_REGISTRATION_SHOTS;
      if (shotDir) await mkdir(shotDir, { recursive: true });
      let lastKey = "";
      const deadline = Date.now() + Number(process.env.DOLA_DESKTOP_REGISTRATION_TIMEOUT_MS || 30 * 60_000);
      while (Date.now() < deadline && registration) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const summary = registrationSummary();
        if (!summary) break;
        const key = `${summary.status}:${summary.index}:${summary.message}`;
        if (key !== lastKey) {
          lastKey = key;
          if (shotDir && !window.isDestroyed()) await writeFile(path.join(shotDir, `${Date.now()}.png`), (await window.webContents.capturePage()).toPNG()).catch(() => {});
          const targets = [...loginPopups, ...(browserView && !browserView.webContents.isDestroyed() ? [{ webContents: browserView.webContents }] : [])];
          for (const [index, entry] of targets.entries()) {
            if (entry.webContents.isDestroyed()) continue;
            const diagnostic = await entry.webContents.executeJavaScript(registrationPageScript, true).catch(() => null);
            const bodyText = await entry.webContents.executeJavaScript("document.body?.innerText?.slice(0, 200) || ''", true).catch(() => "");
            console.log(`DOLA_REGISTRATION_PAGE ${JSON.stringify({ window: entry.webContents.getURL(), page: diagnostic, bodyText })}`);
          }
          console.log(`DOLA_REGISTRATION ${JSON.stringify(summary)}`);
        }
        if (["completed", "failed"].includes(summary.status)) break;
      }
      console.log(`DOLA_REGISTRATION_FINAL ${JSON.stringify(registrationSummary() || { event: "stopped" })}`);
    } catch (error) { console.log(`DOLA_REGISTRATION_FINAL ${JSON.stringify({ error: String(error?.message || error) })}`); }
    app.quit();
    return;
  }
  if (process.env.DOLA_DESKTOP_SMOKE_SCREENSHOT) {
    if (["proxy", "api", "settings"].includes(process.env.DOLA_DESKTOP_SMOKE_PAGE || "")) await window.webContents.executeJavaScript(`document.querySelector('[data-page=${process.env.DOLA_DESKTOP_SMOKE_PAGE}]')?.click()`);
    await window.webContents.executeJavaScript("document.fonts.ready");
    await writeFile(process.env.DOLA_DESKTOP_SMOKE_SCREENSHOT, (await window.webContents.capturePage()).toPNG());
    console.log(JSON.stringify({ providerReady: Boolean(providerOrigin), apiOrigin, accountCount: store.state.accounts.length, title: window.getTitle() }));
    app.quit();
  }
}

function trusted(event) {
  if (event.sender !== window?.webContents || event.senderFrame?.url !== window.webContents.mainFrame.url) throw new Error("不可信的桌面页面");
}

function registerIpc() {
  ipcMain.on("dola:registration-dom", (event) => {
    if (event.sender === browserView?.webContents || [...loginPopups].some((popup) => popup.webContents === event.sender)) void driveRegistration(event.sender);
  });
  ipcMain.on("dola:browser-submit", (event, payload) => {
    if (event.sender !== browserView?.webContents || activeAccountId === "" || !/^https:\/\/www\.dola\.com\//.test(event.sender.getURL())) return;
    if (browserView === workspaceSubmissionView) return;
    const parsed = parseManualSubmit(payload?.url, payload?.body);
    if (parsed && typeof payload.key === "string") pendingBrowserSubmits.set(payload.key, { ...parsed, accountId: activeAccountId });
  });
  ipcMain.on("dola:browser-submit-ack", (event, payload) => {
    if (event.sender !== browserView?.webContents || !/^\d{12,32}$/.test(payload?.conversationId || "")) return;
    const pending = pendingBrowserSubmits.get(payload.key);
    pendingBrowserSubmits.delete(payload.key);
    if (pending && pending.accountId === activeAccountId) void adoptBrowserTask(pending, payload.conversationId).catch((error) => window?.webContents.send("dola:task", { type: "browser-error", message: `浏览器任务登记失败：${String(error?.message || error)}` }));
  });
  ipcMain.on("dola:browser-submit-end", (event, key) => { if (event.sender === browserView?.webContents) pendingBrowserSubmits.delete(key); });
  ipcMain.on("dola:browser-bounds", (event, value) => {
    trusted(event);
    if (!value || ![value.x, value.y, value.width, value.height].every(Number.isFinite)) return;
    browserBounds = { x: Math.max(0, Math.round(value.x)), y: Math.max(0, Math.round(value.y)), width: Math.max(0, Math.round(value.width)), height: Math.max(0, Math.round(value.height)) };
    browserView?.setBounds(browserBounds);
  });
  ipcMain.handle("dola:call", async (event, action, input = {}) => {
    trusted(event);
    switch (action) {
      case "state": return { accounts: store.listAccounts(), accountGroups: store.state.accountGroups, accountGroupProxies: store.state.accountGroupProxies, tasks: store.state.tasks, assets: store.state.assets, proxies: publicProxies(), settings: store.state.settings, workspace: store.root, downloadDir: downloadDirectory(), apiOrigin, providerReady: Boolean(providerOrigin), registration: registrationSummary() };
      case "account:add": validateAccountProxyId(input.proxyId); return store.addAccount(input);
      case "account:group-add": validateAccountProxyId(input.proxyId); return store.addGroup(input.name, input.proxyId);
      case "account:group-proxy": validateAccountProxyId(input.proxyId); await store.setGroupProxy(input.name, input.proxyId); if (store.state.accounts.some((item) => item.id === activeAccountId && item.group === input.name && !item.proxyId)) await refreshActiveAccountProxy(); return store.state.accountGroupProxies;
      case "account:update": {
        validateAccountProxyId(input.patch?.proxyId);
        const previous = store.state.accounts.find((item) => item.id === input.id);
        const route = previous && accountProxyId(previous, store.state);
        const updated = await store.updateAccount(input.id, input.patch || {});
        if (activeAccountId === input.id && route !== accountProxyId(updated, store.state)) await refreshActiveAccountProxy();
        return updated;
      }
      case "account:delete": {
        if (registration?.status === "running" && registration.ids.includes(input.id)) throw new Error("请先停止当前批量登录");
        if (activeAccountId === input.id) await hideBrowser();
        const removed = await store.deleteAccount(input.id);
        if (removed) {
          await mihomo.stop(input.id);
          await session.fromPartition(`persist:dola-${input.id}`).clearStorageData();
        }
        return removed;
      }
      case "account:open": if (registration?.status === "running" && registration.ids[registration.index] !== input.id) throw new Error("请先停止当前批量登录"); return openAccount(input.id);
      case "account:capture": return captureAccount(input.id);
      case "account:verify": return verifyAccount(input.id);
      case "account:import": return importAccounts(input);
      case "account:import-file": return chooseAccountImportFile();
      case "registration:import": return importRegistrationAccounts(input);
      case "registration:start": return startRegistration(input.ids);
      case "registration:stop": browserView?.webContents.send("dola:registration-observe", false); for (const popup of loginPopups) popup.webContents.send("dola:registration-observe", false); registration = undefined; window?.webContents.send("dola:task", { type: "registration", registration: null }); return true;
      case "registration:copy-password": {
        const id = registration?.ids[registration.index];
        if (registration?.status !== "running" || id !== input.id) throw new Error("当前账号不在批量登录中");
        const password = store.password(id);
        if (!password) throw new Error("未保存此账号的密码");
        clipboard.writeText(password);
        return true;
      }
      case "registration:copy-email": {
        const id = registration?.ids[registration.index];
        if (registration?.status !== "running" || id !== input.id) throw new Error("当前账号不在批量登录中");
        clipboard.writeText(store.state.accounts.find((item) => item.id === id)?.email || "");
        return true;
      }
      case "account:export": return exportAccounts(input.ids);
      case "account:export-group": return exportAccounts(store.state.accounts.filter((item) => item.group === input.group).map((item) => item.id), input.group);
      case "browser:reload": browserView?.webContents.reload(); return true;
      case "browser:back": if (browserView?.webContents.canGoBack()) browserView.webContents.goBack(); return true;
      case "browser:close": if (registration?.status === "running") { browserView?.webContents.send("dola:registration-observe", false); registration = undefined; window?.webContents.send("dola:task", { type: "registration", registration: null }); } await hideBrowser(); return true;
      case "task:create": return submitTask(input, true);
      case "task:replay": return replayTask(input.id);
      case "task:refresh": return refreshTask(input.id, true);
      case "task:open": if (registration?.status === "running") throw new Error("请先停止当前批量登录"); return openTask(input.id);
      case "task:unwatermark": return removeTaskWatermark(input.id);
      case "asset:choose": return chooseAssets();
      case "asset:ingest": return ingestAsset(input);
      case "asset:read": return readAsset(input.id);
      case "asset:thumbnail": return thumbnailAsset(input.id);
      case "asset:download": return downloadTaskAssets(input.id, input.ordinal);
      case "asset:download-many": return Promise.allSettled((input.ids || []).map(downloadTaskAssets)).then((items) => items.map((item) => item.status === "fulfilled" ? item.value : { error: String(item.reason) }));
      case "asset:show": {
        const asset = store.state.assets.find((item) => item.id === input.id);
        if (!asset) throw new Error("素材不存在");
        shell.showItemInFolder(asset.path);
        return true;
      }
      case "proxy:save": return saveProxies(input);
      case "proxy:import-groups": return saveProxies({ generic: [...publicProxies().generic, ...parseGenericProxyGroups(input.text)] });
      case "proxy:test": return testProxy(input.id);
      case "settings:save": return saveSettings(input);
      case "workspace:choose": return chooseWorkspace();
      case "workspace:open": await shell.openPath(store.root); return store.root;
      case "download:choose": return chooseDownloadDirectory();
      case "download:open": await mkdir(downloadDirectory(), { recursive: true }); await shell.openPath(downloadDirectory()); return downloadDirectory();
      case "api:new-key": return rotateApiKey();
      case "api:revoke": store.state.apiKeyDigest = ""; await store.save(); return true;
      case "external:open": if (input.url === "https://www.dola.com/") return shell.openExternal(input.url); throw new Error("无效地址");
      default: throw new Error("未知桌面操作");
    }
  });
}

// 账号身份首次使用时随机一次并随账号持久化；老账号只补缺失参数，不改动已保存取值。
async function accountIdentity(account) {
  const merged = mergeMissingFingerprint(account.fingerprint);
  if (JSON.stringify(merged) !== JSON.stringify(account.fingerprint || {})) {
    account.fingerprint = merged;
    await store.save();
  }
  return { userAgent: merged.userAgent || baseUserAgent(), acceptLanguage: merged.languages || undefined };
}

async function openAccount(id) {
  const account = store.state.accounts.find((item) => item.id === id);
  if (!account) throw new Error("账号不存在");
  await hideBrowser();
  const partition = session.fromPartition(`persist:dola-${id}`);
  partition.setPermissionRequestHandler((_contents, permission, callback) => callback(permission === "media"));
  await accountIdentity(account);
  const fingerprint = account.fingerprint;
  // 默认 UA 去掉 Electron/应用名 token，与随机 UA 一样保持「真实平台 + 真实 Chromium 版本」；
  // Accept-Language 同时生效，避免 HTTP 头与 navigator.languages 脱钩。
  partition.setUserAgent(fingerprint?.userAgent || baseUserAgent(), fingerprint?.languages || undefined);
  const fingerprintArguments = fingerprint ? ["--dola-fingerprint", JSON.stringify(fingerprint)] : [];
  await applyAccountProxy(account, partition);
  await partition.closeAllConnections();
  if (account.cookieCiphertext && !(await partition.cookies.get({ url: "https://www.dola.com" })).length) {
    for (const item of parseCookie(store.cookie(id)).split("; ")) {
      const separator = item.indexOf("=");
      await partition.cookies.set({ url: "https://www.dola.com", name: item.slice(0, separator), value: item.slice(separator + 1), secure: true });
    }
  }
  const view = new WebContentsView({ webPreferences: { session: partition, preload: path.join(sourceRoot, "browser-duration-unlocker.cjs"), sandbox: true, contextIsolation: false, nodeIntegration: false, webSecurity: true, additionalArguments: fingerprintArguments } });
  view.webContents.setWindowOpenHandler(({ url }) => url === "about:blank" || isAllowedLoginUrl(url) ? { action: "allow", overrideBrowserWindowOptions: { webPreferences: { session: partition, preload: path.join(sourceRoot, "browser-duration-unlocker.cjs"), sandbox: true, contextIsolation: false, nodeIntegration: false, webSecurity: true, additionalArguments: fingerprintArguments } } } : { action: "deny" });
  view.webContents.on("did-create-window", (popup) => {
    loginPopups.add(popup);
    popup.on("closed", () => loginPopups.delete(popup));
    const checkLoginNavigation = (event, url) => {
      if (url === "about:blank" || isAllowedLoginUrl(url)) return;
      event.preventDefault();
      const host = (() => { try { return new URL(url).hostname; } catch { return "未知地址"; } })();
      window?.webContents.send("dola:task", { type: "browser-error", message: `第三方登录跳转到未允许的域名：${host}` });
    };
    popup.webContents.on("will-navigate", checkLoginNavigation);
    popup.webContents.on("will-redirect", checkLoginNavigation);
    popup.webContents.on("did-fail-load", (_event, code, description) => {
      if (code !== -3) window?.webContents.send("dola:task", { type: "browser-error", message: `第三方登录页面加载失败：${description}` });
    });
    popup.webContents.on("did-finish-load", async () => {
      if (registration?.status === "running" && registration.ids[registration.index] === id) { popup.webContents.send("dola:registration-observe", true); void driveRegistration(popup.webContents); }
      if (!/^https:\/\/(?:[^/]+\.)?facebook\.com\//i.test(popup.webContents.getURL())) return;
      const error = await popup.webContents.executeJavaScript("document.querySelector('#error_box, .login_error_box, [role=alert]')?.innerText?.trim().slice(0, 300) || ''", true).catch(() => "");
      if (error) window?.webContents.send("dola:task", { type: "browser-error", message: `Facebook 登录反馈：${error}` });
    });
  });
  view.webContents.on("will-navigate", (event, url) => {
    if (url === "dola-studio://close") { event.preventDefault(); void hideBrowser().then(() => window?.webContents.send("dola:task", { type: "browser-closed" })); }
    else if (url === "dola-studio://download-video") { event.preventDefault(); void downloadCurrentBrowserVideo().catch((error) => window?.webContents.send("dola:task", { type: "browser-error", message: String(error?.message || error) })); }
    else if (!isAllowedLoginUrl(url)) event.preventDefault();
  });
  view.webContents.on("did-fail-load", (_event, code, description) => { if (code !== -3) window?.webContents.send("dola:task", { type: "browser-error", message: `网页加载失败：${description}` }); });
  view.webContents.on("preload-error", (_event, _preloadPath, error) => window?.webContents.send("dola:task", { type: "browser-error", message: `浏览器时长选项加载失败：${error.message}` }));
  view.webContents.on("did-finish-load", () => { void showBrowserActions(view); void captureAccountIfReady(id); if (registration?.status === "running" && registration.ids[registration.index] === id) { view.webContents.send("dola:registration-observe", true); void driveRegistration(view.webContents); } });
  view.webContents.on("did-navigate-in-page", () => { void showBrowserActions(view); void captureAccountIfReady(id); if (registration?.status === "running" && registration.ids[registration.index] === id) void driveRegistration(view.webContents); });
  activeCookieListener = () => { if (activeAccountId === id) void captureAccountIfReady(id); };
  partition.cookies.on("changed", activeCookieListener);
  window.contentView.addChildView(view);
  view.setBounds(browserBounds);
  browserView = view;
  activeAccountId = id;
  const contents = view.webContents;
  void contents.loadURL(dolaUrl).catch((error) => {
    if (!contents.isDestroyed() && activeAccountId === id) window?.webContents.send("dola:task", { type: "browser-error", message: `Dola 页面加载失败：${String(error?.message || error)}，请检查代理后点击刷新` });
  });
  return { accountId: id, url: dolaUrl };
}

async function showBrowserActions(view) {
  if (!view || !/^https:\/\/www\.dola\.com\//.test(view.webContents.getURL())) return;
  await view.webContents.executeJavaScript(browserActionsScript, true).catch(() => {});
}

async function hideBrowser() {
  pendingBrowserSubmits.clear();
  for (const popup of loginPopups) if (!popup.isDestroyed()) popup.close();
  loginPopups.clear();
  if (browserView) {
    browserView.webContents.stop();
    if (activeCookieListener) browserView.webContents.session.cookies.removeListener("changed", activeCookieListener);
    activeCookieListener = undefined;
    window.contentView.removeChildView(browserView); browserView.webContents.close(); browserView = undefined;
  }
  activeAccountId = "";
}

async function adoptBrowserTask(input, conversationId) {
  if (store.state.tasks.some((item) => item.accountId === input.accountId && item.conversationId === conversationId)) return;
  const account = store.state.accounts.find((item) => item.id === input.accountId);
  if (!account || activeAccountId !== account.id || !browserView) return;
  const cookies = await browserView.webContents.session.cookies.get({ url: "https://www.dola.com" });
  const cookie = cookies.filter((item) => item.value).map((item) => `${item.name}=${item.value}`).join("; ");
  if (!cookie) throw new Error("浏览器账号尚未登录 Dola，无法跟踪任务");
  const proxy = await resolveAccountProxy(account);
  const identity = await accountIdentity(account);
  const id = `dola-${randomUUID()}`;
  const registered = await providerJson("/internal/runtime/v1/tasks/adopt-browser", { method: "POST", body: JSON.stringify({ taskId: id, conversationId, model: input.model, identity: input.identity, accountId: account.id, credentialVersion: account.credentialVersion, cookie, proxyMode: proxy.url ? "managed" : "direct", proxySource: proxy.source, proxyUrl: proxy.url, proxyTarget: proxy.name, ...identity }) });
  if (store.state.tasks.some((item) => item.id === registered.id)) return;
  const now = new Date().toISOString();
  const task = { id: registered.id || id, accountId: account.id, credentialVersion: account.credentialVersion, model: input.model, prompt: input.prompt || "浏览器内提交的生成任务", duration: input.duration, ratio: input.ratio, status: registered.status || "accepted", references: input.references, conversationId, createdAt: now, updatedAt: now, resultUrls: [], source: "browser", requestShape: input.requestShape };
  store.state.tasks.unshift(task);
  await store.save();
  window?.webContents.send("dola:task", { type: "task", task });
  scheduleTaskPoll(task.id);
}

async function downloadCurrentBrowserVideo() {
  const conversationId = browserView?.webContents.getURL().match(/^https:\/\/www\.dola\.com\/chat\/(\d{12,32})(?:[/?#]|$)/)?.[1];
  const task = store.state.tasks.find((item) => item.accountId === activeAccountId && item.conversationId === conversationId && item.model !== "dola-seedream-4-5");
  if (!task) throw new Error("当前会话尚未登记为视频任务，请从右侧任务栏选择已识别的任务");
  const current = await refreshTask(task.id, true);
  if (current.status !== "completed" || !current.resultUrls.length) throw new Error("当前视频尚未生成完成");
  if (!current.unwatermarkedUrl) await removeTaskWatermark(task.id);
  const saved = await downloadTaskAssets(task.id, 0);
  window?.webContents.send("dola:task", { type: "download-complete", message: `无水印视频已保存：${saved.files[0] || downloadDirectory()}` });
}

async function captureAccount(id) {
  if (id !== activeAccountId) throw new Error("请先打开此账号");
  const cookies = await browserView.webContents.session.cookies.get({ url: "https://www.dola.com" });
  if (!cookies.length) throw new Error("当前页面没有 Dola Cookie，请先完成登录");
  const header = cookies.filter((cookie) => cookie.value).map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
  return store.updateAccount(id, { cookie: header });
}

async function captureAccountIfReady(id) {
  if (!providerOrigin || id !== activeAccountId || !browserView) return;
  if (loginChecks.has(id)) { loginChecks.set(id, "again"); return; }
  loginChecks.set(id, "running");
  try {
    const cookies = await browserView.webContents.session.cookies.get({ url: "https://www.dola.com" });
    const header = cookies.filter((cookie) => cookie.value).map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
    if (!header || store.state.accounts.find((item) => item.id === id)?.cookieFingerprint === store.fingerprint(header)) return;
    const account = store.state.accounts.find((item) => item.id === id);
    const proxy = await resolveAccountProxy(account);
    const identity = await accountIdentity(account);
    const result = await providerJson("/internal/runtime/v1/accounts/inspect", { method: "POST", body: JSON.stringify({ accountId: id, credentialVersion: account.credentialVersion, cookie: header, proxyMode: proxy.url ? "managed" : "direct", proxySource: proxy.source, proxyUrl: proxy.url, proxyTarget: proxy.name, authOnly: true, ...identity }) });
    if ((result.loginState || result.login_state || result.status) !== "ready") return;
    await store.updateAccount(id, { cookie: header, status: "ready" });
    window?.webContents.send("dola:task", { type: "account-saved" });
    if (registration?.status === "running" && registration.ids[registration.index] === id) void advanceRegistration();
  } catch { /* Login can still be in progress. */ }
  finally {
    const again = loginChecks.get(id) === "again";
    loginChecks.delete(id);
    if (again) void captureAccountIfReady(id);
  }
}

async function verifyAccount(id) {
  const account = store.state.accounts.find((item) => item.id === id);
  if (!account || !store.cookie(id)) throw new Error("账号还没有登录信息");
  const proxy = await resolveAccountProxy(account);
  const identity = await accountIdentity(account);
  const result = await providerJson("/internal/runtime/v1/accounts/inspect", { method: "POST", body: JSON.stringify({ accountId: id, credentialVersion: account.credentialVersion, cookie: store.cookie(id), proxyMode: proxy.url ? "managed" : "direct", proxySource: proxy.source, proxyUrl: proxy.url, proxyTarget: proxy.name, authOnly: false, ...identity }) });
  const state = result.loginState || result.login_state || result.status || "需检查";
  await store.updateAccount(id, { status: state, quota: result.quota || [] });
  return result;
}

async function importAccounts(input) {
  const outcomes = [];
  for (const item of cookieImportItems(input)) {
    try { outcomes.push({ file: item.file, line: item.line, account: await store.addAccount({ name: input.name ? `${input.name} ${outcomes.length + 1}` : "", group: input.group || "未分组", cookie: item.cookie }) }); }
    catch (error) { outcomes.push({ file: item.file, line: item.line, error: String(error?.message || error) }); }
  }
  return outcomes;
}

function registrationSummary() {
  if (!registration) return null;
  const account = store.state.accounts.find((item) => item.id === registration.ids[registration.index]);
  return { status: registration.status, accountId: account?.id || "", email: account?.email || "", index: registration.index + 1, total: registration.ids.length, message: registration.message || "", error: registration.error || "" };
}

function updateRegistrationMessage(batch, message) {
  if (registration !== batch || batch.message === message) return;
  batch.message = message;
  window?.webContents.send("dola:task", { type: "registration", registration: registrationSummary() });
}

async function clickRegistrationTarget(contents, origin, selector, labels = []) {
  let point = await contents.executeJavaScript(registrationTargetScript(origin, selector, labels), true);
  if (!point || new URL(contents.getURL()).origin !== origin) return false;
  contents.getOwnerBrowserWindow()?.focus();
  contents.focus();
  if (point.y < 0 || point.y >= point.height || point.x < 0 || point.x >= point.width) point = await contents.executeJavaScript(registrationTargetScript(origin, selector, labels, true), true);
  if (!point || point.y < 0 || point.y >= point.height || point.x < 0 || point.x >= point.width || new URL(contents.getURL()).origin !== origin) return false;
  for (const event of [{ type: "mouseMove" }, { type: "mouseDown", button: "left", clickCount: 1 }, { type: "mouseUp", button: "left", clickCount: 1 }]) contents.sendInputEvent({ ...event, x: point.x, y: point.y });
  return true;
}

async function typeGoogleCredential(contents, kind, value) {
  if (new URL(contents.getURL()).origin !== "https://accounts.google.com") return false;
  const selector = kind === "email" ? 'input[type="email"], #identifierId' : 'input[type="password"]';
  if (!(await clickRegistrationTarget(contents, "https://accounts.google.com", selector))) return false;
  if (new URL(contents.getURL()).origin !== "https://accounts.google.com") return false;
  await contents.insertText(value);
  return clickRegistrationTarget(contents, "https://accounts.google.com", "button", ["下一步", "Next"]);
}

async function driveRegistration(contents) {
  const batch = registration;
  if (!batch || batch.status !== "running" || !contents || contents.isDestroyed()) return;
  if (batch.driving) { batch.pendingContents = contents; return; }
  batch.driving = true;
  try {
    const id = batch.ids[batch.index];
    if (activeAccountId !== id) return;
    const page = await contents.executeJavaScript(registrationPageScript, true);
    if (registration !== batch || batch.status !== "running" || activeAccountId !== id) return;
    const action = registrationAction(page);
    if (action.type === "error") {
      batch.status = "failed";
      batch.error = action.message;
      contents.send("dola:registration-observe", false);
      window?.webContents.send("dola:task", { type: "registration", registration: registrationSummary() });
      return;
    }
    updateRegistrationMessage(batch, action.message);
    if (["approval", "wait"].includes(action.type)) return;
    const actionKey = `${contents.id}:${page.origin}:${page.path}:${action.type}`;
    if (batch.lastAction === actionKey && Date.now() - (batch.lastActionAt || 0) < 5000) return;
    await new Promise((resolve) => setTimeout(resolve, registrationStepDelay()));
    if (registration !== batch || batch.status !== "running" || contents.isDestroyed() || activeAccountId !== id) return;
    batch.lastAction = actionKey;
    batch.lastActionAt = Date.now();
    let acted = false;
    if (action.type === "email" || action.type === "password") {
      const account = store.state.accounts.find((item) => item.id === id);
      acted = await typeGoogleCredential(contents, action.type, action.type === "email" ? account.email : store.password(id));
    } else if (action.type === "reload") {
      contents.reload();
      acted = true;
    } else {
      const targets = {
        "click-reload": ["https://www.dola.com", ["Refresh", "刷新", "重新加载", "重试"]],
        "click-login": ["https://www.dola.com", ["登录", "Log in", "Sign in"]],
        "click-google": ["https://www.dola.com", ["Google 登录", "Sign in with Google", "Continue with Google"]],
        "click-notice": ["https://accounts.google.com", ["我了解", "I understand"]],
        "click-allow": ["https://accounts.google.com", ["Allow", "允许", "Cho phép"]],
        "click-age": ["https://www.dola.com", ["确认"]],
      };
      const target = targets[action.type];
      acted = target ? await clickRegistrationTarget(contents, target[0], "button", target[1]) : false;
    }
    if (registration === batch) {
      if (acted) {
        batch.pendingContents = contents;
        setTimeout(() => { if (registration === batch && batch.status === "running" && !contents.isDestroyed()) void driveRegistration(contents); }, 5200);
      } else batch.lastAction = "";
    }
  } catch {
    if (registration === batch) { batch.lastAction = ""; updateRegistrationMessage(batch, "页面操作未完成，请检查当前登录页面"); }
  } finally {
    batch.driving = false;
    const pending = batch.pendingContents;
    batch.pendingContents = undefined;
    if (pending && registration === batch && batch.status === "running") void driveRegistration(pending);
  }
}

async function importRegistrationAccounts(input) {
  const items = credentialImportItems(input);
  const proxyId = String(input.proxyId || "");
  validateAccountProxyId(proxyId);
  const fingerprintParams = Array.isArray(input.fingerprintParams) ? input.fingerprintParams : defaultFingerprintParams();
  const accounts = await store.addCredentialAccounts(items, { group: String(input.group || ""), proxyId, fingerprintParams });
  return accounts.map((account, index) => ({ id: account.id, email: account.email, file: items[index].file, line: items[index].line }));
}

function startRegistrationNudge() {
  clearInterval(registrationNudgeTimer);
  registrationNudgeTimer = setInterval(() => {
    if (!registration || registration.status !== "running") { clearInterval(registrationNudgeTimer); return; }
    if (browserView && !browserView.webContents.isDestroyed()) void driveRegistration(browserView.webContents);
    for (const popup of loginPopups) if (!popup.isDestroyed()) void driveRegistration(popup.webContents);
  }, 10_000);
}

async function startRegistration(ids) {
  if (registration?.status === "running") throw new Error("已有批量登录正在执行");
  if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length || ids.some((id) => !store.state.accounts.some((item) => item.id === id && item.email && item.passwordCiphertext && item.status !== "ready"))) throw new Error("请选择本次导入且尚未登录的账号");
  registration = { ids, index: 0, status: "running", message: "正在打开 Dola 页面…", error: "", lastAction: "" };
  try { await openAccount(ids[0]); }
  catch (error) { registration = undefined; throw error; }
  startRegistrationNudge();
  window?.webContents.send("dola:task", { type: "registration", registration: registrationSummary() });
  return registrationSummary();
}

async function advanceRegistration() {
  if (!registration || registration.status !== "running") return;
  const batch = registration;
  batch.index += 1;
  if (batch.index >= batch.ids.length) {
    batch.index = batch.ids.length - 1;
    batch.status = "completed";
    batch.message = "所有账号已通过 Dola 登录态验证并独立保存";
    clearInterval(registrationNudgeTimer);
    browserView?.webContents.send("dola:registration-observe", false);
    window?.webContents.send("dola:task", { type: "registration", registration: registrationSummary() });
    return;
  }
  batch.lastAction = "";
  batch.lastActionAt = 0;
  batch.message = "正在打开下一个 Dola 页面…";
  try { await openAccount(batch.ids[batch.index]); }
  catch (error) { if (registration === batch) { batch.status = "failed"; batch.error = String(error?.message || error); } }
  if (registration !== batch) return;
  window?.webContents.send("dola:task", { type: "registration", registration: registrationSummary() });
}

async function chooseAccountImportFile() {
  const selected = await dialog.showOpenDialog(window, { properties: ["openFile", "multiSelections"], filters: [{ name: "Cookie 文本", extensions: ["txt"] }] });
  if (selected.canceled || !selected.filePaths.length) return [];
  return Promise.all(selected.filePaths.map(async (file) => ({ name: path.basename(file), text: await readFile(file, "utf8") })));
}

async function exportAccounts(ids, group = "") {
  const selected = store.state.accounts.filter((item) => Array.isArray(ids) && ids.includes(item.id) && item.cookieCiphertext);
  if (!selected.length) throw new Error("没有可导出的账号");
  const result = await dialog.showSaveDialog(window, { defaultPath: group ? `dola-cookies-${String(group).replace(/[^\p{L}\p{N}_-]/gu, "_")}.txt` : "dola-cookies.txt", filters: [{ name: "文本文件", extensions: ["txt"] }] });
  if (result.canceled || !result.filePath) return { cancelled: true };
  await writeFile(result.filePath, selected.map((item) => store.cookie(item.id)).join("\n") + "\n", { mode: 0o600 });
  await chmod(result.filePath, 0o600);
  return { count: selected.length, path: result.filePath };
}

async function resolveProxy(id, accountId) {
  if (!id) { await mihomo.stop(accountId); return { source: "direct", url: "", name: "直连" }; }
  const generic = store.state.proxies.generic.find((item) => item.id === id);
  if (generic) return { source: "generic", url: await mihomo.ensure(accountId, genericMihomoNode({ ...generic, url: store.decrypt(generic.urlCiphertext) }, generic.name)), name: generic.name };
  throw new Error("该代理节点不存在");
}

async function resolveAccountProxy(account) {
  return resolveProxy(configuredProxyId(accountProxyId(account, store.state)), account.id);
}

async function applyAccountProxy(account, partition) {
  const proxy = await resolveAccountProxy(account);
  await partition.setProxy(proxy.url ? { proxyRules: proxy.url, proxyBypassRules: store.state.settings.browserStaticDirect !== false ? "sf-flow-web-cdn.ciciai.com,sf16-website-login.neutral.ttwstatic.com,lf-flow-web-cdn.doubao.com" : "" } : { mode: "direct" });
  await partition.closeAllConnections();
}

async function refreshActiveAccountProxy() {
  if (!browserView || !activeAccountId) return;
  const account = store.state.accounts.find((item) => item.id === activeAccountId);
  try {
    await applyAccountProxy(account, browserView.webContents.session);
    const media = await mediaSession(account);
    await media.closeAllConnections();
    browserView.webContents.reload();
  } catch (error) {
    await hideBrowser();
    window?.webContents.send("dola:task", { type: "browser-closed" });
    window?.webContents.send("dola:task", { type: "browser-error", message: `代理设置已保存，当前网页已关闭：${error.message}` });
  }
}

function validateAccountProxyId(id) {
  if ([undefined, "", "direct"].includes(id)) return;
  if (!store.state.proxies.generic.some((item) => item.id === id)) throw new Error("请选择有效的通用代理节点");
}

async function saveProxies(input) {
  const generic = Array.isArray(input.generic) ? input.generic.map((item) => {
    const previous = store.state.proxies.generic.find((stored) => stored.id === item.id);
    const keepAddress = previous && !item.replaceUrl && (!item.url || item.url === publicProxyUrl(previous));
    const url = keepAddress ? null : new URL(normalizeGenericProxyUrl(item.url));
    return { id: String(item.id || randomUUID()), name: String(item.name || previous?.name || url?.hostname).trim().slice(0, 80), group: String(item.group || "未分组").trim().slice(0, 60), urlCiphertext: keepAddress ? previous.urlCiphertext : store.encrypt(url.toString()) };
  }) : store.state.proxies.generic;
  store.state.proxies.generic = generic;
  await store.save();
  return publicProxies();
}

function publicProxies() {
  return {
    generic: store.state.proxies.generic.map(({ urlCiphertext: _url, ...item }) => ({ ...item, url: publicProxyUrl({ urlCiphertext: _url }) })),
  };
}

function publicProxyUrl(item) {
  const url = new URL(store.decrypt(item.urlCiphertext));
  return `${url.protocol}//${url.hostname}:${url.port}`;
}

async function testProxy(id) {
  const landing = store.state.proxies.generic.find((item) => item.id === id);
  if (!landing) throw new Error("代理节点不存在");
  const node = genericMihomoNode({ ...landing, url: store.decrypt(landing.urlCiphertext) }, landing.name);
  const key = `test-${randomUUID()}`;
  const testSession = session.fromPartition(key);
  const started = Date.now();
  try {
    const url = await mihomo.ensure(key, node);
    await testSession.setProxy({ proxyRules: url });
    const response = await testSession.fetch("https://www.dola.com/", { method: "GET", signal: AbortSignal.timeout(15_000) });
    await response.body?.cancel();
    return { connected: true, status: response.status, latencyMs: Date.now() - started };
  } catch (error) { return { connected: false, latencyMs: Date.now() - started, error: String(error?.message || error).slice(0, 160) }; }
  finally { await mihomo.stop(key); await testSession.clearStorageData(); }
}

async function submitTask(input, fromWorkspace = false) {
  const account = store.state.accounts.find((item) => item.id === input.accountId);
  if (!account || (!fromWorkspace && !account.cookieCiphertext)) throw new Error("请先从左侧选择已登录的 Dola 账号");
  let cookie = store.cookie(account.id);
  if (fromWorkspace) {
    if (activeAccountId !== account.id || !browserView || browserView.webContents.isDestroyed() || !/^https:\/\/www\.dola\.com\//.test(browserView.webContents.getURL())) throw new Error("请先在中间浏览器打开此账号的 Dola 页面");
    const current = await browserView.webContents.session.cookies.get({ url: "https://www.dola.com" });
    cookie = current.filter((item) => item.name && item.value).map((item) => `${item.name}=${item.value}`).join("; ");
    if (!cookie) throw new Error("当前浏览器没有 Dola 登录 Cookie，请先完成登录");
    if (store.fingerprint(cookie) !== account.cookieFingerprint) await store.updateAccount(account.id, { cookie, status: "ready" });
  }
  const model = String(input.model || "");
  const isImage = model === "dola-seedream-4-5";
  if (!["dola-seedance-2-5", "dola-seedance-2-0-fast", "dola-seedream-4-5"].includes(model)) throw new Error("模型不受支持");
  const prompt = String(input.prompt || "").trim();
  if (!prompt || prompt.length > 20_000) throw new Error("提示词为空或过长");
  const references = Array.isArray(input.references) ? input.references.map((item) => ({ id: String(item.id || ""), dataUrl: String(item.dataUrl || ""), name: String(item.name || ""), role: item.role === "first_frame" || item.role === "last_frame" ? item.role : "reference", type: "image" })).filter((item) => item.dataUrl) : [];
  if (references.some((item) => item.dataUrl.length > 35_000_000)) throw new Error("参考素材过大");
  if (references.some((item) => item.role === "last_frame") !== references.some((item) => item.role === "first_frame")) throw new Error("首尾帧必须同时提供");
  const proxy = await resolveAccountProxy(account);
  const uploadProxy = references.length ? await resolveProxy(store.state.settings.imagexUploadProxyId, "imagex-upload") : { url: "" };
  const identity = await accountIdentity(account);
  const requestId = String(input.requestId || randomUUID());
  const body = { accountId: account.id, credentialVersion: account.credentialVersion, cookie, model, prompt, duration: isImage ? 0 : Number(input.duration || 5), ratio: String(input.ratio || "16:9"), references: references.map(({ id: _id, ...item }) => item), requestId, proxyMode: proxy.url ? "managed" : "direct", proxySource: proxy.source, proxyTarget: proxy.name, proxyUrl: proxy.url, imagexProxyMode: uploadProxy.url ? "managed" : "direct", imagexProxyUrl: uploadProxy.url, ...identity };
  // >15 秒档必须走 provider 的 Camoufox 协议提交（与 Web 端同一请求构造和
  // 签名链路，9-27/9-29 的 30 秒成功样本均出自该链路）；工作区浏览器签名
  // 提交对该档位会被上游会话模型以“仅支持 4 到 15 秒”追问拦截。
  const overQuarterMinute = !isImage && body.duration > 15;
  if (fromWorkspace && !overQuarterMinute) {
    if (workspaceSubmissionView) throw new Error("当前浏览器已有任务正在提交，请等待它取得 Dola 会话");
    const task = { id: `dola-${randomUUID()}`, accountId: account.id, credentialVersion: account.credentialVersion, model, prompt, duration: body.duration, ratio: body.ratio, status: "running", references: references.map((item) => ({ id: item.id, name: item.name, role: item.role })), conversationId: "", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), resultUrls: [], source: "workspace-browser", diagnostics: { submitStage: references.length ? "uploading_references" : "submitting_to_dola", referenceCount: references.length } };
    store.state.tasks.unshift(task);
    await store.save();
    const view = browserView;
    workspaceSubmissionView = view;
    void submitThroughWorkspaceBrowser(task, body, view).finally(() => { if (workspaceSubmissionView === view) workspaceSubmissionView = undefined; });
    return task;
  }
  const endpoint = isImage ? "/internal/runtime/v1/images" : "/internal/runtime/v1/videos";
  const created = await providerJson(endpoint, { method: "POST", body: JSON.stringify(body) });
  const id = created.taskId || created.id;
  if (!id) throw new Error("Dola 未返回任务 ID，请检查上游响应，避免重复提交");
  const task = { id, accountId: account.id, credentialVersion: account.credentialVersion, model, prompt, duration: body.duration, ratio: body.ratio, status: created.status || "queued", references: references.map((item) => ({ id: item.id, name: item.name, role: item.role })), conversationId: created.conversationId || "", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), resultUrls: [], source: overQuarterMinute ? "provider-protocol" : undefined, diagnostics: overQuarterMinute ? { submitStage: "protocol_submitting", referenceCount: references.length } : undefined };
  store.state.tasks.unshift(task);
  await store.save();
  if (!overQuarterMinute) {
    observedTaskId = id;
    void observeTaskInBrowser(task).catch((error) => window?.webContents.send("dola:task", { type: "browser-error", message: String(error) }));
  }
  scheduleTaskPoll(id);
  return task;
}

async function submitThroughWorkspaceBrowser(task, request, view) {
  const ensurePage = () => {
    if (activeAccountId !== task.accountId || browserView !== view || view.webContents.isDestroyed() || !/^https:\/\/www\.dola\.com\//.test(view.webContents.getURL())) throw new Error("提交期间账号浏览器已关闭或切换；尚未向 Dola 提交");
  };
  const liveCookie = async () => {
    const cookies = await view.webContents.session.cookies.get({ url: "https://www.dola.com" });
    return cookies.filter((item) => item.name && item.value).map((item) => `${item.name}=${item.value}`).join("; ");
  };
  try {
    ensurePage();
    const resolvedReferences = [];
    if (request.references.length) {
      const upload = await providerJson("/internal/runtime/v1/browser-submit/upload-script");
      for (const [index, reference] of request.references.entries()) {
        ensurePage();
        const result = await view.webContents.executeJavaScript(`(${upload.script})(${JSON.stringify({ body: upload.body })})`);
        if (!result?.ok || result?.json?.code !== 0 || !result.json?.data) throw new Error(`第 ${index + 1} 张素材的 Dola 上传授权失败：${result?.json?.code ?? result?.status ?? "unknown"}`);
        let uploaded;
        try {
          uploaded = await providerJson("/internal/runtime/v1/browser-submit/prepare", { method: "POST", body: JSON.stringify({ ...request, references: [reference], uploadConfig: result.json.data }) });
        } catch (error) {
          throw new Error(`第 ${index + 1}/${request.references.length} 张素材“${reference.name}”上传失败：${String(error?.message || error).replace(/^reference_1_of_1:\s*/, "")}`);
        }
        resolvedReferences.push(uploaded.resolvedReferences[0]);
        task.diagnostics = { submitStage: "uploading_references", referenceCount: request.references.length, uploadedCount: index + 1 };
        task.updatedAt = new Date().toISOString();
        await store.save();
        window?.webContents.send("dola:task", { type: "task", task });
      }
    }
    const prepared = await providerJson("/internal/runtime/v1/browser-submit/prepare", { method: "POST", body: JSON.stringify({ ...request, references: resolvedReferences }) });
    task.requestShape = completionRequestShape(prepared.body);
    ensurePage();
    const rulePrimed = Boolean(prepared.ruleBody);
    task.diagnostics = { submitStage: rulePrimed ? "rule_priming" : "submitting_to_dola", referenceCount: prepared.referenceCount };
    task.updatedAt = new Date().toISOString();
    await store.save();
    window?.webContents.send("dola:task", { type: "task", task });
    const config = { body: JSON.stringify(prepared.body), ruleBody: rulePrimed ? JSON.stringify(prepared.ruleBody) : "", fallbackQuery: "", timeoutMs: 60_000, hookDeadline: Date.now() + 40_000 };
    await view.webContents.executeJavaScript(`window.__DOLA_SUBMIT_CONFIG__ = ${JSON.stringify(config)}; ${prepared.script}`);
    let raw = "";
    const deadline = Date.now() + (rulePrimed ? 150_000 : 70_000);
    while (!raw && Date.now() < deadline) {
      ensurePage();
      raw = await view.webContents.executeJavaScript("document.getElementById('__dola_submit_result__')?.value || ''");
      if (!raw) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!raw) throw new Error("Dola 页面协议提交未返回结果");
    const cookie = await liveCookie();
    const parsed = await providerJson("/internal/runtime/v1/browser-submit/parse", { method: "POST", body: JSON.stringify({ payload: JSON.parse(raw), cookie, proxyUrl: request.proxyUrl }) });
    task.diagnostics = parsed.diagnostics || {};
    if (parsed.status !== "accepted" || !parsed.conversationId) throw new Error(parsed.error || "Dola 未创建会话");
    const registered = await providerJson("/internal/runtime/v1/tasks/adopt-browser", { method: "POST", body: JSON.stringify({ taskId: task.id, conversationId: parsed.conversationId, model: task.model, identity: parsed.identity, accountId: task.accountId, credentialVersion: task.credentialVersion, cookie, proxyMode: request.proxyMode, proxySource: request.proxySource, proxyUrl: request.proxyUrl, proxyTarget: request.proxyTarget }) });
    task.status = registered.status || "accepted";
    task.conversationId = parsed.conversationId;
    task.error = "";
    task.updatedAt = new Date().toISOString();
    await store.save();
    window?.webContents.send("dola:task", { type: "task", task });
    scheduleTaskPoll(task.id);
    void observeTaskInBrowser(task).catch((error) => window?.webContents.send("dola:task", { type: "browser-error", message: String(error) }));
  } catch (error) {
    task.status = "failed";
    task.error = String(error?.message || error).slice(0, 500);
    task.updatedAt = new Date().toISOString();
    await store.save();
    window?.webContents.send("dola:task", { type: "task", task });
  }
}

async function replayTask(id) {
  const task = store.state.tasks.find((item) => item.id === id);
  if (task?.source === "browser" && !task.prompt) await refreshTask(id, true);
  if (task?.source === "browser" && task.references?.some((item) => !item.id && item.url)) {
    const account = store.state.accounts.find((item) => item.id === task.accountId);
    if (!account) throw new Error("任务账号不存在");
    const partition = await mediaSession(account);
    for (const reference of task.references) {
      if (reference.id || !reference.url) continue;
      const response = await fetchTrustedMedia(partition.fetch.bind(partition), reference.url);
      if (!response.ok) throw new Error(`参考素材“${reference.name}”下载失败：HTTP ${response.status}`);
      const mime = response.headers.get("content-type")?.split(";", 1)[0] || "";
      if (!["image/png", "image/jpeg", "image/webp"].includes(mime)) throw new Error(`参考素材“${reference.name}”格式不受支持`);
      const bytes = await readBrowserReference(response);
      const saved = await ingestAsset({ name: reference.name, dataUrl: `data:${mime};base64,${bytes.toString("base64")}` });
      reference.id = saved.id;
    }
    await store.save();
  }
  return restoreTaskDraft(task, readAsset, store.state.assets);
}

async function readBrowserReference(response) {
  const maxBytes = 20 * 1024 * 1024; // Same limit as ingestAsset.
  if (Number(response.headers.get("content-length") || 0) > maxBytes || !response.body) throw new Error("参考素材超过 20 MB");
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) { await reader.cancel(); throw new Error("参考素材超过 20 MB"); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, total);
}

async function queryTaskInBrowser(task) {
  if (registration?.status === "running") throw new Error("请先停止当前批量登录");
  await openTask(task.id);
  const view = browserView;
  const prepared = await providerJson(`/internal/runtime/v1/tasks/${encodeURIComponent(task.id)}/browser-query`);
  const expectedUrl = `https://www.dola.com/chat/${task.conversationId}`;
  const ensurePage = () => {
    const currentUrl = view.webContents.isDestroyed() ? "" : view.webContents.getURL();
    if (browserView !== view || activeAccountId !== task.accountId || view.webContents.isDestroyed() || currentUrl !== expectedUrl) {
      const bounced = /^https:\/\/www\.dola\.com\/?$/.test(currentUrl) || /^https:\/\/www\.dola\.com\/chat\/?$/.test(currentUrl);
      throw new Error(bounced
        ? "Dola 把会话页重定向回了首页，通常是该账号在浏览器中的登录态已失效；请在中间浏览器重新登录此账号后再查询"
        : "查询期间任务账号浏览器已关闭、切换或离开原会话");
    }
  };
  ensurePage();
  const config = { path: prepared.path, body: JSON.stringify(prepared.body), resultId: `__dola_query_${randomUUID()}`, timeoutMs: 30_000, hookDeadline: Date.now() + 30_000 };
  const result = await view.webContents.executeJavaScript(`new Promise(resolve => {
    const handler = (event) => { if (event.target.id === ${JSON.stringify(config.resultId)}) { document.removeEventListener('dola-json-result', handler); resolve(JSON.parse(event.target.value)); event.target.remove(); } };
    document.addEventListener('dola-json-result', handler);
    window.__DOLA_JSON_REQUEST_CONFIG__ = ${JSON.stringify(config)};
    ${prepared.script}
  })`);
  ensurePage();
  if (result.fatal || result.status !== 200) throw new Error(`当前 Dola 页面查询失败：${result.fatal || `HTTP ${result.status}`}`);
  return providerJson(`/internal/runtime/v1/tasks/${encodeURIComponent(task.id)}/browser-result`, { method: "POST", body: JSON.stringify({ accountId: task.accountId, conversationId: task.conversationId, payload: JSON.parse(result.text) }) });
}

async function mediaSession(account) {
  const partition = session.fromPartition(`dola-media-${account.id}`);
  const proxy = store.state.settings.browserStaticDirect === false ? await resolveAccountProxy(account) : { url: "" };
  await partition.setProxy(proxy.url ? { proxyRules: proxy.url } : { mode: "direct" });
  return partition;
}

async function refreshTask(id, force = false) {
  const task = store.state.tasks.find((item) => item.id === id);
  if (!task) throw new Error("任务不存在");
  if (task.source === "workspace-browser" && !task.conversationId) return task;
  const endpoint = task.model === "dola-seedream-4-5" ? "images" : "videos";
  // 只有工作区浏览器内提交的任务才以页面内签名查询为准；provider 协议任务
  // 的会话由 provider 自己的 Camoufox 创建，强制浏览器查询只会让用户浏览器
  // 被导航后遭 Dola 弹回首页，权威状态一律走 provider 轮询端点。
  let result = force && task.source === "workspace-browser" && task.conversationId ? await queryTaskInBrowser(task) : await providerJson(`/internal/runtime/v1/${endpoint}/${encodeURIComponent(id)}`);
  if (result.error === "task_state_cookie_unavailable" && task.conversationId) {
    const account = store.state.accounts.find((item) => item.id === task.accountId && item.cookieCiphertext);
    if (account) {
      const proxy = await resolveAccountProxy(account);
      result = await providerJson(`/internal/runtime/v1/tasks/${encodeURIComponent(id)}/rebind`, { method: "POST", body: JSON.stringify({ accountId: account.id, credentialVersion: task.credentialVersion || account.credentialVersion, cookie: store.cookie(account.id), proxyMode: proxy.url ? "managed" : "direct", proxySource: proxy.source, proxyUrl: proxy.url, proxyTarget: proxy.name, ...(await accountIdentity(account)) }) });
    }
  }
  task.status = result.status || task.status;
  task.error = result.error || "";
  task.rawError = result.rawError || result.raw_error || "";
  task.diagnostics = result.diagnostics || {};
  task.conversationId = result.conversationId || result.conversation_id || task.conversationId;
  if (result.input) for (const key of ["prompt", "duration", "ratio", "createdAt", "references"]) if (task[key] === undefined && result.input[key] !== undefined) task[key] = result.input[key];
  const nextResultUrls = [...new Set([...(result.imageUrls || []), ...(result.videoUrl ? [result.videoUrl] : [])])];
  if (nextResultUrls.length || task.status !== "completed") store.state.assets = store.state.assets.filter((item) => item.taskId !== id || item.kind !== "generated" || item.ordinal < nextResultUrls.length);
  if (nextResultUrls.length || task.status !== "completed") task.resultUrls = nextResultUrls;
  if (result.vodPayload) task.vodPayload = result.vodPayload;
  if (task.status === "completed" && task.model !== "dola-seedream-4-5" && result.vodPayload && store.state.settings.autoRemoveWatermark !== false && !task.unwatermarkedUrl) {
    try { await resolveTaskWatermark(task, result.vodPayload); }
    catch (error) { task.watermarkError = String(error?.message || error); }
  }
  task.updatedAt = new Date().toISOString();
  await store.save();
  window?.webContents.send("dola:task", { type: "task", task });
  if (observedTaskId === id && task.source !== "provider-protocol") void observeTaskInBrowser(task).catch((error) => window?.webContents.send("dola:task", { type: "browser-error", message: String(error) }));
  if (task.status === "completed" && task.resultUrls.length && store.state.settings.autoDownload) await downloadTaskAssets(id).catch((error) => window?.webContents.send("dola:task", { type: "download-error", id, message: String(error) }));
  return task;
}

async function resolveTaskWatermark(task, payload) {
  const account = store.state.accounts.find((item) => item.id === task.accountId);
  if (!account) throw new Error("任务账号不存在");
  const partition = await mediaSession(account);
  const result = await resolveDolaWatermarkUrlRemote(payload, { fetchJson: async (url) => {
    const response = await fetchTrustedMedia(partition.fetch.bind(partition), url);
    if (!response.ok) throw new Error(`无水印地址查询失败：HTTP ${response.status}`);
    return response.json();
  } });
  task.unwatermarkedUrl = trustedMediaUrl(result.downloadUrl);
  task.watermarkError = "";
  return result.downloadUrl;
}

async function removeTaskWatermark(id) {
  const task = store.state.tasks.find((item) => item.id === id);
  if (!task || task.model === "dola-seedream-4-5") throw new Error("请选择视频任务");
  if (task.unwatermarkedUrl) return { ready: true, url: task.unwatermarkedUrl };
  if (!task.vodPayload) {
    const result = await providerJson(`/internal/runtime/v1/videos/${encodeURIComponent(id)}`);
    task.vodPayload = result.vodPayload;
  }
  if (!task.vodPayload) throw new Error("上游尚未返回可解析的原始视频信息，请先查询状态");
  const url = await resolveTaskWatermark(task, task.vodPayload);
  await store.save();
  window?.webContents.send("dola:task", { type: "task", task });
  return { ready: true, url };
}

async function openTask(id) {
  const task = store.state.tasks.find((item) => item.id === id);
  if (!task) throw new Error("任务不存在");
  if (!/^\d{8,}$/.test(task.conversationId || "")) throw new Error("该任务还没有可打开的 Dola 会话");
  if (activeAccountId !== task.accountId) await openAccount(task.accountId);
  const url = `https://www.dola.com/chat/${task.conversationId}`;
  if (browserView.webContents.getURL() !== url) await browserView.webContents.loadURL(url);
  return { accountId: task.accountId, conversationId: task.conversationId };
}

async function observeTaskInBrowser(task) {
  if (activeAccountId !== task.accountId || !browserView || !/^\d{8,}$/.test(task.conversationId || "")) return;
  const url = `https://www.dola.com/chat/${task.conversationId}`;
  if (browserView.webContents.getURL() !== url) await browserView.webContents.loadURL(url);
}

function scheduleTaskPoll(id) {
  if (taskPolls.has(id)) return;
  const tick = async () => {
    taskPolls.delete(id);
    try {
      const task = await refreshTask(id);
      if (["queued", "running", "accepted"].includes(task.status)) taskPolls.set(id, setTimeout(tick, 3000));
    } catch (error) { window?.webContents.send("dola:task", { type: "poll-error", id, message: String(error) }); }
  };
  taskPolls.set(id, setTimeout(tick, 3000));
}

async function chooseAssets() {
  const result = await dialog.showOpenDialog(window, { properties: ["openFile", "multiSelections"], filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp"] }] });
  if (result.canceled) return [];
  const assets = [];
  for (const file of result.filePaths) {
    const bytes = await readFile(file);
    if (!bytes.length || bytes.length > 20 * 1024 * 1024) throw new Error("素材为空或超过 20 MB");
    const extension = path.extname(file).toLowerCase();
    const mime = extension === ".png" ? "image/png" : extension === ".webp" ? "image/webp" : "image/jpeg";
    const id = randomUUID();
    const directory = path.join(store.root, "assets", "uploaded");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, `${id}${extension}`), bytes);
    const asset = { id, name: path.basename(file), mime, path: path.join(directory, `${id}${extension}`), dataUrl: `data:${mime};base64,${bytes.toString("base64")}` };
    store.state.assets.push({ id, name: asset.name, mime, path: asset.path, kind: "uploaded", createdAt: new Date().toISOString() });
    assets.push(asset);
  }
  await store.save();
  return assets;
}

async function ingestAsset(input) {
  const match = String(input.dataUrl || "").match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!match) throw new Error("只支持 PNG、JPEG 或 WebP 图片");
  const bytes = Buffer.from(match[2], "base64");
  if (!bytes.length || bytes.length > 20 * 1024 * 1024 || nativeImage.createFromBuffer(bytes).isEmpty()) throw new Error("图片无效或超过 20 MB");
  const id = randomUUID();
  const extension = match[1] === "image/png" ? ".png" : match[1] === "image/webp" ? ".webp" : ".jpg";
  const directory = path.join(store.root, "assets", "uploaded");
  await mkdir(directory, { recursive: true });
  const target = path.join(directory, `${id}${extension}`);
  await writeFile(target, bytes, { mode: 0o600 });
  const name = String(input.name || `图片${extension}`).slice(0, 150);
  store.state.assets.push({ id, name, mime: match[1], path: target, kind: "uploaded", createdAt: new Date().toISOString() });
  await store.save();
  return { id, name, dataUrl: String(input.dataUrl) };
}

async function readAsset(id) {
  const asset = store.state.assets.find((item) => item.id === id && item.mime?.startsWith("image/"));
  if (!asset) throw new Error("图片素材不存在");
  const bytes = await readFile(asset.path);
  if (!bytes.length || bytes.length > 20 * 1024 * 1024) throw new Error("图片素材为空或过大");
  return { id, name: asset.name, dataUrl: `data:${asset.mime};base64,${bytes.toString("base64")}` };
}

async function thumbnailAsset(id) {
  const asset = store.state.assets.find((item) => item.id === id && item.mime?.startsWith("image/"));
  if (!asset) throw new Error("图片素材不存在");
  const image = nativeImage.createFromBuffer(await readFile(asset.path));
  if (image.isEmpty()) throw new Error("图片素材无法解码");
  return image.resize({ width: 240, quality: "good" }).toDataURL();
}

async function downloadTaskAssets(id, ordinal) {
  const task = store.state.tasks.find((item) => item.id === id);
  if (!task?.resultUrls?.length) return { id, count: 0, files: [] };
  const directory = path.join(store.root, "assets", "generated", id);
  const downloads = downloadDirectory();
  await mkdir(directory, { recursive: true });
  await mkdir(downloads, { recursive: true });
  const account = store.state.accounts.find((item) => item.id === task.accountId);
  if (!account) throw new Error("任务账号不存在");
  const partition = await mediaSession(account);
  const files = [];
  for (const [index, originalUrl] of task.resultUrls.entries()) {
    if (ordinal !== undefined && index !== Number(ordinal)) continue;
    const url = index === 0 && task.unwatermarkedUrl ? task.unwatermarkedUrl : originalUrl;
    const saved = store.state.assets.find((item) => item.taskId === id && item.ordinal === index && item.kind === "generated");
    if (saved?.sourceUrl === url) {
      const target = path.join(downloads, `${id}-${index + 1}${path.extname(saved.path)}`);
      await copyFile(saved.path, target);
      files.push(target);
      continue;
    }
    const response = await fetchTrustedMedia(partition.fetch.bind(partition), url);
    if (!response.ok) throw new Error(`素材下载失败：HTTP ${response.status}`);
    const mime = response.headers.get("content-type")?.split(";", 1)[0] || "";
    if (!mime.startsWith("image/") && !mime.startsWith("video/")) throw new Error("生成结果不是图片或视频");
    const ext = mime.startsWith("video/") ? ".mp4" : mime === "image/png" ? ".png" : ".webp";
    const target = path.join(directory, `${index + 1}${ext}`);
    if (!response.body) throw new Error("素材下载响应没有文件内容");
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary, { mode: 0o600 }));
      await rename(temporary, target);
    } catch (error) { await rm(temporary, { force: true }); throw error; }
    const downloadTarget = path.join(downloads, `${id}-${index + 1}${ext}`);
    await copyFile(target, downloadTarget);
    files.push(downloadTarget);
    if (saved) { saved.sourceUrl = url; saved.mime = mime; saved.path = target; }
    else store.state.assets.push({ id: randomUUID(), taskId: id, ordinal: index, name: path.basename(target), mime, path: target, sourceUrl: url, kind: "generated", createdAt: new Date().toISOString() });
  }
  await store.save();
  window?.webContents.send("dola:task", { type: "assets" });
  return { id, count: files.length, files };
}

function downloadDirectory() {
  return store.state.settings.downloadDir || path.join(store.root, "downloads");
}

async function chooseDownloadDirectory() {
  const result = await dialog.showOpenDialog(window, { properties: ["openDirectory", "createDirectory"], defaultPath: downloadDirectory() });
  if (result.canceled || !result.filePaths[0]) return null;
  store.state.settings.downloadDir = result.filePaths[0];
  await store.save();
  return downloadDirectory();
}

async function chooseWorkspace() {
  const result = await dialog.showOpenDialog(window, { properties: ["openDirectory", "createDirectory"] });
  if (result.canceled || !result.filePaths[0]) return null;
  if (store.state.accounts.length || store.state.tasks.length || store.state.assets.length) throw new Error("当前工作空间已有数据；迁移需要先备份并在下一次启动前处理");
  const root = result.filePaths[0];
  store.root = root;
  mihomo.root = root;
  await store.save();
  const config = path.join(app.getPath("userData"), "workspace-location.json");
  await writeFile(config, JSON.stringify({ root }), { mode: 0o600 });
  return root;
}

async function saveSettings(input) {
  if (input.theme === "light" || input.theme === "dark") store.state.settings.theme = input.theme;
  if (typeof input.autoDownload === "boolean") store.state.settings.autoDownload = input.autoDownload;
  if (typeof input.browserStaticDirect === "boolean") store.state.settings.browserStaticDirect = input.browserStaticDirect;
  if (typeof input.autoRemoveWatermark === "boolean") store.state.settings.autoRemoveWatermark = input.autoRemoveWatermark;
  if (typeof input.apiEnabled === "boolean") store.state.settings.apiEnabled = input.apiEnabled;
  if (input.imagexUploadProxyId !== undefined) {
    const selected = String(input.imagexUploadProxyId || "");
    if (selected && !store.state.proxies.generic.some((item) => item.id === selected)) throw new Error("参考图上传代理节点不存在");
    if (selected !== store.state.settings.imagexUploadProxyId) await mihomo.stop("imagex-upload");
    store.state.settings.imagexUploadProxyId = selected;
  }
  const previousPort = store.state.settings.apiPort;
  if (input.apiPort !== undefined) {
    const port = Number(input.apiPort);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("本机 API 端口必须是 1024–65535 的整数");
    store.state.settings.apiPort = port;
  }
  await store.save();
  if (input.apiPort !== undefined && previousPort !== store.state.settings.apiPort) {
    if (apiServer) await new Promise((resolve) => apiServer.close(resolve));
    apiServer = undefined;
    apiOrigin = "";
    await startApi();
  }
  return store.state.settings;
}

async function rotateApiKey() {
  const pair = newApiKey();
  store.state.apiKeyDigest = pair.digest;
  await store.save();
  return { key: pair.key };
}

async function startProvider() {
  const port = await freePort();
  providerKey = randomBytes(32).toString("base64url");
  if (!store.state.providerTaskKeyCiphertext) {
    store.state.providerTaskKeyCiphertext = store.encrypt(randomBytes(32).toString("base64url"));
    await store.save();
  }
  const project = path.resolve(sourceRoot, "../../provider");
  const sidecarRoot = path.join(process.resourcesPath, "sidecars", process.platform, process.arch);
  const bundled = path.join(sidecarRoot, process.platform === "win32" ? "dola-api.exe" : "dola-api");
  const browser = path.join(sidecarRoot, "camoufox");
  const portablePython = path.join(sidecarRoot, "python", "python.exe");
  const portableEntry = path.join(sidecarRoot, "provider-entry.py");
  const browserVersion = app.isPackaged ? JSON.parse(await readFile(path.join(browser, "version.json"), "utf8")).version : "";
  // Windows 便携包不带冻结单文件 Provider：内嵌嵌入式 Python 直接运行入口脚本。
  const usePortablePython = app.isPackaged && process.platform === "win32" && !existsSync(bundled) && existsSync(portablePython);
  const command = app.isPackaged ? (usePortablePython ? portablePython : bundled) : "uv";
  const args = app.isPackaged ? (usePortablePython ? [portableEntry] : []) : ["run", "--project", project, "dola-api"];
  provider = spawn(command, args, { detached: process.platform !== "win32", env: {
    ...process.env,
    ...(usePortablePython ? { PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" } : {}),
    DOLA_PROVIDER_PORT: String(port), DOLA_PROVIDER_KEY: providerKey,
    DOLA_PROVIDER_PARENT_PID: String(process.pid),
    DOLA_TASK_ENCRYPTION_KEY: store.decrypt(store.state.providerTaskKeyCiphertext),
    DOLA_TASK_STATE_PATH: path.join(store.root, "tasks", "provider.json"),
    DOLA_ENABLE_BROWSER: "1", DOLA_BROWSER_ENGINE: "camoufox",
    ...(app.isPackaged ? {
      DOLA_CAMOUFOX_EXECUTABLE: path.join(browser, process.platform === "darwin" ? "Camoufox.app/Contents/MacOS/camoufox" : "camoufox.exe"),
      DOLA_CAMOUFOX_FF_VERSION: String(browserVersion).split(".")[0],
      PLAYWRIGHT_NODEJS_PATH: process.execPath,
      ELECTRON_RUN_AS_NODE: "1",
    } : {}),
  }, stdio: ["ignore", "pipe", "pipe"] });
  provider.stderr.on("data", (chunk) => { const line = String(chunk).trim(); if (line) console.error(`[dola-provider] ${line}`); });
  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && provider.exitCode === null) {
    try { if ((await fetch(`${origin}/health`)).ok) { providerOrigin = origin; return; } } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Dola 协议服务未启动；请检查 uv/Camoufox 依赖或打包 sidecar");
}

async function providerJson(route, options = {}) {
  if (!providerOrigin) throw new Error("Dola 协议服务不可用");
  const response = await fetch(`${providerOrigin}${route}`, { ...options, headers: { Authorization: `Bearer ${providerKey}`, "Content-Type": "application/json", ...options.headers } });
  const result = await response.json();
  if (!response.ok) throw new Error(typeof result.detail === "string" ? result.detail : `协议服务 HTTP ${response.status}`);
  return result;
}

async function freePort() {
  return new Promise((resolve, reject) => { const server = createTcpServer(); server.once("error", reject); server.listen(0, "127.0.0.1", () => { const port = server.address().port; server.close(() => resolve(port)); }); });
}

async function startApi() {
  apiServer = createHttpServer(async (request, response) => {
    const pathName = new URL(request.url || "/", "http://127.0.0.1").pathname;
    const send = (status, data) => { response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); response.end(JSON.stringify(data)); };
    if (!store.state.settings.apiEnabled) return send(503, { error: "api_disabled" });
    const token = String(request.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (!matchApiKey(token, store.state.apiKeyDigest)) return send(401, { error: "unauthorized" });
    try {
      if (request.method === "GET" && pathName === "/v1/health") return send(200, { status: "ok" });
      if (request.method === "GET" && pathName === "/v1/models") return send(200, await providerJson("/internal/runtime/v1/models"));
      if (request.method === "POST" && ["/v1/videos", "/v1/images/generations"].includes(pathName)) {
        const body = await readRequestJson(request);
        if (pathName.includes("images") && body.model !== "dola-seedream-4-5") return send(422, { error: "image_model_required" });
        if (pathName.includes("videos") && body.model === "dola-seedream-4-5") return send(422, { error: "video_model_required" });
        return send(202, await submitTask(body));
      }
      const taskId = pathName.match(/^\/v1\/(?:videos|images)\/([^/]+)$/)?.[1];
      if (request.method === "GET" && taskId) return send(200, await refreshTask(decodeURIComponent(taskId)));
      return send(404, { error: "not_found" });
    } catch (error) { return send(400, { error: String(error?.message || error) }); }
  });
  const port = Number(store.state.settings.apiPort || 19527);
  try {
    await new Promise((resolve, reject) => {
      apiServer.once("error", reject);
      apiServer.listen(port, "127.0.0.1", () => { apiServer.off("error", reject); resolve(); });
    });
    apiOrigin = `http://127.0.0.1:${port}`;
    window?.webContents.send("dola:task", { type: "api-ready", apiOrigin });
  } catch (error) {
    apiServer = undefined;
    apiOrigin = "";
    window?.webContents.send("dola:task", { type: "api-error", message: `本机 API 端口 ${port} 不可用：${String(error?.message || error)}` });
  }
}

async function readRequestJson(request) {
  let length = 0;
  const chunks = [];
  for await (const chunk of request) { length += chunk.length; if (length > 25 * 1024 * 1024) throw new Error("请求正文过大"); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
