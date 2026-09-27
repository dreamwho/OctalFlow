import { referenceLabel, nextReferenceLabel, normalizePictureTags, referencedIds, mentionAtCursor, replaceMention, replaceReferenceToken, deleteReferenceAtCaret } from "./prompt-references.mjs";
import { testProxyNodes } from "./proxy-batch-test.mjs";

const api = window.dolaDesktop;
const byId = (id) => document.getElementById(id);
const state = { accounts: [], accountGroups: [], tasks: [], assets: [], proxies: { generic: [] }, settings: { theme: "dark" }, page: "workspace", proxyTab: "generic", rail: "tasks", mode: "video", activeAccountId: "", expandedAccountId: "", editingProxyId: "", magicFile: null, magicTestResults: new Map(), magicBatch: null, references: [], loadedAssets: new Map(), thumbnails: new Map(), accountMode: "manual" };

function node(tag, className = "", content = "") {
  const item = document.createElement(tag);
  item.className = className;
  item.textContent = content;
  return item;
}
function toast(message) {
  const target = byId("toast");
  target.textContent = String(message);
  target.classList.remove("hidden");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => target.classList.add("hidden"), 4500);
}
const loadingLabels = {
  "account:open": "正在打开账号网页…", "account:add": "正在添加账号…", "account:group-add": "正在创建分组…", "account:update": "正在保存账号…", "account:delete": "正在删除账号…", "account:import": "正在导入账号…", "account:import-file": "正在读取账号文件…", "account:export": "正在导出 Cookie…",
  "task:create": "正在提交生成任务…", "task:open": "正在打开任务会话…", "task:refresh": "正在查询任务状态…", "task:unwatermark": "正在获取无水印视频…",
  "asset:choose": "正在选择素材…", "asset:ingest": "正在保存素材…", "asset:read": "正在读取素材…", "asset:download": "正在下载素材…", "asset:download-many": "正在批量下载素材…", "asset:show": "正在打开素材目录…",
  "proxy:test": "正在测试代理连通性…", "proxy:import-magic": "正在导入魔法代理订阅…", "proxy:choose-magic-file": "正在读取订阅文件…", "proxy:import-groups": "正在导入代理组…", "proxy:save": "正在保存代理…", "proxy:save-chain": "正在保存代理链路…", "proxy:delete-magic": "正在删除订阅…", "proxy:delete-chain": "正在删除代理链路…",
  "settings:save": "正在保存设置…", "workspace:choose": "正在选择工作空间…", "workspace:open": "正在打开工作空间…", "download:choose": "正在选择下载目录…", "download:open": "正在打开下载目录…", "api:new-key": "正在生成 API 密钥…", "api:revoke": "正在撤销 API 密钥…",
};
const loadingStack = [];
const inFlight = new Map();
const browserLoading = new Map();
function beginLoading(label) {
  const token = Symbol(label);
  loadingStack.push({ token, label });
  byId("loading-description").textContent = label;
  const dialog = byId("loading-dialog");
  if (!dialog.open) { dialog.showModal(); updateBrowserBounds(); }
  return token;
}
function endLoading(token) {
  const index = loadingStack.findIndex((item) => item.token === token);
  if (index !== -1) loadingStack.splice(index, 1);
  if (loadingStack.length) { byId("loading-description").textContent = loadingStack.at(-1).label; return; }
  const dialog = byId("loading-dialog");
  if (dialog.open) { dialog.close(); updateBrowserBounds(); }
}
async function withLoading(label, work) {
  const token = beginLoading(label);
  try { return await work(); } finally { endLoading(token); }
}
async function run(action, payload) {
  const key = action === "account:open" ? `${action}:${payload?.id}` : action === "task:create" ? action : "";
  if (key && inFlight.has(key)) return inFlight.get(key);
  const work = async () => {
    try { return await api.call(action, payload); }
    catch (error) { toast(error?.message || error); throw error; }
  };
  const pending = action === "state" ? work() : withLoading(loadingLabels[action] || "正在处理…", work);
  if (key) {
    inFlight.set(key, pending);
    pending.finally(() => { if (inFlight.get(key) === pending) inFlight.delete(key); }).catch(() => {});
  }
  return pending;
}
async function refresh() {
  const current = await run("state");
  Object.assign(state, current);
  render();
}
function render() {
  document.body.dataset.theme = state.settings.theme || "dark";
  byId("provider-state").textContent = state.providerReady ? "协议服务已连接" : "协议服务未连接";
  byId("active-name").textContent = state.accounts.find((item) => item.id === state.activeAccountId)?.name || "未选择账号";
  byId("api-origin").textContent = state.apiOrigin || "尚未启动";
  byId("api-examples").textContent = `curl -H 'Authorization: Bearer YOUR_API_KEY' '${state.apiOrigin || "http://127.0.0.1:19527"}/v1/models'\n\ncurl -X POST '${state.apiOrigin || "http://127.0.0.1:19527"}/v1/videos' -H 'Authorization: Bearer YOUR_API_KEY' -H 'Content-Type: application/json' -d '{"accountId":"账号 ID","model":"dola-seedance-2-5","prompt":"雨夜街头的慢镜头","duration":5,"ratio":"16:9"}'`;
  byId("api-enabled").checked = Boolean(state.settings.apiEnabled);
  byId("api-port").value = String(state.settings.apiPort || 19527);
  byId("workspace-path").textContent = state.workspace;
  byId("download-path").textContent = state.downloadDir;
  byId("auto-download").checked = state.settings.autoDownload !== false;
  byId("auto-unwatermark").checked = state.settings.autoRemoveWatermark !== false;
  for (const id of ["new-account-group", "import-group"]) {
    const select = byId(id);
    const value = select.value;
    select.replaceChildren(new Option("未分组", "未分组"), ...(state.accountGroups || []).map((group) => new Option(group, group)));
    select.value = value || "未分组";
  }
  byId("browser-empty").classList.toggle("hidden", Boolean(state.activeAccountId));
  for (const element of document.querySelectorAll("[data-page]")) element.classList.toggle("nav-active", element.dataset.page === state.page);
  for (const element of document.querySelectorAll(".page")) element.classList.toggle("active-page", element.id === `${state.page}-page`);
  byId("rail-tasks").classList.toggle("selected", state.rail === "tasks");
  byId("rail-assets").classList.toggle("selected", state.rail === "assets");
  byId("theme-light").classList.toggle("selected", state.settings.theme === "light");
  byId("theme-dark").classList.toggle("selected", state.settings.theme === "dark");
  renderAccounts();
  renderProxies();
  renderRail();
  renderReferences();
  renderMode();
  updateBrowserBounds();
}
function renderAccounts() {
  const existingPopover = byId("account-popover");
  const draft = existingPopover?.dataset.accountId === state.expandedAccountId ? { name: existingPopover.querySelector("input")?.value, group: existingPopover.querySelectorAll("select")[0]?.value, proxyId: existingPopover.querySelectorAll("select")[1]?.value } : null;
  const list = byId("account-list");
  list.replaceChildren();
  const query = byId("account-search").value.trim().toLowerCase();
  const accounts = state.accounts.filter((item) => !query || item.name.toLowerCase().includes(query) || item.group.toLowerCase().includes(query));
  if (!accounts.length) list.append(node("p", "rail-empty", "暂无账号。点击“添加账号”后手动登录或导入 Cookie。"));
  for (const account of accounts) {
    const card = node("div", `account-card ${account.id === state.activeAccountId ? "active" : ""}`);
    card.setAttribute("role", "listitem");
    const open = node("button", "account-card");
    open.style.cssText = "border:0;background:transparent;padding:0;margin:0;flex:1;min-width:0";
    open.setAttribute("aria-label", `打开账号 ${account.name}`);
    const avatar = node("span", "account-avatar", account.name.slice(0, 1).toUpperCase());
    const meta = node("span", "account-meta");
    meta.append(node("span", "account-name", account.name));
    const detail = node("span", "account-detail", `${account.group} · ${account.status}`);
    detail.style.display = "block";
    meta.append(detail);
    open.append(avatar, meta);
    open.onclick = async () => { try { await run("account:open", { id: account.id }); state.activeAccountId = account.id; state.page = "workspace"; render(); } catch {} };
    const menu = node("button", "account-menu", "⋯");
    menu.title = "账号操作";
    menu.setAttribute("aria-label", `管理账号 ${account.name}`);
    menu.setAttribute("aria-expanded", String(state.expandedAccountId === account.id));
    menu.dataset.accountId = account.id;
    menu.onclick = () => { state.expandedAccountId = state.expandedAccountId === account.id ? "" : account.id; renderAccounts(); byId("account-popover")?.querySelector("input")?.focus(); };
    card.append(open, menu);
    const wrapper = node("div");
    wrapper.append(card);
    list.append(wrapper);
  }
  renderAccountPopover(draft);
}
function renderAccountPopover(draft) {
  byId("account-popover")?.remove();
  const account = state.accounts.find((item) => item.id === state.expandedAccountId);
  const anchor = [...document.querySelectorAll(".account-menu")].find((item) => item.dataset.accountId === account?.id);
  if (!account || !anchor) return;
  const popup = node("div", "account-popover");
  popup.id = "account-popover";
  popup.dataset.accountId = account.id;
  popup.setAttribute("role", "dialog");
  popup.setAttribute("aria-label", `管理账号 ${account.name}`);
  const heading = node("div", "account-popover-head");
  heading.append(node("strong", "", "账号设置"));
  const close = node("button", "account-popover-close", "×");
  close.type = "button";
  close.setAttribute("aria-label", "关闭账号设置");
  close.onclick = () => { state.expandedAccountId = ""; renderAccounts(); };
  heading.append(close);
  const name = node("input");
  name.value = draft?.name ?? account.name;
  name.setAttribute("aria-label", "账号名称");
  const group = node("select");
  group.setAttribute("aria-label", "账号分组");
  group.append(new Option("未分组", "未分组"), ...(state.accountGroups || []).map((item) => new Option(item, item)));
  group.value = draft?.group ?? account.group;
  const proxy = node("select");
  proxy.setAttribute("aria-label", "代理出口");
  proxy.append(new Option("直连", ""), ...selectableProxies().map((item) => new Option(item.name, item.id)));
  proxy.value = draft?.proxyId ?? account.proxyId ?? "";
  for (const [label, control] of [["账号名称", name], ["账号分组", group], ["代理出口", proxy]]) {
    const field = node("label", "account-popover-field", label);
    field.append(control);
    popup.append(field);
  }
  const save = node("button", "primary account-popover-save", "保存修改");
  save.onclick = async () => {
    if (!name.value.trim()) { name.focus(); return; }
    try {
      await withLoading("正在保存账号设置…", async () => {
        await run("account:update", { id: account.id, patch: { name: name.value, group: group.value, proxyId: proxy.value } });
        if (state.activeAccountId === account.id && proxy.value !== account.proxyId) await run("account:open", { id: account.id });
        state.expandedAccountId = "";
        await refresh();
      });
      toast("账号设置已保存");
    } catch {}
  };
  const footer = node("div", "account-popover-footer");
  const exportButton = node("button", "", "导出 Cookie");
  exportButton.onclick = async () => { try { await run("account:export", { ids: [account.id] }); } catch {} };
  const remove = node("button", "danger", "删除账号");
  remove.onclick = async () => {
    if (!confirm(`删除“${account.name}”及其浏览器登录态？任务记录仍保留。`)) return;
    try { await run("account:delete", { id: account.id }); if (state.activeAccountId === account.id) state.activeAccountId = ""; state.expandedAccountId = ""; await refresh(); } catch {}
  };
  footer.append(exportButton, remove);
  popup.prepend(heading);
  popup.append(save, footer);
  document.body.append(popup);
  positionAccountPopover();
}
function positionAccountPopover() {
  const popup = byId("account-popover");
  const anchor = [...document.querySelectorAll(".account-menu")].find((item) => item.dataset.accountId === state.expandedAccountId);
  if (!popup || !anchor) return;
  const rect = anchor.getBoundingClientRect();
  popup.style.left = `${Math.max(8, Math.min(rect.right - popup.offsetWidth, innerWidth - popup.offsetWidth - 8))}px`;
  popup.style.top = `${rect.bottom + popup.offsetHeight + 8 <= innerHeight ? rect.bottom + 8 : Math.max(8, rect.top - popup.offsetHeight - 8)}px`;
}
function renderProxies() {
  for (const [kind, count] of [["generic", state.proxies.generic?.length || 0], ["magic", state.proxies.magicSubscriptions?.length || 0], ["chain", state.proxies.chained?.length || 0]]) byId(`proxy-count-${kind}`).textContent = String(count);
  renderProxyTab();
  const list = byId("proxy-list");
  list.replaceChildren();
  for (const proxy of state.proxies.generic || []) {
    const row = node("div", "proxy-item");
    const info = node("div");
    info.append(node("strong", "", `${proxy.name} · ${proxy.group || "未分组"}`), node("small", "", proxy.url));
    const remove = node("button", "", "删除");
    remove.onclick = async () => {
      if (!confirm(`删除代理“${proxy.name}”？`)) return;
      try { await run("proxy:save", { generic: state.proxies.generic.filter((item) => item.id !== proxy.id) }); await refresh(); } catch {}
    };
    const test = node("button", "", "测试连通性");
    test.onclick = async () => { try { const result = await run("proxy:test", { id: proxy.id }); toast(result.connected ? `代理连通 · HTTP ${result.status} · ${result.latencyMs} ms` : `代理不可用：${result.error}`); } catch {} };
    const edit = node("button", "", "编辑");
    edit.onclick = () => {
      state.editingProxyId = proxy.id;
      byId("proxy-edit-name").value = proxy.name;
      byId("proxy-edit-group").value = proxy.group === "未分组" ? "" : proxy.group;
      byId("proxy-edit-url").value = "";
      byId("proxy-edit-current").textContent = `当前地址：${proxy.url}`;
      byId("proxy-edit-dialog").showModal();
      updateBrowserBounds();
    };
    const actions = node("div", "proxy-item-actions");
    actions.append(test, edit, remove);
    row.append(info, actions);
    list.append(row);
  }
  if (!list.children.length) list.append(node("p", "help", "尚无通用代理节点。"));
  const magicList = byId("magic-list");
  magicList.replaceChildren();
  for (const subscription of state.proxies.magicSubscriptions || []) {
    const row = node("div", "proxy-item");
    const info = node("div");
    info.append(node("strong", "", subscription.name), node("small", "", `${subscription.nodes.length} 个节点 · ${subscription.importedAt?.slice(0, 10) || ""}`));
    const remove = node("button", "", "删除");
    remove.onclick = async () => { if (!confirm(`删除订阅“${subscription.name}”？`)) return; try { await run("proxy:delete-magic", { id: subscription.id }); await refresh(); } catch {} };
    row.append(info, remove);
    const details = node("details", "proxy-nodes");
    details.append(node("summary", "", `查看并测试 ${subscription.nodes.length} 个节点`));
    for (const item of subscription.nodes) {
      const entry = node("div", "magic-node-row");
      entry.dataset.magicNodeId = item.id;
      const name = node("span", "magic-node-name", item.name);
      name.title = item.name;
      const status = node("span", "magic-node-status", "待测");
      const test = node("button", "proxy-node-test", "测试");
      test.onclick = async () => {
        state.magicTestResults.set(item.id, { testing: true });
        renderMagicTestState();
        try {
          const result = await run("proxy:test", { id: item.id });
          state.magicTestResults.set(item.id, result);
          toast(result.connected ? `${item.name} 连通 · ${result.latencyMs} ms` : `${item.name} 不可用：${result.error}`);
        } catch (error) { state.magicTestResults.set(item.id, { connected: false, error: String(error?.message || error) }); }
        finally { renderMagicTestState(); }
      };
      entry.append(name, status, test);
      details.append(entry);
    }
    magicList.append(row, details);
  }
  if (!magicList.children.length) magicList.append(node("p", "help", "可输入 HTTPS 订阅地址，或粘贴 Clash/Mihomo YAML 导入。"));
  renderMagicTestState();
  const options = selectableProxies().filter((item) => item.kind !== "chain");
  for (const [id, label] of [["chain-hop", "选择跳板节点"], ["chain-landing", "选择落地节点"]]) {
    const select = byId(id);
    const selected = select.value;
    select.replaceChildren(new Option(label, ""), ...options.map((item) => new Option(item.name, item.id)));
    select.value = selected;
  }
  const chainList = byId("chain-list");
  chainList.replaceChildren();
  for (const chain of state.proxies.chained || []) {
    const row = node("div", "proxy-item");
    const info = node("div");
    const hop = options.find((item) => item.id === chain.hopId)?.name || "缺失节点";
    const landing = options.find((item) => item.id === chain.landingId)?.name || "缺失节点";
    info.append(node("strong", "", chain.name), node("small", "", `${hop} → ${landing}`));
    const remove = node("button", "", "删除");
    remove.onclick = async () => { if (!confirm(`删除链路“${chain.name}”？`)) return; try { await run("proxy:delete-chain", { id: chain.id }); await refresh(); } catch {} };
    const test = node("button", "", "测试链路");
    test.onclick = async () => { try { const result = await run("proxy:test", { id: chain.id }); toast(result.connected ? `链路连通 · ${result.latencyMs} ms` : `链路不可用：${result.error}`); } catch {} };
    row.append(info, test, remove);
    chainList.append(row);
  }
  if (!chainList.children.length) chainList.append(node("p", "help", "选择两个不同的节点作为跳板与落地出口。"));
}
function renderMagicTestState() {
  const batch = state.magicBatch;
  const total = (state.proxies.magicSubscriptions || []).reduce((count, subscription) => count + subscription.nodes.length, 0);
  const button = byId("magic-test-all");
  button.disabled = !total || Boolean(batch?.running && batch.cancelRequested);
  button.textContent = batch?.running ? batch.cancelRequested ? "停止中…" : "停止测试" : "测试全部节点";
  button.classList.toggle("testing", Boolean(batch?.running));
  byId("magic-test-progress").textContent = batch ? `${batch.cancelled ? "已停止 · " : batch.running ? "测试中 · " : "测试完成 · "}${batch.completed}/${batch.total} 个 · 可用 ${batch.connected} · 不可用 ${batch.failed}` : `共 ${total} 个节点`;
  for (const entry of document.querySelectorAll("[data-magic-node-id]")) {
    const result = state.magicTestResults.get(entry.dataset.magicNodeId);
    const status = entry.querySelector(".magic-node-status");
    status.className = `magic-node-status${result?.connected ? " connected" : result?.connected === false ? " failed" : ""}`;
    status.textContent = result?.testing ? "测试中…" : result?.connected ? `连通 · ${result.latencyMs} ms` : result?.connected === false ? `不可用 · ${result.error || "连接失败"}` : "待测";
    status.title = status.textContent;
    entry.querySelector("button").disabled = Boolean(batch?.running || result?.testing);
  }
}
function renderProxyTab() {
  for (const kind of ["generic", "magic", "chain"]) {
    const selected = state.proxyTab === kind;
    byId(`proxy-tab-${kind}`).setAttribute("aria-selected", String(selected));
    byId(`proxy-tab-${kind}`).tabIndex = selected ? 0 : -1;
    byId(`proxy-panel-${kind}`).classList.toggle("hidden", !selected);
  }
}
function selectableProxies() {
  return [
    ...(state.proxies.generic || []).map((item) => ({ ...item, kind: "generic" })),
    ...(state.proxies.magicSubscriptions || []).flatMap((subscription) => subscription.nodes.map((item) => ({ ...item, name: `${subscription.name} / ${item.name}`, kind: "magic" }))),
    ...(state.proxies.chained || []).map((item) => ({ ...item, kind: "chain" })),
  ];
}
function renderRail() {
  const target = byId("rail-content");
  target.replaceChildren();
  if (state.rail === "assets") {
    if (!state.assets.length) target.append(node("p", "rail-empty", "暂无本地素材。添加图片或完成生成后会出现在这里。"));
    for (const asset of state.assets) {
      const card = node("article", "asset-card");
      if (asset.mime?.startsWith("image/")) {
        const thumbnail = node("img", "asset-thumb");
        thumbnail.alt = asset.name;
        const cached = state.thumbnails.get(asset.id);
        if (typeof cached === "string") thumbnail.src = cached;
        else {
          const pending = cached || api.call("asset:thumbnail", { id: asset.id });
          state.thumbnails.set(asset.id, pending);
          pending.then((dataUrl) => { state.thumbnails.set(asset.id, dataUrl); if (thumbnail.isConnected) thumbnail.src = dataUrl; }).catch(() => state.thumbnails.delete(asset.id));
        }
        card.append(thumbnail);
      }
      card.append(node("h3", "", asset.name), node("p", "", `${asset.kind === "generated" ? "生成结果" : "上传素材"} · ${asset.mime}`));
      if (asset.mime?.startsWith("image/")) {
        const use = node("button", "", "引用到提示词");
        use.onclick = () => selectAsset(asset);
        card.append(use);
      }
      const show = node("button", "", "在工作空间中显示");
      show.onclick = () => run("asset:show", { id: asset.id }).catch(() => {});
      card.append(show);
      target.append(card);
    }
    return;
  }
  if (!state.tasks.length) target.append(node("p", "rail-empty", "暂无创作任务。生成后可在这里查询状态并下载结果。"));
  for (const task of state.tasks) {
    const card = node("article", "task-card");
    card.append(node("h3", "", task.prompt));
    card.append(node("span", `state ${task.status === "failed" ? "failed" : ""}`, task.status));
    card.append(node("p", "", `${task.model} · ${task.ratio} · ${task.createdAt?.slice(0, 16).replace("T", " ")}`));
    if (task.error) card.append(node("p", "", task.error));
    if (task.unwatermarkedUrl) card.append(node("p", "", "无水印版本已就绪"));
    else if (task.watermarkError) card.append(node("p", "", `无水印取回：${task.watermarkError}`));
    if (task.status === "needs_review") card.append(node("p", "", "Dola 要求人工验证。请在已登录浏览器中完成验证，再查询状态。"));
    const actions = node("div", "card-actions");
    const refreshButton = node("button", "", "查询状态");
    refreshButton.onclick = async () => { try { await withLoading("正在打开任务并查询状态…", async () => { const opened = await run("task:open", { id: task.id }); state.activeAccountId = opened.accountId; state.page = "workspace"; render(); await run("task:refresh", { id: task.id }); await refresh(); }); } catch {} };
    actions.append(refreshButton);
    if (task.status === "completed" && task.model !== "dola-seedream-4-5") {
      const watermark = node("button", "", "去水印");
      watermark.onclick = async () => { try { await run("task:unwatermark", { id: task.id }); toast("无水印版本已就绪，可点击下载"); await refresh(); } catch {} };
      actions.append(watermark);
    }
    if (task.resultUrls?.length) {
      const download = node("button", "", "下载");
      download.onclick = async () => { try { const result = await run("asset:download", { id: task.id }); toast(`已保存到 ${state.downloadDir}（${result.count} 个）`); await refresh(); } catch {} };
      actions.append(download);
      for (const [ordinal] of task.resultUrls.entries()) {
        const one = node("button", "", `${task.model === "dola-seedream-4-5" ? "图片" : "视频"} ${ordinal + 1}`);
        one.onclick = async () => { try { const result = await run("asset:download", { id: task.id, ordinal }); toast(`已保存到 ${result.files?.[0] || state.downloadDir}`); await refresh(); } catch {} };
        actions.append(one);
      }
    }
    card.append(actions);
    target.append(card);
  }
}
function renderReferences() {
  const target = byId("reference-chips");
  target.replaceChildren();
  const expanded = byId("expanded-reference-chips");
  expanded.replaceChildren();
  state.references.forEach((reference, index) => { reference.label ||= referenceLabel(index); });
  const mentionedIds = referencedIds(byId("prompt").value, state.references);
  for (const [index, reference] of state.references.entries()) {
    const chip = node("div", "ref-chip");
    if (mentionedIds.has(reference.id)) chip.classList.add("mentioned");
    chip.title = reference.name;
    const image = node("img", "ref-thumb");
    image.src = reference.dataUrl;
    image.alt = reference.label;
    chip.append(image);
    const remove = node("button", "", "×");
    remove.setAttribute("aria-label", `移除${reference.label}`);
    remove.onclick = () => {
      state.references.splice(index, 1);
      const marker = new RegExp(`[@＠]${reference.label}(?!\\d)\\s?`, "gu");
      byId("prompt").value = byId("prompt").value.replace(marker, "");
      byId("expanded-prompt").value = byId("prompt").value;
      applyReferenceMode();
    };
    chip.append(remove);
    target.append(chip);
    const preview = node("div", "ref-chip");
    if (mentionedIds.has(reference.id)) preview.classList.add("mentioned");
    const previewImage = node("img", "ref-thumb");
    previewImage.src = reference.dataUrl;
    previewImage.alt = reference.label;
    preview.title = reference.name;
    preview.prepend(previewImage);
    expanded.append(preview);
  }
  renderPromptOverlay(byId("prompt"));
  renderPromptOverlay(byId("expanded-prompt"));
}
function applyReferenceMode() {
  const mode = state.mode === "image" ? "reference" : byId("reference-mode").value;
  state.references.forEach((reference, index) => {
    reference.role = mode === "first_last" ? index === 0 ? "first_frame" : index === 1 ? "last_frame" : "reference" : mode === "first_frame" && index === 0 ? "first_frame" : "reference";
  });
  renderReferences();
}
function renderMode() {
  byId("mode-video").classList.toggle("selected", state.mode === "video");
  byId("mode-image").classList.toggle("selected", state.mode === "image");
  byId("duration-control").classList.toggle("hidden", state.mode === "image");
  byId("reference-mode").classList.toggle("hidden", state.mode === "image");
  const model = byId("model");
  if (state.mode === "image" && model.options.length !== 1) model.replaceChildren(new Option("Seedream 4.5", "dola-seedream-4-5"));
  if (state.mode === "video" && model.options.length !== 2) model.replaceChildren(new Option("Seedance 2.5", "dola-seedance-2-5"), new Option("Seedance 2.0 Fast", "dola-seedance-2-0-fast"));
  if (model.value === "dola-seedance-2-0-fast" && byId("duration").dataset.value === "30") selectComposeOption("duration", "5");
  renderComposeOptions();
}
function selectComposeOption(kind, value) {
  const button = byId(kind);
  button.dataset.value = value;
  button.textContent = kind === "duration" ? `${value} 秒` : value;
  byId(`${kind}-menu`).classList.add("hidden");
  renderComposeOptions();
}
function renderComposeOptions() {
  const ratios = ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"];
  const durations = byId("model").value === "dola-seedance-2-5" ? ["5", "10", "15", "30"] : ["5", "10", "15"];
  for (const [kind, values] of [["ratio", ratios], ["duration", durations]]) {
    const menu = byId(`${kind}-menu`);
    menu.replaceChildren();
    for (const value of values) {
      const option = node("button", value === byId(kind).dataset.value ? "selected" : "", kind === "duration" ? `${value} 秒` : value);
      option.type = "button";
      option.onclick = () => selectComposeOption(kind, value);
      menu.append(option);
    }
  }
}
function updateBrowserBounds() {
  const box = byId("browser-box").getBoundingClientRect();
  const show = state.activeAccountId && state.page === "workspace" && !document.querySelector("dialog[open]");
  api.browserBounds(show ? { x: box.x, y: box.y, width: box.width, height: box.height } : { x: 0, y: 0, width: 0, height: 0 });
}
async function selectAsset(asset) {
  try {
    const item = state.loadedAssets.get(asset.id) || await run("asset:read", { id: asset.id });
    state.loadedAssets.set(asset.id, item);
    if (!state.references.some((ref) => ref.id === asset.id)) state.references.push({ id: asset.id, name: asset.name, label: nextReferenceLabel(state.references), dataUrl: item.dataUrl, role: "reference" });
    applyReferenceMode();
    state.page = "workspace";
    render();
  } catch {}
}
let activeMention = null;
let mentionOptions = [];
let mentionIndex = 0;
function hideMentionMenu() {
  byId("mention-menu").classList.add("hidden");
  byId("expanded-mention-menu").classList.add("hidden");
  activeMention = null;
  mentionOptions = [];
}
function renderPromptOverlay(textarea) {
  const overlay = byId(`${textarea.id}-overlay`);
  const value = textarea.value;
  const byLabel = new Map(state.references.map((reference) => [reference.label, reference]));
  const metrics = document.createElement("canvas").getContext("2d");
  metrics.font = getComputedStyle(textarea).font;
  overlay.replaceChildren();
  const appendPlain = (text) => { const part = node("span", "", text); part.setAttribute("aria-hidden", "true"); overlay.append(part); };
  let offset = 0;
  for (const match of value.matchAll(/[@＠]图片\d+(?!\d)/gu)) {
    const reference = byLabel.get(match[0].slice(1));
    if (!reference) continue;
    appendPlain(value.slice(offset, match.index));
    const token = node("span", "prompt-reference-token");
    token.title = `点击更换${reference.label}`;
    token.setAttribute("role", "button");
    token.setAttribute("aria-label", `更换${reference.label}`);
    token.tabIndex = 0;
    token.style.width = `${Math.ceil(metrics.measureText(match[0]).width)}px`;
    const thumbnail = node("img", "prompt-token-thumb");
    thumbnail.src = reference.dataUrl;
    thumbnail.alt = "";
    token.append(thumbnail, node("span", "prompt-token-label", reference.label));
    token.onclick = () => {
      textarea.focus();
      textarea.setSelectionRange(match.index + match[0].length, match.index + match[0].length);
      showReferenceMenu(textarea, { start: match.index, end: match.index + match[0].length, query: "" }, state.references, token.getBoundingClientRect(), true);
    };
    token.onkeydown = (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); token.click(); } };
    overlay.append(token);
    offset = match.index + match[0].length;
  }
  appendPlain(value.slice(offset));
  textarea.classList.toggle("has-reference-tokens", offset > 0);
  overlay.classList.toggle("hidden", offset === 0);
  overlay.scrollTop = textarea.scrollTop;
}
function caretRect(textarea) {
  const rect = textarea.getBoundingClientRect();
  const computed = getComputedStyle(textarea);
  const mirror = document.createElement("div");
  for (const property of ["boxSizing", "width", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth", "fontFamily", "fontSize", "fontWeight", "fontStyle", "letterSpacing", "lineHeight", "textAlign", "textIndent", "tabSize", "wordBreak", "overflowWrap"]) mirror.style[property] = computed[property];
  mirror.style.cssText += `;position:fixed;visibility:hidden;pointer-events:none;white-space:pre-wrap;overflow:hidden;left:${rect.left - textarea.scrollLeft}px;top:${rect.top - textarea.scrollTop}px`;
  mirror.textContent = textarea.value.slice(0, textarea.selectionStart);
  const marker = node("span", "", "\u200b");
  mirror.append(marker);
  document.body.append(mirror);
  const mark = marker.getBoundingClientRect();
  mirror.remove();
  return { left: mark.left, top: mark.top, bottom: mark.top + (parseFloat(computed.lineHeight) || 18) };
}
function selectMention(textarea, mention, asset, replacement = false) {
  const next = replacement ? replaceReferenceToken(textarea.value, mention.start, mention.end, asset.label) : replaceMention(textarea.value, mention, asset.label);
  textarea.value = next.value;
  byId(textarea.id === "prompt" ? "expanded-prompt" : "prompt").value = next.value;
  hideMentionMenu();
  renderReferences();
  textarea.focus();
  textarea.setSelectionRange(next.cursor, next.cursor);
}
function updateMentionMenu(textarea = byId("prompt")) {
  const mention = mentionAtCursor(textarea.value, textarea.selectionStart);
  if (!mention || !state.references.length) { hideMentionMenu(); return; }
  const assets = state.references.filter((asset) => asset.label.toLowerCase().includes(mention.query.toLowerCase()));
  if (!assets.length) { hideMentionMenu(); return; }
  showReferenceMenu(textarea, mention, assets);
}
function showReferenceMenu(textarea, mention, assets, anchor = null, replacement = false) {
  const menu = byId(textarea.id === "prompt" ? "mention-menu" : "expanded-mention-menu");
  menu.replaceChildren();
  activeMention = { textarea, mention, replacement };
  mentionOptions = assets;
  mentionIndex = 0;
  menu.append(node("div", "mention-heading", replacement ? "更换引用图片" : "选择引用素材 (@)"));
  for (const [index, asset] of assets.entries()) {
    const option = node("button", `mention-option ${index === 0 ? "selected" : ""}`);
    option.type = "button";
    option.setAttribute("role", "option");
    const image = node("img", "mention-thumb");
    image.src = asset.dataUrl;
    image.alt = "";
    option.append(image, node("span", "", asset.label));
    option.onmousedown = (event) => event.preventDefault();
    option.onclick = () => selectMention(textarea, mention, asset, replacement);
    menu.append(option);
  }
  byId(menu.id === "mention-menu" ? "expanded-mention-menu" : "mention-menu").classList.add("hidden");
  menu.classList.remove("hidden");
  const editor = textarea.closest(".prompt-editor").getBoundingClientRect();
  const caret = anchor || caretRect(textarea);
  const left = Math.min(Math.max(4, caret.left - editor.left), Math.max(4, editor.width - menu.offsetWidth - 4));
  const below = caret.bottom - editor.top + 5;
  const above = caret.top - editor.top - menu.offsetHeight - 5;
  const top = below + menu.offsetHeight <= editor.height - 4 ? below : above >= 4 ? above : Math.max(4, editor.height - menu.offsetHeight - 4);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

document.querySelectorAll("[data-page]").forEach((button) => button.addEventListener("click", () => { state.page = button.dataset.page; state.expandedAccountId = ""; render(); }));
document.querySelectorAll("[data-proxy-tab]").forEach((button) => {
  button.onclick = () => { state.proxyTab = button.dataset.proxyTab; renderProxyTab(); };
  button.onkeydown = (event) => {
    const kinds = ["generic", "magic", "chain"];
    const index = kinds.indexOf(button.dataset.proxyTab);
    const next = event.key === "ArrowRight" ? kinds[(index + 1) % kinds.length] : event.key === "ArrowLeft" ? kinds[(index + kinds.length - 1) % kinds.length] : event.key === "Home" ? kinds[0] : event.key === "End" ? kinds.at(-1) : "";
    if (next) { event.preventDefault(); byId(`proxy-tab-${next}`).click(); byId(`proxy-tab-${next}`).focus(); }
  };
});
document.addEventListener("click", (event) => { if (state.expandedAccountId && !event.target.closest("#account-popover, .account-menu")) { state.expandedAccountId = ""; renderAccounts(); } });
document.addEventListener("keydown", (event) => { if (event.key === "Escape" && state.expandedAccountId) { state.expandedAccountId = ""; renderAccounts(); } });
window.addEventListener("resize", () => { updateBrowserBounds(); positionAccountPopover(); });
byId("account-list").addEventListener("scroll", positionAccountPopover);
new ResizeObserver(updateBrowserBounds).observe(byId("browser-box"));
for (const dialog of document.querySelectorAll("dialog")) dialog.addEventListener("close", updateBrowserBounds);
byId("loading-dialog").addEventListener("cancel", (event) => event.preventDefault());
byId("add-account").onclick = () => { byId("account-dialog").showModal(); updateBrowserBounds(); };
document.querySelectorAll("[data-close-dialog]").forEach((button) => button.addEventListener("click", () => byId(button.dataset.closeDialog).close()));
byId("add-group").onclick = () => { byId("group-dialog").showModal(); updateBrowserBounds(); byId("group-name").focus(); };
byId("group-form").onsubmit = async (event) => {
  event.preventDefault();
  const name = byId("group-name").value.trim();
  if (!name) return;
  try { await run("account:group-add", { name }); byId("group-dialog").close(); byId("group-name").value = ""; await refresh(); toast(`分组“${name}”已创建`); } catch {}
};
byId("account-manual").onclick = () => { state.accountMode = "manual"; byId("cookie-field").classList.add("hidden"); byId("account-manual").classList.add("selected"); byId("account-cookie").classList.remove("selected"); byId("account-help").textContent = "创建后将在中间网页手动登录，完成后自动保存登录态。"; };
byId("account-cookie").onclick = () => { state.accountMode = "cookie"; byId("cookie-field").classList.remove("hidden"); byId("account-manual").classList.remove("selected"); byId("account-cookie").classList.add("selected"); byId("account-help").textContent = "导入后还需检查 Dola 真实登录状态。"; };
byId("account-confirm").onclick = async () => {
  try {
    await withLoading("正在添加账号并打开网页…", async () => {
      const name = byId("new-account-name").value.trim();
      const account = await run("account:add", { name, group: byId("new-account-group").value, ...(state.accountMode === "cookie" ? { cookie: byId("new-account-cookie").value } : {}) });
      byId("account-dialog").close();
      byId("new-account-name").value = "";
      byId("new-account-cookie").value = "";
      await refresh();
      await run("account:open", { id: account.id });
      state.activeAccountId = account.id;
      state.page = "workspace";
      render();
    });
  } catch {}
};
byId("account-search").oninput = renderAccounts;
byId("import-account").onclick = () => { byId("import-dialog").showModal(); updateBrowserBounds(); };
byId("import-file").onclick = async () => { try { const file = await run("account:import-file"); if (file) { byId("import-text").value = file.text; byId("import-file-name").textContent = file.name; } } catch {} };
byId("import-confirm").onclick = async () => {
  try {
    const results = await run("account:import", { name: byId("import-name").value, group: byId("import-group").value, text: byId("import-text").value });
    const target = byId("import-results");
    target.replaceChildren(...results.map((item) => node("p", "", `第 ${item.line} 行：${item.error || "已导入"}`)));
    await refresh();
  } catch {}
};
byId("export-account").onclick = async () => { try { const result = await run("account:export", { ids: state.accounts.map((item) => item.id) }); if (!result.cancelled) toast(`已导出 ${result.count} 个账号`); } catch {} };
byId("mode-video").onclick = () => { state.mode = "video"; renderMode(); };
byId("mode-image").onclick = () => { state.mode = "image"; renderMode(); };
byId("reference-mode").onchange = applyReferenceMode;
byId("model").onchange = renderMode;
for (const kind of ["ratio", "duration"]) byId(kind).onclick = () => {
  const menu = byId(`${kind}-menu`);
  for (const other of ["ratio-menu", "duration-menu"]) if (other !== `${kind}-menu`) byId(other).classList.add("hidden");
  menu.classList.toggle("hidden");
};
document.addEventListener("click", (event) => { if (!event.target.closest(".option-control")) for (const kind of ["ratio", "duration"]) byId(`${kind}-menu`).classList.add("hidden"); });
byId("add-reference").onclick = async () => { try { const items = await run("asset:choose"); for (const item of items) { state.loadedAssets.set(item.id, item); if (!state.references.some((reference) => reference.id === item.id)) state.references.push({ ...item, label: nextReferenceLabel(state.references), role: "reference" }); } applyReferenceMode(); await refresh(); } catch {} };
async function addImageFiles(files) {
  return withLoading("正在添加图片素材…", async () => {
    for (const file of files) {
      if (!file.type.startsWith("image/")) continue;
      const dataUrl = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file); });
      const asset = await run("asset:ingest", { name: file.name, dataUrl });
      state.references.push({ ...asset, label: nextReferenceLabel(state.references), role: "reference" });
    }
    applyReferenceMode();
    await refresh();
  });
}
for (const id of ["prompt", "expanded-prompt"]) {
  const textarea = byId(id);
  textarea.addEventListener("paste", (event) => {
    const files = [...(event.clipboardData?.files || [])];
    if (files.some((file) => file.type.startsWith("image/"))) { event.preventDefault(); void addImageFiles(files).catch(() => {}); return; }
    const text = event.clipboardData?.getData("text/plain") || "";
    const normalized = normalizePictureTags(text, state.references);
    if (normalized !== text) {
      event.preventDefault();
      textarea.setRangeText(normalized, textarea.selectionStart, textarea.selectionEnd, "end");
      byId(id === "prompt" ? "expanded-prompt" : "prompt").value = textarea.value;
      renderReferences();
      hideMentionMenu();
    }
  });
  textarea.addEventListener("keydown", (event) => {
    if (activeMention?.textarea === textarea && mentionOptions.length && ["ArrowDown", "ArrowUp", "Enter", "Escape"].includes(event.key)) {
      event.preventDefault();
      if (event.key === "Escape") { hideMentionMenu(); return; }
      if (event.key === "Enter") { selectMention(textarea, activeMention.mention, mentionOptions[mentionIndex], activeMention.replacement); return; }
      mentionIndex = (mentionIndex + (event.key === "ArrowDown" ? 1 : -1) + mentionOptions.length) % mentionOptions.length;
      const menu = byId(id === "prompt" ? "mention-menu" : "expanded-mention-menu");
      menu.querySelectorAll(".mention-option").forEach((option, index) => option.classList.toggle("selected", index === mentionIndex));
      return;
    }
    if (textarea.selectionStart !== textarea.selectionEnd || event.isComposing) return;
    const next = deleteReferenceAtCaret(textarea.value, textarea.selectionStart, event.key, state.references.map((reference) => reference.label));
    if (!next) return;
    event.preventDefault();
    textarea.value = next.value;
    byId(id === "prompt" ? "expanded-prompt" : "prompt").value = next.value;
    textarea.setSelectionRange(next.cursor, next.cursor);
    renderReferences();
  });
  textarea.addEventListener("scroll", () => { byId(`${id}-overlay`).scrollTop = textarea.scrollTop; if (activeMention?.textarea === textarea) updateMentionMenu(textarea); });
  textarea.addEventListener("click", () => updateMentionMenu(textarea));
  textarea.addEventListener("keyup", (event) => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) updateMentionMenu(textarea); });
}
byId("prompt-drop-zone").addEventListener("dragover", (event) => { if (event.dataTransfer?.types.includes("Files")) { event.preventDefault(); event.currentTarget.classList.add("drag-over"); } });
byId("prompt-drop-zone").addEventListener("dragleave", (event) => event.currentTarget.classList.remove("drag-over"));
byId("prompt-drop-zone").addEventListener("drop", (event) => { event.preventDefault(); event.currentTarget.classList.remove("drag-over"); void addImageFiles([...event.dataTransfer.files]).catch(() => {}); });
byId("prompt").oninput = (event) => { byId("expanded-prompt").value = event.target.value; renderReferences(); if (event.inputType === "insertFromPaste") hideMentionMenu(); else updateMentionMenu(event.target); };
byId("prompt-expand").onclick = () => { byId("expanded-prompt").value = byId("prompt").value; byId("prompt-dialog").showModal(); updateBrowserBounds(); renderReferences(); byId("expanded-prompt").focus(); };
byId("expanded-prompt").oninput = (event) => { byId("prompt").value = event.target.value; renderReferences(); if (event.inputType === "insertFromPaste") hideMentionMenu(); else updateMentionMenu(event.target); };
byId("submit").onclick = async () => {
  const button = byId("submit");
  button.disabled = true;
  try {
    const task = await run("task:create", { accountId: state.activeAccountId, model: byId("model").value, prompt: byId("prompt").value, duration: Number(byId("duration").dataset.value), ratio: byId("ratio").dataset.value, references: state.references });
    state.tasks.unshift(task);
    state.rail = "tasks";
    renderRail();
    byId("prompt").value = "";
    byId("expanded-prompt").value = "";
    state.references = [];
    renderReferences();
    hideMentionMenu();
    toast("任务已提交；状态会在右侧更新");
  } catch {} finally { button.disabled = false; }
};
byId("rail-tasks").onclick = () => { state.rail = "tasks"; render(); };
byId("rail-assets").onclick = () => { state.rail = "assets"; render(); };
byId("download-all").onclick = async () => { try { const ids = state.tasks.filter((item) => item.resultUrls?.length).map((item) => item.id); const result = await run("asset:download-many", { ids }); toast(`已处理 ${result.length} 个任务，保存至 ${state.downloadDir}`); await refresh(); } catch {} };
byId("proxy-add").onclick = async () => { try { const generic = [...state.proxies.generic, { name: byId("proxy-name").value, group: byId("proxy-group").value, url: byId("proxy-url").value }]; await run("proxy:save", { generic }); for (const id of ["proxy-name", "proxy-group", "proxy-url"]) byId(id).value = ""; await refresh(); } catch {} };
byId("proxy-edit-save").onclick = async () => {
  const id = state.editingProxyId;
  const name = byId("proxy-edit-name").value.trim();
  if (!name) { byId("proxy-edit-name").focus(); return; }
  const replacementUrl = byId("proxy-edit-url").value.trim();
  try {
    const generic = state.proxies.generic.map((item) => item.id === id ? { ...item, name, group: byId("proxy-edit-group").value.trim() || "未分组", ...(replacementUrl ? { url: replacementUrl, replaceUrl: true } : {}) } : item);
    await run("proxy:save", { generic });
    byId("proxy-edit-dialog").close();
    state.editingProxyId = "";
    await refresh();
    toast("代理节点已更新；已打开的账号重新打开后使用新设置");
  } catch {}
};
byId("generic-import").onclick = async () => { try { await run("proxy:import-groups", { text: byId("generic-json").value }); byId("generic-json").value = ""; await refresh(); } catch {} };
byId("magic-add").onclick = async () => { try { await run("proxy:import-magic", { name: byId("magic-name").value, url: byId("magic-url").value, content: byId("magic-content").value }); byId("magic-name").value = ""; byId("magic-url").value = ""; byId("magic-content").value = ""; await refresh(); } catch {} };
byId("magic-test-all").onclick = async () => {
  if (state.magicBatch?.running) { state.magicBatch.cancelRequested = true; renderMagicTestState(); return; }
  const items = (state.proxies.magicSubscriptions || []).flatMap((subscription) => subscription.nodes);
  if (!items.length) return;
  state.magicTestResults.clear();
  const batch = { running: true, cancelRequested: false, completed: 0, total: items.length, connected: 0, failed: 0, cancelled: false };
  state.magicBatch = batch;
  renderMagicTestState();
  const summary = await testProxyNodes(items, (item) => api.call("proxy:test", { id: item.id }), (event) => {
    Object.assign(batch, { completed: event.completed, connected: event.connected, failed: event.failed });
    state.magicTestResults.set(event.item.id, event.type === "testing" ? { testing: true } : event.result);
    renderMagicTestState();
  }, () => batch.cancelRequested);
  Object.assign(batch, summary, { running: false });
  renderMagicTestState();
};
byId("magic-file-choose").onclick = async () => {
  try {
    const file = await run("proxy:choose-magic-file");
    if (!file) return;
    state.magicFile = file;
    byId("magic-file-name").textContent = file.name;
    byId("magic-file-name").title = file.name;
    byId("magic-file-import").disabled = false;
  } catch {}
};
byId("magic-file-import").onclick = async () => {
  if (!state.magicFile) return;
  try {
    await run("proxy:import-magic", { name: byId("magic-name").value.trim() || state.magicFile.name.replace(/\.[^.]+$/, ""), content: state.magicFile.content });
    state.magicFile = null;
    byId("magic-file-name").textContent = "尚未选择文件";
    byId("magic-file-name").removeAttribute("title");
    byId("magic-file-import").disabled = true;
    byId("magic-name").value = "";
    await refresh();
    toast("订阅文件已导入");
  } catch {}
};
byId("chain-add").onclick = async () => { try { await run("proxy:save-chain", { name: byId("chain-name").value, hopId: byId("chain-hop").value, landingId: byId("chain-landing").value }); byId("chain-name").value = ""; await refresh(); } catch {} };
byId("theme-light").onclick = async () => { try { await run("settings:save", { theme: "light" }); await refresh(); } catch {} };
byId("theme-dark").onclick = async () => { try { await run("settings:save", { theme: "dark" }); await refresh(); } catch {} };
byId("workspace-choose").onclick = async () => { try { const root = await run("workspace:choose"); if (root) await refresh(); } catch {} };
byId("workspace-open").onclick = () => run("workspace:open").catch(() => {});
byId("download-choose").onclick = async () => { try { const directory = await run("download:choose"); if (directory) await refresh(); } catch {} };
byId("download-open").onclick = () => run("download:open").catch(() => {});
byId("auto-download").onchange = async (event) => { try { await run("settings:save", { autoDownload: event.target.checked }); await refresh(); } catch { event.target.checked = !event.target.checked; } };
byId("auto-unwatermark").onchange = async (event) => { try { await run("settings:save", { autoRemoveWatermark: event.target.checked }); await refresh(); } catch { event.target.checked = !event.target.checked; } };
byId("api-enabled").onchange = async (event) => { try { await run("settings:save", { apiEnabled: event.target.checked }); await refresh(); } catch { event.target.checked = !event.target.checked; } };
byId("api-save-port").onclick = async () => { try { await run("settings:save", { apiPort: Number(byId("api-port").value) }); await refresh(); toast(state.apiOrigin ? "本机 API 端口已更新" : "端口不可用，请查看提示并更换端口"); } catch {} };
byId("api-new-key").onclick = async () => { try { const result = await run("api:new-key"); const target = byId("api-key-output"); target.textContent = `请立即保存。此密钥只显示一次：\n${result.key}`; target.classList.remove("hidden"); } catch {} };
byId("api-revoke").onclick = async () => { if (!confirm("撤销当前 API 密钥？已有客户端会立即失效。")) return; try { await run("api:revoke"); byId("api-key-output").classList.add("hidden"); toast("密钥已撤销"); } catch {} };
api.onTask((message) => {
  if (message.type === "browser-loading") {
    if (message.loading && !browserLoading.has(message.browserId)) browserLoading.set(message.browserId, beginLoading("正在加载账号网页…"));
    if (!message.loading && browserLoading.has(message.browserId)) { endLoading(browserLoading.get(message.browserId)); browserLoading.delete(message.browserId); }
  }
  if (message.type === "task") { state.tasks = state.tasks.map((item) => item.id === message.task.id ? message.task : item); renderRail(); }
  if (message.type === "assets") void refresh();
  if (message.type === "account-saved") void refresh();
  if (message.type === "provider-ready") { state.providerReady = true; byId("provider-state").textContent = "协议服务已连接"; }
  if (message.type === "api-ready") { state.apiOrigin = message.apiOrigin; render(); }
  if (message.type?.endsWith("error")) toast(message.message);
});
refresh().catch(() => {});
