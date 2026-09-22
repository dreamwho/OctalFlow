import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

const GROUP_PORTS = ["geminiai", "geminiTools", "chatgptApi", "dola"];

export async function prepareDesktopMagicProxy({ runtimeRoot, dataRoot, executable, secret, ports }) {
    const directory = path.join(dataRoot, "mihomo");
    const providerFile = path.join(directory, "runtime", "subscription.yaml");
    await mkdir(path.dirname(providerFile), { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") await chmod(path.dirname(providerFile), 0o700);
    try {
        await writeFile(providerFile, "proxies: []\n", { flag: "wx", mode: 0o600 });
    } catch (error) {
        if (error?.code !== "EEXIST") throw error;
    }
    if (process.platform !== "win32") await chmod(providerFile, 0o600);
    const template = await readFile(path.join(runtimeRoot, "desktop", "mihomo-bootstrap.yaml"), "utf8");
    if (!template.includes("external-controller: 0.0.0.0:9090") || !template.includes("path: /root/.config/mihomo/runtime/subscription.yaml") ||
        GROUP_PORTS.some((_, index) => !template.includes(`port: ${17890 + index}`)) || !template.includes("listen: 0.0.0.0")) {
        throw new Error("桌面 Mihomo 模板与本地监听配置不匹配");
    }
    let config = template
        .replace("external-controller: 0.0.0.0:9090", `external-controller: 127.0.0.1:${ports.controller}\nsecret: ${JSON.stringify(secret)}`)
        .replace("path: /root/.config/mihomo/runtime/subscription.yaml", `path: ${JSON.stringify(providerFile)}`)
        .replaceAll("listen: 0.0.0.0", "listen: 127.0.0.1");
    config = config.replace(/port: (1789[0-3])(?=\n|$)/g, (_match, original) => `port: ${ports[GROUP_PORTS[Number(original) - 17890]]}`);
    const pending = path.join(directory, `.config.${randomUUID()}.tmp`);
    try {
        await writeFile(pending, config, { flag: "wx", mode: 0o600 });
        await rename(pending, path.join(directory, "config.yaml"));
    } finally {
        await unlink(pending).catch(() => undefined);
    }
    const environment = {
        DREAMYO_MAGIC_PROXY_CONTROLLER_URL: `http://127.0.0.1:${ports.controller}`,
        DREAMYO_MAGIC_PROXY_SECRET: secret,
        DREAMYO_MAGIC_PROXY_PROVIDER_FILE: providerFile,
        DREAMYO_MAGIC_PROXY_LISTEN_HOST: "127.0.0.1",
        ...Object.fromEntries(GROUP_PORTS.flatMap((key, index) => {
            const prefix = ["GEMINIAI", "GEMINI_TOOLS", "CHATGPT_API", "DOLA"][index];
            return [[`DREAMYO_MAGIC_PROXY_${prefix}_PORT`, String(ports[key])], [`DREAMYO_MAGIC_PROXY_${prefix}_URL`, `http://127.0.0.1:${ports[key]}`]];
        })),
    };
    return { environment, service: { name: "mihomo", command: executable, args: ["-d", directory], cwd: directory } };
}
