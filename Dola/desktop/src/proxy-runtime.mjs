import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import YAML from "yaml";

export function accountProxyId(account, state) {
  return account.proxyId || (Object.hasOwn(state.accountGroupProxies || {}, account.group) ? state.accountGroupProxies[account.group] : "direct");
}

export function configuredProxyId(id) {
  // 魔法代理与链式代理已移除：遗留的 magic/chained 取值一律回落直连。
  if (!id || id === "direct" || id === "magic" || id === "chained") return "";
  return id;
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

export function buildMihomoConfig(node, port) {
  if (!Number.isInteger(port) || port <= 0) throw new Error("Mihomo 监听端口无效");
  const outbound = { ...node, name: "DOLA-OUT" };
  delete outbound["proxy-provider"];
  return YAML.stringify({
    port,
    "bind-address": "127.0.0.1",
    "allow-lan": false,
    mode: "rule",
    "log-level": "warning",
    ipv6: false,
    proxies: [outbound],
    "proxy-groups": [{ name: "DOLA-GROUP", type: "select", proxies: ["DOLA-OUT"] }],
    rules: ["MATCH,DOLA-GROUP"],
  });
}

export class MihomoManager {
  constructor(root, binary) {
    this.root = root;
    this.binary = binary;
    this.running = new Map();
  }

  async ensure(accountId, node) {
    if (!this.binary) throw new Error("缺少 Mihomo 可执行文件，请在发布构建中暂存对应平台的 sidecar");
    const signature = createHash("sha256").update(JSON.stringify(node)).digest("hex");
    const existing = this.running.get(accountId);
    if (existing?.signature === signature && existing.process.exitCode === null) return existing.url;
    await this.stop(accountId);
    const port = await freePort();
    const directory = path.join(this.root, "proxy", accountId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const configPath = path.join(directory, `config-${randomUUID()}.yaml`);
    await writeFile(configPath, buildMihomoConfig(node, port), { mode: 0o600 });
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
