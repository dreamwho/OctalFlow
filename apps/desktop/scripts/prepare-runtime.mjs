import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const desktopRoot = path.resolve(import.meta.dirname, "..");
const repositoryRoot = path.resolve(desktopRoot, "../..");

export async function prepareRuntime({ edition, platform = process.platform, arch = process.arch, sourceRoot = repositoryRoot, outputRoot = path.join(desktopRoot, "build", "runtime"), bundledSidecars = path.join(desktopRoot, "resources", "sidecars") }) {
    const sourceWeb = path.join(sourceRoot, "web");
    const sourceStandalone = path.join(sourceWeb, ".next", "standalone");
    const sidecarRoot = path.join(bundledSidecars, `${platform}-${arch}`);
    const extension = platform === "win32" ? ".exe" : "";
    const required = ["dola-api", "geminiai", "chatgpt-api", "geminiai-browser"].map((name) => path.join(sidecarRoot, `${name}${extension}`));
    const browserDir = path.join(sidecarRoot, "camoufox", platform === "darwin" ? "Camoufox.app/Contents/MacOS" : "");
    required.push(path.join(sidecarRoot, "camoufox", "version.json"), path.join(browserDir, "properties.json"), path.join(browserDir, platform === "darwin" ? "camoufox" : "camoufox.exe"));
    for (const file of [path.join(sourceStandalone, "server.js"), ...required]) await assertFile(file);

    await rm(outputRoot, { recursive: true, force: true });
    const targetWeb = path.join(outputRoot, "web");
    const targetStandalone = path.join(targetWeb, ".next", "standalone");
    await mkdir(targetStandalone, { recursive: true });
    for (const item of ["server.js", "package.json", "node_modules", ".next", "src"]) {
        await cp(path.join(sourceStandalone, item), path.join(targetStandalone, item), { recursive: true, force: true });
    }
    await cp(path.join(sourceWeb, "public"), path.join(targetStandalone, "public"), { recursive: true });
    await cp(path.join(sourceWeb, "public"), path.join(targetWeb, "public"), { recursive: true });
    await mkdir(path.join(targetWeb, ".next"), { recursive: true });
    await cp(path.join(sourceWeb, ".next", "static"), path.join(targetWeb, ".next", "static"), { recursive: true });
    await cp(path.join(sourceWeb, "scripts"), path.join(targetWeb, "scripts"), { recursive: true, filter: (entry) => !entry.endsWith(".test.mjs") && !entry.includes("local-data-migration") });
    for (const service of ["geminiai", "dola-api", "chatgpt-api"]) {
        const serviceRoot = path.join(sourceRoot, "services", service);
        const target = path.join(outputRoot, "services", service);
        await mkdir(target, { recursive: true });
        if (service === "geminiai") await cp(path.join(serviceRoot, "config.yaml"), path.join(target, "config.yaml"));
        if (service === "geminiai" || service === "dola-api") await cp(path.join(serviceRoot, "src"), path.join(target, "src"), { recursive: true });
    }
    await cp(sidecarRoot, path.join(outputRoot, "sidecars"), { recursive: true });
    const manifest = { edition, platform, arch, webBuildId: (await readFile(path.join(sourceWeb, ".next", "BUILD_ID"), "utf8")).trim() };
    await writeFile(path.join(outputRoot, "manifest.json"), `${JSON.stringify(manifest)}\n`);
    return { outputRoot, manifest };
}

async function assertFile(file) {
    if (!(await stat(file).catch(() => null))?.isFile()) throw new Error(`桌面安装包缺少平台运行文件：${file}`);
}
