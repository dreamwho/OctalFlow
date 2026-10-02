import { referenceLabel, nextReferenceLabel, normalizePictureTags, referencedIds, mentionAtCursor, replaceMention, replaceReferenceToken, deleteReferenceAtCaret } from "./prompt-references.mjs";
import { fingerprintOptions } from "./browser-fingerprint.mjs";
import { scanLongDurations, stripLongDurations } from "./duration-scan.mjs";

const defaultFingerprintSelection = () => Object.fromEntries(fingerprintOptions.map((item) => [item.key, item.default !== false]));

const api = window.dolaDesktop;
const byId = (id) => document.getElementById(id);
const displayTime = (value) => value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "暂无";
const taskErrorText = (task) => task.error === "dola_upstream_rejected_710022002" || (task.diagnostics?.httpStatus === 200 && task.diagnostics?.codes?.includes("710022002"))
  ? "Dola 拒绝了协议提交（代码 710022002）；此代码不能单独证明账号限流"
  : task.rawError || task.error;
const state = { accounts: [], accountGroups: [], accountGroupProxies: {}, editingGroup: "", tasks: [], assets: [], proxies: { generic: [] }, settings: { theme: "dark" }, page: "workspace", proxyTab: "generic", rail: "tasks", mode: "video", activeAccountId: "", expandedAccountId: "", editingProxyId: "", references: [], loadedAssets: new Map(), thumbnails: new Map(), importFiles: [], registrationFiles: [], registrationIds: [], registration: null, accountMode: "manual" };

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
  "account:open": "正在打开账号网页…", "account:add": "正在添加账号…", "account:group-add": "正在创建分组…", "account:group-proxy": "正在保存分组代理…", "account:update": "正在保存账号…", "account:delete": "正在删除账号…", "account:import": "正在导入账号…", "account:import-file": "正在读取账号文件…", "account:export": "正在导出 Cookie…", "registration:import": "正在导入账号…", "registration:start": "正在打开首个账号…",
  "task:create": "正在提交生成任务…", "task:open": "正在打开任务会话…", "task:refresh": "正在查询任务状态…", "task:unwatermark": "正在获取无水印视频…",
  "asset:choose": "正在选择素材…", "asset:ingest": "正在保存素材…", "asset:read": "正在读取素材…", "asset:download": "正在下载素材…", "asset:download-many": "正在批量下载素材…", "asset:show": "正在打开素材目录…",
  "proxy:test": "正在测试代理连通性…", "proxy:import-groups": "正在导入代理组…", "proxy:save": "正在保存代理…",
  "settings:save": "正在保存设置…", "workspace:choose": "正在选择工作空间…", "workspace:open": "正在打开工作空间…", "download:choose": "正在选择下载目录…", "download:open": "正在打开下载目录…", "api:new-key": "正在生成 API 密钥…", "api:revoke": "正在撤销 API 密钥…",
};
const loadingStack = [];
const inFlight = new Map();
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
  const pending = ["state", "account:open", "task:open", "browser:close", "browser:back", "browser:reload"].includes(action) ? work() : withLoading(loadingLabels[action] || "正在处理…", work);
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
  byId("browser-static-direct").checked = state.settings.browserStaticDirect !== false;
  byId("auto-unwatermark").checked = state.settings.autoRemoveWatermark !== false;
  const uploadExit = byId("imagex-upload-proxy");
  uploadExit.replaceChildren(new Option("直连（默认）", ""), ...selectableProxies().map((item) => new Option(item.name, item.id)));
  if (state.settings.imagexUploadProxyId && ![...uploadExit.options].some((option) => option.value === state.settings.imagexUploadProxyId)) uploadExit.append(new Option("所选节点已删除，请重新选择", state.settings.imagexUploadProxyId));
  uploadExit.value = state.settings.imagexUploadProxyId || "";
  const accountProxy = byId("new-account-proxy");
  mountProxyPicker(accountProxy, accountProxy.dataset.value || "", true, accountProxy.dataset.mode);
  for (const id of ["new-account-group", "import-group", "registration-group"]) {
    const select = byId(id);
    const value = select.value;
    select.replaceChildren(...(id === "registration-group" ? [new Option("请选择分组", "")] : []), new Option("未分组", "未分组"), ...(state.accountGroups || []).map((group) => new Option(group, group)));
    select.value = value || (id === "registration-group" ? "" : "未分组");
  }
  const groupFilter = byId("account-group-filter");
  const selectedGroup = groupFilter.value;
  groupFilter.replaceChildren(new Option("全部分组", "all"), new Option("未分组", "未分组"), ...(state.accountGroups || []).map((group) => new Option(group, group)));
  groupFilter.value = [...groupFilter.options].some((option) => option.value === selectedGroup) ? selectedGroup : "all";
  byId("edit-group").disabled = groupFilter.value === "all";
  byId("export-group").disabled = groupFilter.value === "all" || !state.accounts.some((account) => account.group === groupFilter.value && account.cookieFingerprint);
  byId("browser-empty").classList.toggle("hidden", Boolean(state.activeAccountId));
  for (const element of document.querySelectorAll("[data-page]")) element.classList.toggle("nav-active", element.dataset.page === state.page);
  for (const element of document.querySelectorAll(".page")) element.classList.toggle("active-page", element.id === `${state.page}-page`);
  byId("rail-tasks").classList.toggle("selected", state.rail === "tasks");
  byId("rail-assets").classList.toggle("selected", state.rail === "assets");
  byId("theme-light").classList.toggle("selected", state.settings.theme === "light");
  byId("theme-dark").classList.toggle("selected", state.settings.theme === "dark");
  renderAccounts();
  renderProxies();
  updateRegistrationProxyOptions();
  renderRail();
  renderReferences();
  renderMode();
  renderRegistration();
  updateBrowserBounds();
}
function renderRegistration() {
  const current = state.registration;
  byId("registration-banner").classList.toggle("hidden", !current);
  if (!current) return;
  byId("registration-progress").textContent = current.status === "completed" ? `批量注册完成 · ${current.total}/${current.total}` : current.status === "failed" ? `批量注册已暂停 · 第 ${current.index}/${current.total} 个` : `正在执行批量注册 · 当前账号：${current.email} · 第 ${current.index}/${current.total} 个`;
  byId("registration-hint").textContent = current.error || current.message || "正在打开 Dola 登录页面…";
  for (const id of ["registration-copy-email", "registration-copy-password"]) byId(id).disabled = current.status !== "running";
  byId("registration-stop").textContent = current.status === "running" ? "停止" : "关闭";
}

