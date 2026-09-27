import { app, BrowserWindow, WebContentsView, dialog, ipcMain, nativeImage, safeStorage, session, shell } from "electron";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { WorkspaceStore, matchApiKey, newApiKey, parseCookie } from "./store.mjs";
import { MihomoManager, fetchMagicSubscriptionUsing, genericMihomoNode, normalizeGenericProxyUrl, parseGenericProxyGroups, parseMagicSubscription } from "./proxy-runtime.mjs";
import { resolveDolaWatermarkUrlRemote } from "./watermark.mjs";

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
const browserActionsScript = `(() => {
  if (document.getElementById('dola-studio-browser-actions')) return;
  const style = document.createElement('style');
  style.textContent = '#dola-studio-browser-actions{position:fixed;right:3px;top:50%;transform:translateY(-50%);z-index:2147483646;display:flex;flex-direction:column;gap:5px;pointer-events:none}#dola-studio-browser-actions button{width:27px;height:27px;padding:0;border:1px solid rgba(140,155,180,.4);border-radius:9px;background:rgba(20,29,48,.42);color:white;font:18px system-ui;cursor:pointer;opacity:.7;pointer-events:auto;transition:opacity .15s,background .15s}#dola-studio-browser-actions button:hover,#dola-studio-browser-actions button:focus-visible{opacity:.95;background:rgba(20,29,48,.75);outline:1px solid rgba(255,255,255,.5)}';
  const actions = document.createElement('div');
  actions.id = 'dola-studio-browser-actions';
  for (const [label, symbol, action] of [['返回上一页','←',() => history.back()],['刷新网页','↻',() => location.reload()]]) {
    const button = document.createElement('button');
    button.type = 'button'; button.title = label; button.setAttribute('aria-label', label); button.textContent = symbol;
    button.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); action(); });
    actions.append(button);
  }
  document.documentElement.append(style, actions);
})()`;

