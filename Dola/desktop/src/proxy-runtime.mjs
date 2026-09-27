import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import YAML from "yaml";
import { parseNodeUriLines } from "./subscription-uri.mjs";

export function parseMagicSubscription(text, subscriptionId) {
  const raw = String(text || "").trim();
  let parsed;
  try { parsed = YAML.parse(raw, { uniqueKeys: true }); } catch { parsed = null; }
  if (!Array.isArray(parsed?.proxies)) {
    const encoded = raw.replace(/\s+/g, "");
    if (/^[A-Za-z0-9+/_=-]+$/.test(encoded) && encoded.length > 20) {
      const decoded = Buffer.from(encoded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
      try { parsed = YAML.parse(decoded, { uniqueKeys: true }); } catch { parsed = null; }
      if (!Array.isArray(parsed?.proxies)) parsed = { proxies: parseNodeUriLines(decoded) };
    }
  }
  if (!Array.isArray(parsed?.proxies)) parsed = { proxies: parseNodeUriLines(raw) };
  if (!parsed || !Array.isArray(parsed.proxies) || !parsed.proxies.length) throw new Error("订阅未返回 Clash/Mihomo 节点列表；请检查链接是否为订阅直链，或粘贴 Clash YAML");
  const nodes = parsed.proxies.map((value, index) => {
    if (!value || typeof value !== "object" || !value.server || !value.port || !value.type) throw new Error(`订阅第 ${index + 1} 个节点缺少协议、服务器或端口`);
    return { id: `magic:${subscriptionId}:${index}`, name: String(value.name || `节点 ${index + 1}`), type: String(value.type), index };
  });
  return { nodes, raw: parsed.proxies };
}

export function subscriptionUrls(value) {
  let source = String(value || "").trim();
  if (!source) throw new Error("请输入 HTTPS 订阅地址，或粘贴 Clash YAML");
  if (/^clash(?:meta)?:\/\//i.test(source)) {
    const nested = new URL(source).searchParams.get("url");
    if (nested) source = nested;
  }
  let url;
  try { url = new URL(source); } catch { throw new Error("订阅地址格式无效，请粘贴完整的 HTTPS 链接"); }
  if (url.protocol !== "https:" || url.username || url.password || !url.hostname) throw new Error("订阅地址必须是不含账号密码的 HTTPS 链接");
  url.hash = "";
  const original = url.toString();
  const pathname = url.pathname.toLowerCase();
  if (!url.searchParams.has("flag") && !/\.ya?ml$/.test(pathname) && (/\/(?:subscribe|sub|link)(?:\/|$)/.test(pathname) || url.searchParams.has("token"))) {
    url.searchParams.set("flag", "clash");
    return [url.toString(), original];
  }
  return [original];
}

export async function fetchMagicSubscription(value, subscriptionId, fetcher = fetch) {
  const urls = subscriptionUrls(value);
  const userAgents = ["clash.meta", "ClashforWindows/0.20.39", "ClashMeta/1.18.0 Mihomo/1.18.0"];
  let lastError;
  let htmlResponse = false;
  for (const url of urls) {
    for (const userAgent of userAgents) {
      try {
        const response = await fetcher(url, { cache: "no-store", redirect: "follow", headers: { accept: "application/yaml, text/yaml, text/plain, application/octet-stream, */*", "user-agent": userAgent }, signal: AbortSignal.timeout(15_000) });
        if (!response.ok) { lastError = new Error(`订阅下载失败：HTTP ${response.status}`); await response.body?.cancel(); continue; }
        if (response.url && new URL(response.url).protocol !== "https:") { await response.body?.cancel(); throw new Error("订阅重定向必须保持 HTTPS"); }
        const contentType = response.headers.get("content-type")?.toLowerCase() || "";
        const content = await readSubscriptionText(response);
        if (/请登录系统网站后台|订阅获取有效时间为/.test(content)) {
          const error = new Error("订阅服务提示尚未开启获取或链接已过期；请在订阅后台重新开启，并在 10 分钟内导入");
          error.code = "SUBSCRIPTION_INACTIVE";
          throw error;
        }
        try { return { content, parsed: parseMagicSubscription(content, subscriptionId), url: urls.at(-1) }; }
        catch (error) { lastError = error; if (contentType.includes("text/html") || /^\s*<(?:!doctype\s+html|html|head|body)/i.test(content)) htmlResponse = true; }
      } catch (error) { if (error?.code === "SUBSCRIPTION_INACTIVE") throw error; lastError = error; }
    }
  }
  if (htmlResponse) throw new Error("订阅服务器返回网页或验证页，未提供 Clash 节点；请检查订阅链接，或粘贴 Clash YAML 导入");
  throw lastError || new Error("订阅下载失败，请检查订阅链接");
}

export async function fetchMagicSubscriptionUsing(value, subscriptionId, fetchers) {
  let lastError;
  for (const fetcher of fetchers) {
    try { return await fetchMagicSubscription(value, subscriptionId, fetcher); }
    catch (error) { if (error?.code === "SUBSCRIPTION_INACTIVE") throw error; lastError = error; }
  }
  throw lastError;
}

async function readSubscriptionText(response) {
  const maxBytes = 4 * 1024 * 1024; // 与当前 Web 魔法代理订阅的资源上限一致。
  const chunks = [];
  let total = 0;
  if (!response.body) return "";
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error("订阅内容超过 4 MiB，请缩小订阅或调整服务端限制");
      chunks.push(value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
}

export function normalizeGenericProxyUrl(value) {
  const source = String(value || "").trim();
  let url;
  if (/^[^:/\s]+:\d+:[^:\s]+:[^:\s]+$/.test(source)) {
    const [host, port, username, password] = source.split(":");
    url = new URL(`http://${host}:${port}`);
    url.username = username;
    url.password = password;
  } else {
    try { url = new URL(source); } catch { throw new Error("通用代理应为 HTTP/SOCKS URL 或 host:port:user:password"); }
  }
  if (!["http:", "https:", "socks5:", "socks5h:"].includes(url.protocol) || !url.hostname || !url.port) throw new Error("通用代理应为 HTTP/SOCKS URL 或 host:port:user:password");
  return url.toString();
}

export function parseGenericProxyGroups(text) {
  const parsed = JSON.parse(String(text || ""));
  const groups = Array.isArray(parsed?.groups) ? parsed.groups : parsed?.proxy_groups;
  if (!Array.isArray(groups)) throw new Error("通用代理 JSON 必须包含 groups 或 proxy_groups 数组");
  const nodes = groups.filter((group) => group?.enabled !== false).flatMap((group) => (Array.isArray(group.nodes) ? group.nodes : []).filter((item) => item?.enabled !== false).map((item) => ({
    name: String(item.name || "导入节点"), group: String(group.name || "未分组"), url: String(item.url || ""),
  })));
  if (!nodes.length) throw new Error("没有可导入的启用节点");
  if (nodes.some((item) => item.url.includes("__DREAMYO_PROXY_AUTH_REDACTED__"))) throw new Error("代理组导出内容已脱敏，请使用包含原始节点口令的本地配置文件");
  return nodes;
}

export function genericMihomoNode(item, name) {
  const url = new URL(item.url);
  if (!["http:", "https:", "socks5:", "socks5h:"].includes(url.protocol) || !url.hostname || !url.port) throw new Error("通用节点地址无效");
  return {
    name,
    type: url.protocol.startsWith("socks") ? "socks5" : "http",
    server: url.hostname,
    port: Number(url.port),
    ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
    ...(url.protocol === "https:" ? { tls: true } : {}),
  };
}

export function buildMihomoConfig(hop, landing, port) {
  if (!Number.isInteger(port) || port <= 0) throw new Error("Mihomo 监听端口无效");
  const hopNode = hop ? { ...hop, name: "DOLA-HOP" } : null;
  const landingNode = { ...landing, name: "DOLA-LANDING", ...(hopNode ? { "dialer-proxy": "DOLA-HOP" } : {}) };
  delete landingNode["proxy-provider"];
  return YAML.stringify({
    port,
    "bind-address": "127.0.0.1",
    "allow-lan": false,
    mode: "rule",
    "log-level": "warning",
    ipv6: false,
    proxies: [...(hopNode ? [hopNode] : []), landingNode],
    "proxy-groups": [{ name: "DOLA-OUT", type: "select", proxies: ["DOLA-LANDING"] }],
    rules: ["MATCH,DOLA-OUT"],
  });
}

export class MihomoManager {
  constructor(root, binary) {
    this.root = root;
    this.binary = binary;
    this.running = new Map();
  }

  async ensure(accountId, hop, landing) {
    if (!this.binary) throw new Error("缺少 Mihomo 可执行文件，请在发布构建中暂存对应平台的 sidecar");
    const signature = createHash("sha256").update(JSON.stringify([hop, landing])).digest("hex");
    const existing = this.running.get(accountId);
    if (existing?.signature === signature && existing.process.exitCode === null) return existing.url;
    await this.stop(accountId);
    const port = await freePort();
    const directory = path.join(this.root, "proxy", accountId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const configPath = path.join(directory, `config-${randomUUID()}.yaml`);
    await writeFile(configPath, buildMihomoConfig(hop, landing, port), { mode: 0o600 });
    const child = spawn(this.binary, ["-f", configPath, "-d", directory], { stdio: ["ignore", "ignore", "pipe"] });
    let errorText = "";
    let spawnError;
    child.once("error", (error) => { spawnError = error; });
    child.stderr.on("data", (chunk) => { errorText += String(chunk).slice(-1000); });
    while (child.exitCode === null && !spawnError) {
      if (await portAccepts(port)) {
        const url = `http://127.0.0.1:${port}`;
        this.running.set(accountId, { process: child, signature, url });
        await rm(configPath, { force: true });
        return url;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    child.kill();
    await rm(configPath, { force: true });
    throw new Error(`Mihomo 代理出口启动失败：${String(spawnError?.message || errorText).slice(-300)}`);
  }

  async stop(accountId) {
    const current = this.running.get(accountId);
    this.running.delete(accountId);
    if (current?.process.exitCode === null) current.process.kill();
  }

  async close() {
    await Promise.all([...this.running.keys()].map((id) => this.stop(id)));
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { const port = server.address().port; server.close(() => resolve(port)); });
  });
}

function portAccepts(port) {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
  });
}