const fingerprintSelection = { "new-account-fingerprint": null, "registration-fingerprint": null };
function renderFingerprintOptions(id) {
  const container = byId(id);
  const enabled = fingerprintSelection[id] ?? defaultFingerprintSelection();
  fingerprintSelection[id] = enabled;
  container.replaceChildren(...fingerprintOptions.map((item) => {
    const chip = node("button", enabled[item.key] ? "selected" : "", item.label);
    chip.type = "button";
    chip.setAttribute("aria-pressed", String(Boolean(enabled[item.key])));
    chip.onclick = () => { enabled[item.key] = !enabled[item.key]; renderFingerprintOptions(id); };
    return chip;
  }));
}
function selectedFingerprintParams(id) {
  const enabled = fingerprintSelection[id] || {};
  return fingerprintOptions.filter((item) => enabled[item.key]).map((item) => item.key);
}
function renderAccounts() {
  const existingPopover = byId("account-popover");
  const draft = existingPopover?.dataset.accountId === state.expandedAccountId ? { name: existingPopover.querySelector("input")?.value, group: existingPopover.querySelectorAll("select")[0]?.value, proxyId: existingPopover.querySelector(".proxy-picker")?.dataset.value, proxyMode: existingPopover.querySelector(".proxy-picker")?.dataset.mode } : null;
  const list = byId("account-list");
  list.replaceChildren();
  const query = byId("account-search").value.trim().toLowerCase();
  const selectedGroup = byId("account-group-filter").value;
  const taskStats = new Map();
  for (const task of state.tasks) {
    if (!task.accountId) continue;
    const stats = taskStats.get(task.accountId) || { count: 0, latest: "" };
    stats.count += 1;
    if ((task.createdAt || "") > stats.latest) stats.latest = task.createdAt;
    taskStats.set(task.accountId, stats);
  }
  const accounts = state.accounts.filter((item) => (selectedGroup === "all" || item.group === selectedGroup) && (!query || item.name.toLowerCase().includes(query) || item.group.toLowerCase().includes(query))).reverse().sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  if (!accounts.length) list.append(node("p", "rail-empty", "暂无账号。点击“添加账号”后手动登录或导入 Cookie。"));
  for (const account of accounts) {
    const card = node("div", `account-card ${account.id === state.activeAccountId ? "active" : ""}`);
    card.setAttribute("role", "listitem");
    const open = node("button", "account-open");
    open.style.cssText = "border:0;background:transparent;padding:0;margin:0;flex:1;min-width:0";
    open.setAttribute("aria-label", `打开账号 ${account.name}`);
    const meta = node("span", "account-meta");
    meta.append(node("span", "account-name", account.name));
    const detail = node("span", "account-detail", `${account.group} · ${account.status} · ${accountProxySummary(account)}`);
    detail.style.display = "block";
    meta.append(detail);
    const stats = taskStats.get(account.id);
    const quota = account.quota?.find((item) => Number.isFinite(item.remaining));
    meta.append(node("span", "account-detail", `创建 ${displayTime(account.createdAt)} · 最近任务 ${displayTime(stats?.latest)}`));
    open.append(meta);
    open.onclick = async () => { try { await run("account:open", { id: account.id }); state.activeAccountId = account.id; state.page = "workspace"; render(); } catch {} };
    const menu = node("button", "account-menu", "管理");
    menu.title = "账号操作";
    menu.setAttribute("aria-label", `管理账号 ${account.name}`);
    menu.setAttribute("aria-expanded", String(state.expandedAccountId === account.id));
    menu.dataset.accountId = account.id;
    menu.onclick = () => { state.expandedAccountId = state.expandedAccountId === account.id ? "" : account.id; renderAccounts(); byId("account-popover")?.querySelector("input")?.focus(); };
    const summary = node("div", "account-summary");
    summary.append(menu, node("span", "account-detail", `任务 ${stats?.count || 0} 次 · 额度 ${quota ? `${quota.remaining} ${quota.unit === "credit" ? "积分" : quota.unit}` : account.quotaCheckedAt ? "上游未提供" : "未查询"}`));
    card.append(open, summary);
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
  for (const [label, control] of [["账号名称", name], ["账号分组", group]]) {
    const field = node("label", "account-popover-field", label);
    field.append(control);
    popup.append(field);
  }
  const proxy = node("div", "proxy-picker");
  proxy.id = "account-proxy-picker";
  mountProxyPicker(proxy, draft?.proxyId ?? account.proxyId ?? "", true, draft?.proxyMode);
  const proxyField = node("div", "account-popover-field", "代理方式");
  proxyField.append(proxy);
  popup.append(proxyField);
  const save = node("button", "primary account-popover-save", "保存修改");
  save.onclick = async () => {
    if (!name.value.trim()) { name.focus(); return; }
    try {
      await withLoading("正在保存账号设置…", async () => {
        await run("account:update", { id: account.id, patch: { name: name.value, group: group.value, proxyId: proxyPickerValue(proxy) } });
        state.expandedAccountId = "";
        await refresh();
      });
      toast("账号设置已保存");
    } catch {}
  };
  const footer = node("div", "account-popover-footer");
  const verify = node("button", "", "检测登录与额度");
  verify.onclick = async () => { try { await run("account:verify", { id: account.id }); await refresh(); toast("账号状态与额度已更新"); } catch {} };
  const exportButton = node("button", "", "导出 Cookie");
  exportButton.onclick = async () => { try { await run("account:export", { ids: [account.id] }); } catch {} };
  const remove = node("button", "danger", "删除账号");
  remove.onclick = async () => {
    if (!confirm(`删除“${account.name}”及其浏览器登录态？任务记录仍保留。`)) return;
    try { await run("account:delete", { id: account.id }); if (state.activeAccountId === account.id) state.activeAccountId = ""; state.expandedAccountId = ""; await refresh(); } catch {}
  };
  footer.append(verify, exportButton, remove);
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
function proxyMode(id) {
  if (!id) return "inherit";
  if (id === "direct") return id;
  const item = selectableProxies().find((item) => item.id === id);
  return item ? "generic" : "generic";
}
function proxySummary(id) {
  const mode = proxyMode(id);
  return mode === "direct" ? "直连" : state.proxies.generic?.find((item) => item.id === id)?.name || "节点已删除";
}
function accountProxySummary(account) {
  const groupId = Object.hasOwn(state.accountGroupProxies || {}, account.group) ? state.accountGroupProxies[account.group] : "direct";
  return account.proxyId ? proxySummary(account.proxyId) : `跟随分组：${proxySummary(groupId)}`;
}
function mountProxyPicker(target, value, inherit = false, selectedMode) {
  target.replaceChildren();
  target.classList.add("proxy-picker");
  const mode = selectedMode || proxyMode(value || (inherit ? "" : "direct"));
  const modes = [...(inherit ? [["inherit", "跟随分组"]] : []), ["direct", "直连"], ["generic", "通用代理"]];
  const choices = node("div", "proxy-mode-options");
  choices.setAttribute("role", "group");
  choices.setAttribute("aria-label", inherit ? "账号代理方式" : "分组代理方式");
  const field = node("label", "proxy-node-field", "通用代理节点");
  const select = node("select");
  select.setAttribute("aria-label", "通用代理节点");
  select.append(new Option("请选择通用代理节点", ""), ...(state.proxies.generic || []).map((item) => new Option(`${item.group || "未分组"} / ${item.name}`, item.id)));
  if (mode === "generic" && value && ![...select.options].some((item) => item.value === value)) select.append(new Option("所选节点已删除，请重新选择", value));
  select.value = mode === "generic" ? value : "";
  field.append(select);
  const hint = node("p", "help");
  const update = (selected) => {
    target.dataset.mode = selected;
    target.dataset.value = selected === "generic" ? select.value : selected === "inherit" ? "" : selected;
    field.classList.toggle("hidden", selected !== "generic");
    hint.textContent = selected === "inherit" ? "跟随当前分组设置，分组未设置时直连。" : "";
    positionAccountPopover();
  };
  for (const [key, label] of modes) {
    const choice = node("label", "proxy-mode-choice");
    const radio = node("input");
    radio.type = "radio";
    radio.name = `${target.id}-mode`;
    radio.value = key;
    radio.checked = key === mode;
    radio.onchange = () => update(key);
    choice.append(radio, node("span", "", label));
    choices.append(choice);
  }
  select.onchange = () => update("generic");
  target.append(choices, field, hint);
  update(mode);
}
function proxyPickerValue(target) {
  if (target.dataset.mode === "generic" && !target.dataset.value) { toast("请选择通用代理节点"); throw new Error("请选择通用代理节点"); }
  return target.dataset.value || "";
}

function renderProxies() {
  byId("proxy-count-generic").textContent = String(state.proxies.generic?.length || 0);
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
}

function selectableProxies() {
  return (state.proxies.generic || []).map((item) => ({ ...item, kind: "generic" }));
}
function updateRegistrationProxyOptions() {
  const mode = byId("registration-proxy-mode").value;
  const select = byId("registration-proxy-id");
  const previous = select.value;
  select.replaceChildren(new Option("请选择代理节点", ""), ...selectableProxies().filter((item) => item.kind === mode).map((item) => new Option(item.name, item.id)));
  select.value = [...select.options].some((option) => option.value === previous) ? previous : "";
  byId("registration-proxy-field").classList.toggle("hidden", mode !== "generic");
  updateRegistrationControls();
}
function updateRegistrationControls() {
  const imported = state.registrationIds.length > 0;
  const ready = (byId("registration-text").value.trim() || state.registrationFiles.length) && byId("registration-group").value && (byId("registration-proxy-mode").value !== "generic" || byId("registration-proxy-id").value);
  byId("registration-import").disabled = imported || !ready;
  byId("registration-start").disabled = !imported || state.registration?.status === "running";
  for (const id of ["registration-text", "registration-group", "registration-proxy-mode", "registration-proxy-id", "registration-file-choose"]) byId(id).disabled = imported;
}
async function addRegistrationFiles(files) {
  if (state.registrationIds.length) return;
  for (const file of files) {
    if (!/\.txt$/i.test(file.name) && file.type !== "text/plain") { toast("请选择 TXT 账号密码文件"); continue; }
    state.registrationFiles.push({ name: file.name, text: await file.text() });
  }
  byId("registration-file-names").textContent = state.registrationFiles.length ? state.registrationFiles.map((file) => file.name).join("、") : "尚未选择文件";
  updateRegistrationControls();
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
    card.append(node("h3", "", task.prompt || "浏览器内提交的生成任务"));
    card.append(node("span", `state ${task.status === "failed" ? "failed" : ""}`, task.status));
    card.append(node("p", "", [task.model, task.ratio, task.createdAt ? displayTime(task.createdAt) : ""].filter(Boolean).join(" · ")));
    if (task.error) card.append(node("p", "", `失败原因：${taskErrorText(task)}${!task.conversationId ? "；未创建 Dola 会话" : ""}`));
    else if (!task.conversationId && ["queued", "running", "accepted"].includes(task.status)) card.append(node("p", "", `${task.diagnostics?.submitStage === "uploading_references" ? "正在上传参考图" : task.diagnostics?.submitStage === "rule_priming" ? "正在建立 30 秒时长规则" : task.diagnostics?.submitStage === "submitting_to_dola" ? "正在提交到 Dola" : "正在准备提交"}，尚未获得 Dola 会话`));
    if (task.unwatermarkedUrl) card.append(node("p", "", "无水印版本已就绪"));
    else if (task.watermarkError) card.append(node("p", "", `无水印取回：${task.watermarkError}`));
    if (task.status === "needs_review") card.append(node("p", "", "Dola 要求人工验证。请在已登录浏览器中完成验证，再查询状态。"));
    const actions = node("div", "card-actions");
    if (["completed", "failed"].includes(task.status)) {
      const replay = node("button", "", "再次生成");
      replay.onclick = async () => {
        try {
          const draft = await run("task:replay", { id: task.id });
          state.mode = draft.model === "dola-seedream-4-5" ? "image" : "video";
          state.references = draft.references.map((reference, index) => ({ ...reference, label: referenceLabel(index) }));
          byId("prompt").value = draft.prompt;
          byId("expanded-prompt").value = draft.prompt;
          state.page = "workspace";
          render();
          byId("model").value = draft.model;
          if (draft.ratio) selectComposeOption("ratio", draft.ratio);
          if (state.mode === "video" && draft.duration) selectComposeOption("duration", String(draft.duration));
          const roles = state.references.map((reference) => reference.role);
          byId("reference-mode").value = roles.includes("last_frame") ? "first_last" : roles.includes("first_frame") ? "first_frame" : "reference";
          renderReferences();
          await run("browser:close");
          state.activeAccountId = "";
          render();
          byId("prompt").focus();
          toast("提示词与原参考素材已回填，请在左侧选择账号后提交");
        } catch {}
      };
      actions.append(replay);
    }
    const refreshButton = node("button", "", "查询状态");
    refreshButton.onclick = async () => {
      try {
        const updated = await run("task:refresh", { id: task.id });
        await refresh();
        if (!updated.conversationId) {
          toast(updated.error ? `${taskErrorText(updated)}；尚未创建 Dola 会话` : `正在准备提交${updated.diagnostics?.submitStage ? ` · ${updated.diagnostics.submitStage}` : ""}，尚未创建 Dola 会话`);
          return;
        }
        const opened = await run("task:open", { id: task.id });
        state.activeAccountId = opened.accountId;
        state.page = "workspace";
        render();
      } catch {}
    };
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
      for (const [ordinal] of task.resultUrls.length > 1 ? task.resultUrls.entries() : []) {
        const one = node("button", "", `下载${task.model === "dola-seedream-4-5" ? "图片" : "视频"} ${ordinal + 1}`);
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
  if (model.value === "dola-seedance-2-0-fast" && !["5", "10", "15"].includes(byId("duration").dataset.value)) selectComposeOption("duration", "5");
  renderComposeOptions();
}
function selectComposeOption(kind, value) {
  const button = byId(kind);
  button.dataset.value = value;
  button.textContent = kind === "duration" ? `${value} 秒` : value;
  if (kind === "duration") byId("duration-slider").value = Math.min(30, Math.max(5, Number(value) || 5));
  byId(`${kind}-menu`).classList.add("hidden");
  renderComposeOptions();
}
function renderComposeOptions() {
  const ratios = ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"];
  const durations = byId("model").value === "dola-seedance-2-5" ? ["5", "10", "15", "30"] : ["5", "10", "15"];
  byId("duration-slider").classList.toggle("hidden", byId("model").value !== "dola-seedance-2-5");
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
document.addEventListener("click", (event) => { if (state.expandedAccountId && !event.target.closest("#account-popover, .account-menu")) { state.expandedAccountId = ""; renderAccounts(); } });
document.addEventListener("keydown", (event) => { if (event.key === "Escape" && state.expandedAccountId) { state.expandedAccountId = ""; renderAccounts(); } });
window.addEventListener("resize", () => { updateBrowserBounds(); positionAccountPopover(); });
byId("account-list").addEventListener("scroll", positionAccountPopover);
new ResizeObserver(updateBrowserBounds).observe(byId("browser-box"));
for (const dialog of document.querySelectorAll("dialog")) dialog.addEventListener("close", updateBrowserBounds);
byId("import-dialog").addEventListener("close", () => { state.importFiles = []; byId("import-text").value = ""; byId("import-file-name").textContent = ""; });
byId("loading-dialog").addEventListener("cancel", (event) => event.preventDefault());
byId("add-account").onclick = () => { byId("account-dialog").showModal(); updateBrowserBounds(); };
renderFingerprintOptions("new-account-fingerprint");
renderFingerprintOptions("registration-fingerprint");
byId("register-batch").onclick = () => {
  if (!state.registrationIds.length) {
    byId("registration-import-status").textContent = "";
    byId("registration-file-names").textContent = state.registrationFiles.length ? state.registrationFiles.map((file) => file.name).join("、") : "尚未选择文件";
  }
  updateRegistrationProxyOptions();
  byId("registration-dialog").showModal();
  updateBrowserBounds();
};
byId("registration-proxy-mode").onchange = updateRegistrationProxyOptions;
byId("registration-proxy-id").onchange = updateRegistrationControls;
byId("registration-group").onchange = updateRegistrationControls;
byId("registration-text").oninput = updateRegistrationControls;
byId("registration-file-choose").onclick = () => byId("registration-file-input").click();
byId("registration-file-input").onchange = async (event) => { await addRegistrationFiles(event.target.files); event.target.value = ""; };
const registrationZone = byId("registration-file-zone");
registrationZone.onclick = (event) => { if (event.target.tagName !== "BUTTON" && !state.registrationIds.length) byId("registration-file-input").click(); };
registrationZone.onkeydown = (event) => { if (["Enter", " "].includes(event.key)) { event.preventDefault(); byId("registration-file-input").click(); } };
registrationZone.ondragover = (event) => { event.preventDefault(); registrationZone.classList.add("drag-over"); };
registrationZone.ondragleave = () => registrationZone.classList.remove("drag-over");
registrationZone.ondrop = async (event) => { event.preventDefault(); registrationZone.classList.remove("drag-over"); await addRegistrationFiles(event.dataTransfer.files); };
registrationZone.onpaste = async (event) => {
  event.preventDefault();
  if (event.clipboardData.files.length) await addRegistrationFiles(event.clipboardData.files);
  else { byId("registration-text").value += event.clipboardData.getData("text/plain"); updateRegistrationControls(); }
};
byId("registration-import").onclick = async () => {
  try {
    const imported = await run("registration:import", { text: byId("registration-text").value, files: state.registrationFiles, group: byId("registration-group").value, proxyId: byId("registration-proxy-mode").value === "generic" ? byId("registration-proxy-id").value : byId("registration-proxy-mode").value, fingerprintParams: selectedFingerprintParams("registration-fingerprint") });
    state.registrationIds = imported.map((item) => item.id);
    state.registrationFiles = [];
    byId("registration-text").value = "";
    byId("registration-file-names").textContent = "文件内容已导入";
    byId("registration-import-status").textContent = `已导入 ${imported.length} 个账号。点击“开始注册”后逐个打开浏览器。`;
    await refresh();
    updateRegistrationControls();
  } catch {}
};
byId("registration-start").onclick = async () => {
  try {
    const current = await run("registration:start", { ids: state.registrationIds });
    state.registration = current;
    state.activeAccountId = current.accountId;
    state.page = "workspace";
    byId("registration-dialog").close();
    render();
  } catch {}
};
byId("registration-copy-email").onclick = async () => { try { await run("registration:copy-email", { id: state.registration?.accountId }); toast("当前邮箱已复制"); } catch {} };
byId("registration-copy-password").onclick = async () => { try { await run("registration:copy-password", { id: state.registration?.accountId }); toast("当前密码已复制到剪贴板"); } catch {} };
byId("registration-stop").onclick = async () => { try { await run("registration:stop"); state.registration = null; state.registrationIds = []; render(); } catch {} };
document.querySelectorAll("[data-close-dialog]").forEach((button) => button.addEventListener("click", () => byId(button.dataset.closeDialog).close()));
function openGroupSettings(editing = false) {
  state.editingGroup = editing ? byId("account-group-filter").value : "";
  byId("group-name").value = state.editingGroup;
  byId("group-name").readOnly = editing;
  byId("group-dialog-title").textContent = editing ? "设置分组代理" : "新建账号分组";
  byId("group-submit").textContent = editing ? "保存设置" : "创建分组";
  mountProxyPicker(byId("group-proxy"), Object.hasOwn(state.accountGroupProxies, state.editingGroup) ? state.accountGroupProxies[state.editingGroup] : "direct");
  byId("group-dialog").showModal();
  updateBrowserBounds();
  byId("group-name").focus();
}
byId("add-group").onclick = () => openGroupSettings();
byId("edit-group").onclick = () => openGroupSettings(true);
byId("group-form").onsubmit = async (event) => {
  event.preventDefault();
  const name = byId("group-name").value.trim();
  if (!name) return;
  try {
    const proxyId = proxyPickerValue(byId("group-proxy"));
    await run(state.editingGroup ? "account:group-proxy" : "account:group-add", { name, proxyId });
    byId("group-dialog").close();
    await refresh();
    toast(state.editingGroup ? "分组代理已保存" : `分组“${name}”已创建`);
  } catch {}
};byId("account-manual").onclick = () => { state.accountMode = "manual"; byId("cookie-field").classList.add("hidden"); byId("account-manual").classList.add("selected"); byId("account-cookie").classList.remove("selected"); byId("account-help").textContent = "创建后将在中间网页手动登录，完成后自动保存登录态。"; };
byId("account-cookie").onclick = () => { state.accountMode = "cookie"; byId("cookie-field").classList.remove("hidden"); byId("account-manual").classList.remove("selected"); byId("account-cookie").classList.add("selected"); byId("account-help").textContent = "导入后还需检查 Dola 真实登录状态。"; };
byId("account-confirm").onclick = async () => {
  try {
    await withLoading("正在添加账号并打开网页…", async () => {
      const name = byId("new-account-name").value.trim();
      const account = await run("account:add", { name, group: byId("new-account-group").value, proxyId: proxyPickerValue(byId("new-account-proxy")), fingerprintParams: selectedFingerprintParams("new-account-fingerprint"), ...(state.accountMode === "cookie" ? { cookie: byId("new-account-cookie").value } : {}) });
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
byId("account-group-filter").onchange = () => { const group = byId("account-group-filter").value; byId("edit-group").disabled = group === "all"; byId("export-group").disabled = group === "all" || !state.accounts.some((account) => account.group === group && account.cookieFingerprint); renderAccounts(); };
byId("import-account").onclick = () => { byId("import-dialog").showModal(); updateBrowserBounds(); };
byId("import-file").onclick = async () => { try { const files = await run("account:import-file"); if (files?.length) { state.importFiles = files; byId("import-file-name").textContent = files.map((file) => file.name).join("、"); } } catch {} };
byId("import-confirm").onclick = async () => {
  try {
    const results = await run("account:import", { name: byId("import-name").value, group: byId("import-group").value, text: byId("import-text").value, files: state.importFiles });
    const target = byId("import-results");
    target.replaceChildren(...results.map((item) => node("p", "", `${item.file} 第 ${item.line} 行：${item.error || "已导入"}`)));
    state.importFiles = [];
    byId("import-file-name").textContent = "";
    byId("import-text").value = "";
    await refresh();
  } catch {}
};
byId("export-account").onclick = async () => { try { const result = await run("account:export", { ids: state.accounts.map((item) => item.id) }); if (!result.cancelled) toast(`已导出 ${result.count} 个账号`); } catch {} };
byId("export-group").onclick = async () => { try { const group = byId("account-group-filter").value; if (group === "all") return; const result = await run("account:export-group", { group }); if (!result.cancelled) toast(`已导出 ${group} 分组 ${result.count} 个账号`); } catch {} };
byId("mode-video").onclick = () => { state.mode = "video"; renderMode(); };
byId("mode-image").onclick = () => { state.mode = "image"; renderMode(); };
byId("reference-mode").onchange = applyReferenceMode;
byId("model").onchange = renderMode;
for (const kind of ["ratio", "duration"]) byId(kind).onclick = () => {
  if (kind === "duration" && byId("model").value === "dola-seedance-2-5") return;
  const menu = byId(`${kind}-menu`);
  for (const other of ["ratio-menu", "duration-menu"]) if (other !== `${kind}-menu`) byId(other).classList.add("hidden");
  menu.classList.toggle("hidden");
};
document.addEventListener("click", (event) => { if (!event.target.closest(".option-control")) for (const kind of ["ratio", "duration"]) byId(`${kind}-menu`).classList.add("hidden"); });
byId("duration-slider").oninput = (event) => selectComposeOption("duration", event.target.value);
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
let durationScanMatches = [];
function renderDurationScan() {
  byId("duration-scan-result").classList.remove("hidden");
  const text = byId("duration-scan-text");
  const strip = byId("duration-strip");
  if (!durationScanMatches.length) {
    text.textContent = "未检测到超过 10 秒的时长表述";
    strip.classList.add("hidden");
    return;
  }
  const preview = durationScanMatches.slice(0, 4).map((match) => match.text.replace(/\s+/g, " ").trim()).join("、");
  text.textContent = `检测到 ${durationScanMatches.length} 处超过 10 秒的时长表述：${preview}${durationScanMatches.length > 4 ? " 等" : ""}`;
  strip.classList.remove("hidden");
}
byId("duration-scan").onclick = () => { durationScanMatches = scanLongDurations(byId("prompt").value); renderDurationScan(); };
byId("duration-strip").onclick = () => {
  const next = stripLongDurations(byId("prompt").value);
  byId("prompt").value = next.value;
  byId("expanded-prompt").value = next.value;
  renderPromptOverlay(byId("prompt"));
  renderPromptOverlay(byId("expanded-prompt"));
  renderReferences();
  toast(next.removed.length ? `已删除 ${next.removed.length} 处超过 10 秒的时长表述` : "没有需要删除的时长表述");
  durationScanMatches = scanLongDurations(next.value);
  renderDurationScan();
};
byId("submit").onclick = async () => {
  const button = byId("submit");
  button.disabled = true;
  try {
    const task = await run("task:create", { accountId: state.activeAccountId, model: byId("model").value, prompt: byId("prompt").value, duration: Number(byId("duration").dataset.value), ratio: byId("ratio").dataset.value, references: state.references });
    state.tasks.unshift(task);
    state.rail = "tasks";
    renderRail();
    renderAccounts();
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
byId("theme-light").onclick = async () => { try { await run("settings:save", { theme: "light" }); await refresh(); } catch {} };
byId("theme-dark").onclick = async () => { try { await run("settings:save", { theme: "dark" }); await refresh(); } catch {} };
byId("workspace-choose").onclick = async () => { try { const root = await run("workspace:choose"); if (root) await refresh(); } catch {} };
byId("workspace-open").onclick = () => run("workspace:open").catch(() => {});
byId("download-choose").onclick = async () => { try { const directory = await run("download:choose"); if (directory) await refresh(); } catch {} };
byId("download-open").onclick = () => run("download:open").catch(() => {});
byId("auto-download").onchange = async (event) => { try { await run("settings:save", { autoDownload: event.target.checked }); await refresh(); } catch { event.target.checked = !event.target.checked; } };
byId("auto-unwatermark").onchange = async (event) => { try { await run("settings:save", { autoRemoveWatermark: event.target.checked }); await refresh(); } catch { event.target.checked = !event.target.checked; } };
byId("imagex-upload-proxy").onchange = async (event) => { try { await run("settings:save", { imagexUploadProxyId: event.target.value }); await refresh(); } catch { await refresh(); } };
byId("browser-static-direct").onchange = async (event) => { try { await run("settings:save", { browserStaticDirect: event.target.checked }); await refresh(); toast("设置已保存，重新打开账号后生效"); } catch { await refresh(); } };
byId("api-enabled").onchange = async (event) => { try { await run("settings:save", { apiEnabled: event.target.checked }); await refresh(); } catch { event.target.checked = !event.target.checked; } };
byId("api-save-port").onclick = async () => { try { await run("settings:save", { apiPort: Number(byId("api-port").value) }); await refresh(); toast(state.apiOrigin ? "本机 API 端口已更新" : "端口不可用，请查看提示并更换端口"); } catch {} };
byId("api-new-key").onclick = async () => { try { const result = await run("api:new-key"); const target = byId("api-key-output"); target.textContent = `请立即保存。此密钥只显示一次：\n${result.key}`; target.classList.remove("hidden"); } catch {} };
byId("api-revoke").onclick = async () => { if (!confirm("撤销当前 API 密钥？已有客户端会立即失效。")) return; try { await run("api:revoke"); byId("api-key-output").classList.add("hidden"); toast("密钥已撤销"); } catch {} };
api.onTask((message) => {
  if (message.type === "registration") { state.registration = message.registration; if (message.registration?.status === "running") { state.activeAccountId = message.registration.accountId; state.page = "workspace"; } if (message.registration?.status === "completed") state.registrationIds = []; render(); }
  if (message.type === "browser-closed") { state.activeAccountId = ""; render(); }
  if (message.type === "task") { state.tasks = state.tasks.some((item) => item.id === message.task.id) ? state.tasks.map((item) => item.id === message.task.id ? message.task : item) : [message.task, ...state.tasks]; renderRail(); renderAccounts(); }
  if (message.type === "download-complete") toast(message.message);
  if (message.type === "assets") void refresh();
  if (message.type === "account-saved") void refresh();
  if (message.type === "provider-ready") { state.providerReady = true; byId("provider-state").textContent = "协议服务已连接"; }
  if (message.type === "api-ready") { state.apiOrigin = message.apiOrigin; render(); }
  if (message.type?.endsWith("error")) toast(message.message);
});
refresh().catch(() => {});