app.whenReady().then(start).catch((error) => {
  dialog.showErrorBox("Dola Studio 启动失败", String(error?.message || error));
  app.quit();
});
app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => {
  for (const timer of taskPolls.values()) clearTimeout(timer);
  apiServer?.close();
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
  const mihomoBinary = process.env.DOLA_MIHOMO_BINARY || (app.isPackaged ? path.join(process.resourcesPath, "sidecars", process.platform, process.arch, process.platform === "win32" ? "mihomo.exe" : "mihomo") : "");
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
  ipcMain.on("dola:browser-bounds", (event, value) => {
    trusted(event);
    if (!value || ![value.x, value.y, value.width, value.height].every(Number.isFinite)) return;
    browserBounds = { x: Math.max(0, Math.round(value.x)), y: Math.max(0, Math.round(value.y)), width: Math.max(0, Math.round(value.width)), height: Math.max(0, Math.round(value.height)) };
    browserView?.setBounds(browserBounds);
  });
  ipcMain.handle("dola:call", async (event, action, input = {}) => {
    trusted(event);
    switch (action) {
      case "state": return { accounts: store.listAccounts(), accountGroups: store.state.accountGroups, tasks: store.state.tasks, assets: store.state.assets, proxies: publicProxies(), settings: store.state.settings, workspace: store.root, downloadDir: downloadDirectory(), apiOrigin, providerReady: Boolean(providerOrigin) };
      case "account:add": return store.addAccount(input);
      case "account:group-add": return store.addGroup(input.name);
      case "account:update": return store.updateAccount(input.id, input.patch || {});
      case "account:delete": {
        if (activeAccountId === input.id) await hideBrowser();
        const removed = await store.deleteAccount(input.id);
        if (removed) {
          await mihomo.stop(input.id);
          await session.fromPartition(`persist:dola-${input.id}`).clearStorageData();
        }
        return removed;
      }
      case "account:open": return openAccount(input.id);
      case "account:capture": return captureAccount(input.id);
      case "account:verify": return verifyAccount(input.id);
      case "account:import": return importAccounts(input);
      case "account:import-file": return chooseAccountImportFile();
      case "account:export": return exportAccounts(input.ids);
      case "browser:reload": browserView?.webContents.reload(); return true;
      case "browser:back": if (browserView?.webContents.canGoBack()) browserView.webContents.goBack(); return true;
      case "task:create": return submitTask(input);
      case "task:refresh": return refreshTask(input.id, true);
      case "task:open": return openTask(input.id);
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
      case "proxy:import-magic": return importMagicSubscription(input);
      case "proxy:choose-magic-file": return chooseMagicSubscriptionFile();
      case "proxy:delete-magic": return deleteMagicSubscription(input.id);
      case "proxy:save-chain": return saveChain(input);
      case "proxy:delete-chain": return deleteChain(input.id);
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

async function openAccount(id) {
  const account = store.state.accounts.find((item) => item.id === id);
  if (!account) throw new Error("账号不存在");
  await hideBrowser();
  const partition = session.fromPartition(`persist:dola-${id}`);
  partition.setPermissionRequestHandler((_contents, permission, callback) => callback(permission === "media"));
  if (account.proxyId) {
    const proxy = await resolveProxy(account.proxyId, id);
    if (proxy.url) await partition.setProxy({ proxyRules: proxy.url });
  } else await partition.setProxy({ mode: "direct" });
  await partition.closeAllConnections();
  if (account.cookieCiphertext && !(await partition.cookies.get({ url: "https://www.dola.com" })).length) {
    for (const item of parseCookie(store.cookie(id)).split("; ")) {
      const separator = item.indexOf("=");
      await partition.cookies.set({ url: "https://www.dola.com", name: item.slice(0, separator), value: item.slice(separator + 1), secure: true });
    }
  }
  const view = new WebContentsView({ webPreferences: { session: partition, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true } });
  const browserId = randomUUID();
  const notifyLoading = (loading) => window?.webContents.send("dola:task", { type: "browser-loading", browserId, loading });
  view.webContents.on("did-start-loading", () => notifyLoading(true));
  view.webContents.on("did-stop-loading", () => notifyLoading(false));
  view.webContents.once("destroyed", () => notifyLoading(false));
  view.webContents.setWindowOpenHandler(({ url }) => url.startsWith("https://accounts.google.com/") || url.startsWith("https://www.dola.com/") ? { action: "allow", overrideBrowserWindowOptions: { webPreferences: { session: partition, sandbox: true, nodeIntegration: false } } } : { action: "deny" });
  view.webContents.on("will-navigate", (event, url) => { if (!isAllowedLoginUrl(url)) event.preventDefault(); });
  view.webContents.on("did-finish-load", () => { void showBrowserActions(view); void captureAccountIfReady(id); });
  view.webContents.on("did-navigate-in-page", () => { void showBrowserActions(view); void captureAccountIfReady(id); });
  activeCookieListener = () => { if (activeAccountId === id) void captureAccountIfReady(id); };
  partition.cookies.on("changed", activeCookieListener);
  window.contentView.addChildView(view);
  view.setBounds(browserBounds);
  browserView = view;
  activeAccountId = id;
  await view.webContents.loadURL(dolaUrl);
  return { accountId: id, url: view.webContents.getURL() };
}

async function showBrowserActions(view) {
  if (!view || !isAllowedLoginUrl(view.webContents.getURL()) || !new URL(view.webContents.getURL()).hostname.endsWith("dola.com")) return;
  await view.webContents.executeJavaScript(browserActionsScript, true).catch(() => {});
}

function isAllowedLoginUrl(value) {
  try { const host = new URL(value).hostname.toLowerCase(); return new URL(value).protocol === "https:" && (host === "dola.com" || host.endsWith(".dola.com") || host === "accounts.google.com" || host.endsWith(".google.com") || host.endsWith(".apple.com") || host.endsWith(".facebook.com")); } catch { return false; }
}

async function hideBrowser() {
  if (browserView) {
    browserView.webContents.stop();
    if (activeCookieListener) browserView.webContents.session.cookies.removeListener("changed", activeCookieListener);
    activeCookieListener = undefined;
    window.contentView.removeChildView(browserView); browserView.webContents.close(); browserView = undefined;
  }
  activeAccountId = "";
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
    const proxy = await resolveProxy(account.proxyId, id);
    const result = await providerJson("/internal/runtime/v1/accounts/inspect", { method: "POST", body: JSON.stringify({ accountId: id, credentialVersion: account.credentialVersion, cookie: header, proxyMode: proxy.url ? "managed" : "direct", proxySource: proxy.source, proxyUrl: proxy.url, proxyTarget: proxy.name, authOnly: true }) });
    if ((result.loginState || result.login_state || result.status) !== "ready") return;
    await store.updateAccount(id, { cookie: header, status: "ready" });
    window?.webContents.send("dola:task", { type: "account-saved" });
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
  const proxy = await resolveProxy(account.proxyId, id);
  const result = await providerJson("/internal/runtime/v1/accounts/inspect", { method: "POST", body: JSON.stringify({ accountId: id, credentialVersion: account.credentialVersion, cookie: store.cookie(id), proxyMode: proxy.url ? "managed" : "direct", proxySource: proxy.source, proxyUrl: proxy.url, proxyTarget: proxy.name, authOnly: true }) });
  const state = result.loginState || result.login_state || result.status || "需检查";
  await store.updateAccount(id, { status: state });
  return result;
}

async function importAccounts(input) {
  const lines = String(input.text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const outcomes = [];
  for (const [index, line] of lines.entries()) {
    try { outcomes.push({ line: index + 1, account: await store.addAccount({ name: input.name ? `${input.name} ${index + 1}` : "", group: input.group || "未分组", cookie: line }) }); }
    catch (error) { outcomes.push({ line: index + 1, error: String(error?.message || error) }); }
  }
  return outcomes;
}

async function chooseAccountImportFile() {
  const selected = await dialog.showOpenDialog(window, { properties: ["openFile"], filters: [{ name: "Cookie 文本", extensions: ["txt"] }] });
  if (selected.canceled || !selected.filePaths[0]) return null;
  const text = await readFile(selected.filePaths[0], "utf8");
  return { name: path.basename(selected.filePaths[0]), text };
}

async function exportAccounts(ids) {
  const selected = store.state.accounts.filter((item) => Array.isArray(ids) && ids.includes(item.id) && item.cookieCiphertext);
  if (!selected.length) throw new Error("没有可导出的账号");
  const result = await dialog.showSaveDialog(window, { defaultPath: "dola-cookies.txt", filters: [{ name: "文本文件", extensions: ["txt"] }] });
  if (result.canceled || !result.filePath) return { cancelled: true };
  await writeFile(result.filePath, selected.map((item) => store.cookie(item.id)).join("\n") + "\n", { mode: 0o600 });
  return { count: selected.length, path: result.filePath };
}

async function resolveProxy(id, accountId) {
  if (!id) return { source: "direct", url: "", name: "直连" };
  const generic = store.state.proxies.generic.find((item) => item.id === id);
  if (generic) return { source: "generic", url: await mihomo.ensure(accountId, null, genericMihomoNode({ ...generic, url: store.decrypt(generic.urlCiphertext) }, generic.name)), name: generic.name };
  const magic = magicNode(id);
  if (magic) return { source: "magic", url: await mihomo.ensure(accountId, null, magic.config), name: magic.name };
  const chain = store.state.proxies.chained.find((item) => item.id === id);
  if (chain) {
    const hop = proxyNode(chain.hopId);
    const landing = proxyNode(chain.landingId);
    if (!hop || !landing || chain.hopId === chain.landingId) throw new Error("链式代理节点配置无效");
    return { source: "chained", url: await mihomo.ensure(accountId, hop.config, landing.config), name: chain.name };
  }
  throw new Error("该代理节点不存在");
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
    magicSubscriptions: store.state.proxies.magicSubscriptions.map(({ contentCiphertext: _content, urlCiphertext: _url, ...item }) => item),
    chained: store.state.proxies.chained,
  };
}

function publicProxyUrl(item) {
  const url = new URL(store.decrypt(item.urlCiphertext));
  return `${url.protocol}//${url.hostname}:${url.port}`;
}

function magicNode(id) {
  const match = String(id).match(/^magic:([^:]+):(\d+)$/);
  if (!match) return null;
  const subscription = store.state.proxies.magicSubscriptions.find((item) => item.id === match[1]);
  if (!subscription) return null;
  const parsed = parseMagicSubscription(store.decrypt(subscription.contentCiphertext), subscription.id);
  const node = parsed.nodes[Number(match[2])];
  return node ? { name: node.name, config: parsed.raw[node.index] } : null;
}

function proxyNode(id) {
  const generic = store.state.proxies.generic.find((item) => item.id === id);
  if (generic) return { name: generic.name, config: genericMihomoNode({ ...generic, url: store.decrypt(generic.urlCiphertext) }, generic.name) };
  return magicNode(id);
}

async function importMagicSubscription(input) {
  const url = String(input.url || "").trim();
  const id = randomUUID();
  const supplied = String(input.content || "").trim();
  const imported = supplied ? { content: supplied, parsed: parseMagicSubscription(supplied, id), url: "" } : await fetchMagicSubscriptionUsing(url, id, [fetch, session.defaultSession.fetch.bind(session.defaultSession)]);
  store.state.proxies.magicSubscriptions.push({ id, name: String(input.name || "魔法订阅").trim().slice(0, 80), contentCiphertext: store.encrypt(imported.content), urlCiphertext: imported.url ? store.encrypt(imported.url) : "", nodes: imported.parsed.nodes, importedAt: new Date().toISOString() });
  await store.save();
  return publicProxies();
}

async function chooseMagicSubscriptionFile() {
  const selected = await dialog.showOpenDialog(window, { properties: ["openFile"], filters: [{ name: "Clash YAML / 文本", extensions: ["yaml", "yml", "txt"] }] });
  if (selected.canceled || !selected.filePaths[0]) return null;
  if ((await stat(selected.filePaths[0])).size > 4 * 1024 * 1024) throw new Error("订阅文件超过 4 MiB，请缩小文件后重试");
  const file = await readFile(selected.filePaths[0]);
  if (file.byteLength > 4 * 1024 * 1024) throw new Error("订阅文件超过 4 MiB，请缩小文件后重试");
  return { name: path.basename(selected.filePaths[0]), content: new TextDecoder("utf-8", { fatal: true }).decode(file) };
}

async function testProxy(id) {
  const node = proxyNode(id);
  const chain = store.state.proxies.chained.find((item) => item.id === id);
  const hop = chain ? proxyNode(chain.hopId) : null;
  const landing = chain ? proxyNode(chain.landingId) : node;
  if (!landing || (chain && !hop)) throw new Error("代理节点不存在或链路配置无效");
  const key = `test-${randomUUID()}`;
  const testSession = session.fromPartition(key);
  const started = Date.now();
  try {
    const url = await mihomo.ensure(key, hop?.config || null, landing.config);
    await testSession.setProxy({ proxyRules: url });
    const response = await testSession.fetch("https://www.dola.com/", { method: "GET", signal: AbortSignal.timeout(15_000) });
    await response.body?.cancel();
    return { connected: true, status: response.status, latencyMs: Date.now() - started };
  } catch (error) { return { connected: false, latencyMs: Date.now() - started, error: String(error?.message || error).slice(0, 160) }; }
  finally { await mihomo.stop(key); await testSession.clearStorageData(); }
}

async function deleteMagicSubscription(id) {
  store.state.proxies.magicSubscriptions = store.state.proxies.magicSubscriptions.filter((item) => item.id !== id);
  await store.save();
  return publicProxies();
}

async function saveChain(input) {
  if (input.hopId === input.landingId || !proxyNode(input.hopId) || !proxyNode(input.landingId)) throw new Error("请选择两个不同的有效代理节点");
  const chain = { id: input.id || randomUUID(), name: String(input.name || "链式代理").trim().slice(0, 80), hopId: input.hopId, landingId: input.landingId };
  store.state.proxies.chained = [...store.state.proxies.chained.filter((item) => item.id !== chain.id), chain];
  await store.save();
  return publicProxies();
}

async function deleteChain(id) {
  store.state.proxies.chained = store.state.proxies.chained.filter((item) => item.id !== id);
  await store.save();
  return publicProxies();
}

async function submitTask(input) {
  const account = store.state.accounts.find((item) => item.id === input.accountId) || store.state.accounts.find((item) => item.cookieCiphertext);
  if (!account?.cookieCiphertext) throw new Error("请先添加并登录 Dola 账号");
  const model = String(input.model || "");
  const isImage = model === "dola-seedream-4-5";
  if (!["dola-seedance-2-5", "dola-seedance-2-0-fast", "dola-seedream-4-5"].includes(model)) throw new Error("模型不受支持");
  const prompt = String(input.prompt || "").trim();
  if (!prompt || prompt.length > 20_000) throw new Error("提示词为空或过长");
  const references = Array.isArray(input.references) ? input.references.map((item) => ({ dataUrl: String(item.dataUrl || ""), name: String(item.name || ""), role: item.role === "first_frame" || item.role === "last_frame" ? item.role : "reference", type: "image" })).filter((item) => item.dataUrl) : [];
  if (references.some((item) => item.dataUrl.length > 35_000_000)) throw new Error("参考素材过大");
  if (references.some((item) => item.role === "last_frame") !== references.some((item) => item.role === "first_frame")) throw new Error("首尾帧必须同时提供");
  const proxy = await resolveProxy(account.proxyId, account.id);
  const requestId = String(input.requestId || randomUUID());
  const body = { accountId: account.id, credentialVersion: account.credentialVersion, cookie: store.cookie(account.id), model, prompt, duration: isImage ? 0 : Number(input.duration || 5), ratio: String(input.ratio || "16:9"), references, requestId, proxyMode: proxy.url ? "managed" : "direct", proxySource: proxy.source, proxyTarget: proxy.name, proxyUrl: proxy.url };
  const endpoint = isImage ? "/internal/runtime/v1/images" : "/internal/runtime/v1/videos";
  const created = await providerJson(endpoint, { method: "POST", body: JSON.stringify(body) });
  const id = created.taskId || created.id;
  if (!id) throw new Error("Dola 未返回任务 ID，请检查上游响应，避免重复提交");
  const task = { id, accountId: account.id, credentialVersion: account.credentialVersion, model, prompt, duration: body.duration, ratio: body.ratio, status: created.status || "queued", references: references.map((item) => ({ name: item.name, role: item.role })), conversationId: created.conversationId || "", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), resultUrls: [] };
  store.state.tasks.unshift(task);
  await store.save();
  observedTaskId = id;
  void observeTaskInBrowser(task).catch((error) => window?.webContents.send("dola:task", { type: "browser-error", message: String(error) }));
  scheduleTaskPoll(id);
  return task;
}

async function refreshTask(id, force = false) {
  const task = store.state.tasks.find((item) => item.id === id);
  if (!task) throw new Error("任务不存在");
  const endpoint = task.model === "dola-seedream-4-5" ? "images" : "videos";
  let result = await providerJson(`/internal/runtime/v1/${endpoint}/${encodeURIComponent(id)}${force ? "?refresh=1" : ""}`);
  if (result.error === "task_state_cookie_unavailable" && task.conversationId) {
    const account = store.state.accounts.find((item) => item.id === task.accountId && item.cookieCiphertext);
    if (account) {
      const proxy = await resolveProxy(account.proxyId, account.id);
      result = await providerJson(`/internal/runtime/v1/tasks/${encodeURIComponent(id)}/rebind`, { method: "POST", body: JSON.stringify({ accountId: account.id, credentialVersion: task.credentialVersion || account.credentialVersion, cookie: store.cookie(account.id), proxyMode: proxy.url ? "managed" : "direct", proxySource: proxy.source, proxyUrl: proxy.url, proxyTarget: proxy.name }) });
    }
  }
  if (result.status === "accepted" && task.failureSource === "browser") result = { ...result, status: "failed", error: task.error };
  if (result.status === "accepted" && activeAccountId === task.accountId && browserView?.webContents.getURL().startsWith(`https://www.dola.com/chat/${task.conversationId}`)) {
    const visibleText = await browserView.webContents.executeJavaScript("document.body?.innerText || ''", true).catch(() => "");
    const failure = String(visibleText).match(/(?:视频|图片)生成失败[^。\n]{0,120}。?/)?.[0];
    if (failure && !task.prompt.includes(failure)) {
      result = { ...result, status: "failed", error: failure };
      task.failureSource = "browser";
    }
  }
  if (result.status === "completed") delete task.failureSource;
  task.status = result.status || task.status;
  task.error = result.error || "";
  task.conversationId = result.conversationId || result.conversation_id || task.conversationId;
  const nextResultUrls = [...new Set([...(result.imageUrls || []), ...(result.videoUrl ? [result.videoUrl] : [])])];
  store.state.assets = store.state.assets.filter((item) => item.taskId !== id || item.kind !== "generated" || item.ordinal < nextResultUrls.length);
  task.resultUrls = nextResultUrls;
  if (task.status === "completed" && task.model !== "dola-seedream-4-5" && result.vodPayload && store.state.settings.autoRemoveWatermark !== false && !task.unwatermarkedUrl) {
    try { await resolveTaskWatermark(task, result.vodPayload); }
    catch (error) { task.watermarkError = String(error?.message || error); }
  }
  task.updatedAt = new Date().toISOString();
  await store.save();
  window?.webContents.send("dola:task", { type: "task", task });
  if (observedTaskId === id) void observeTaskInBrowser(task).catch((error) => window?.webContents.send("dola:task", { type: "browser-error", message: String(error) }));
  if (task.status === "completed" && task.resultUrls.length && store.state.settings.autoDownload) await downloadTaskAssets(id).catch((error) => window?.webContents.send("dola:task", { type: "download-error", id, message: String(error) }));
  return task;
}

async function resolveTaskWatermark(task, payload) {
  const account = store.state.accounts.find((item) => item.id === task.accountId);
  if (!account) throw new Error("任务账号不存在");
  const partition = session.fromPartition(`persist:dola-${account.id}`);
  const proxy = await resolveProxy(account.proxyId, account.id);
  await partition.setProxy(proxy.url ? { proxyRules: proxy.url } : { mode: "direct" });
  const result = await resolveDolaWatermarkUrlRemote(payload, { fetchJson: async (url) => {
    const response = await partition.fetch(url, { redirect: "follow" });
    const host = new URL(response.url).hostname.toLowerCase();
    if (!["dola.com", "byteintlapi.com"].some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) throw new Error("无水印查询跳转到不受信任的地址");
    if (!response.ok) throw new Error(`无水印地址查询失败：HTTP ${response.status}`);
    return response.json();
  } });
  task.unwatermarkedUrl = result.downloadUrl;
  task.watermarkError = "";
  return result.downloadUrl;
}

async function removeTaskWatermark(id) {
  const task = store.state.tasks.find((item) => item.id === id);
  if (!task || task.model === "dola-seedream-4-5") throw new Error("请选择视频任务");
  const result = await providerJson(`/internal/runtime/v1/videos/${encodeURIComponent(id)}?refresh=1`);
  if (!result.vodPayload) throw new Error("上游尚未返回可解析的原始视频信息");
  const url = await resolveTaskWatermark(task, result.vodPayload);
  await store.save();
  window?.webContents.send("dola:task", { type: "task", task });
  return { ready: true, url };
}

async function openTask(id) {
  const task = store.state.tasks.find((item) => item.id === id);
  if (!task) throw new Error("任务不存在");
  if (!/^\d{8,}$/.test(task.conversationId || "")) throw new Error("该任务还没有可打开的 Dola 会话");
  if (activeAccountId !== task.accountId) await openAccount(task.accountId);
  await browserView.webContents.loadURL(`https://www.dola.com/chat/${task.conversationId}`);
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
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || !parsed.hostname || !/\.(?:dola\.com|byteintlapi\.com|ibyteimg\.com)$/.test(`.${parsed.hostname.toLowerCase()}`)) throw new Error("生成结果地址不在允许的 Dola/CDN 域名内");
    const response = await fetch(url, { redirect: "follow" });
    const finalHost = new URL(response.url).hostname.toLowerCase();
    if (!["dola.com", "byteintlapi.com", "ibyteimg.com"].some((suffix) => finalHost === suffix || finalHost.endsWith(`.${suffix}`))) throw new Error("素材下载跳转到不受信任的地址");
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
  if (typeof input.autoRemoveWatermark === "boolean") store.state.settings.autoRemoveWatermark = input.autoRemoveWatermark;
  if (typeof input.apiEnabled === "boolean") store.state.settings.apiEnabled = input.apiEnabled;
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
  const bundled = path.join(process.resourcesPath, "sidecars", process.platform, process.arch, process.platform === "win32" ? "dola-api.exe" : "dola-api");
  const browser = path.join(process.resourcesPath, "sidecars", process.platform, process.arch, "camoufox");
  const browserVersion = app.isPackaged ? JSON.parse(await readFile(path.join(browser, "version.json"), "utf8")).version : "";
  const command = app.isPackaged ? bundled : "uv";
  const args = app.isPackaged ? [] : ["run", "--project", project, "dola-api"];
  provider = spawn(command, args, { env: {
    ...process.env,
    DOLA_PROVIDER_PORT: String(port), DOLA_PROVIDER_KEY: providerKey,
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
