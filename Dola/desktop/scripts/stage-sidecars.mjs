import { cp, mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const desktopRoot = path.resolve(import.meta.dirname, "..");
const destination = path.join(desktopRoot, "resources", "sidecars", process.platform, process.arch);
const provider = process.env.DOLA_PROVIDER_BINARY || path.join(desktopRoot, "build", "provider", "dist", process.platform === "win32" ? "dola-api.exe" : "dola-api");
const mihomo = process.env.DOLA_MIHOMO_BINARY;
const camoufox = process.env.DOLA_CAMOUFOX_DIR;

if (!mihomo || !camoufox) throw new Error("请设置 DOLA_MIHOMO_BINARY 与 DOLA_CAMOUFOX_DIR，指定本机平台和架构的原始运行时");
for (const source of [provider, mihomo, camoufox]) await stat(source);
const version = JSON.parse(await readFile(path.join(camoufox, "version.json"), "utf8"));
if (!/^\d+\./.test(version.version || "")) throw new Error("Camoufox version.json 缺少 Firefox 主版本");
const browserBinary = path.join(camoufox, process.platform === "darwin" ? "Camoufox.app/Contents/MacOS/camoufox" : "camoufox.exe");
await stat(browserBinary);
await mkdir(destination, { recursive: true });
await cp(provider, path.join(destination, process.platform === "win32" ? "dola-api.exe" : "dola-api"));
await cp(mihomo, path.join(destination, process.platform === "win32" ? "mihomo.exe" : "mihomo"));
await cp(camoufox, path.join(destination, "camoufox"), { recursive: true, force: true });
console.log(`已暂存当前 ${process.platform}-${process.arch} 的 Provider、Mihomo 与 Camoufox：${destination}`);
