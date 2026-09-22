import { cp, mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const source = process.argv[2];
if (!source || !path.isAbsolute(source)) throw new Error("请传入 Camoufox 官方浏览器目录的绝对路径");
const versionFile = path.join(source, "version.json");
const { version } = JSON.parse(await readFile(versionFile, "utf8"));
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Camoufox 浏览器版本文件无效");
const executable = process.platform === "darwin" ? "Camoufox.app/Contents/MacOS/camoufox" : "camoufox.exe";
const properties = process.platform === "darwin" ? "Camoufox.app/Contents/Resources/properties.json" : "properties.json";
for (const item of [executable, properties]) {
    if (!(await stat(path.join(source, item)).catch(() => null))?.isFile()) throw new Error(`Camoufox 官方浏览器缺少 ${item}`);
}
const target = path.resolve(import.meta.dirname, "../resources/sidecars", `${process.platform}-${process.arch}`, "camoufox");
await mkdir(target, { recursive: true });
await cp(source, target, { recursive: true, force: true });
if (process.platform === "darwin") {
    await cp(path.join(source, properties), path.join(target, "Camoufox.app/Contents/MacOS/properties.json"));
}
console.log(`已准备 Camoufox ${version} (${process.platform}-${process.arch})`);
