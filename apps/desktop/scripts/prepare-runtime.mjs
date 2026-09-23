import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { verifyExecutable } from "./verify-executable.mjs";

const desktopRoot = path.resolve(import.meta.dirname, "..");
const repositoryRoot = path.resolve(desktopRoot, "../..");

export async function prepareRuntime({ edition, platform = process.platform, arch = process.arch, sourceRoot = repositoryRoot, outputRoot = path.join(desktopRoot, "build", "runtime"), bundledSidecars = path.join(desktopRoot, "resources", "sidecars"), distDir = ".next" }) {
    const sourceWeb = path.join(sourceRoot, "web");
    if (!/^\.next(?:-[a-z\d-]+)?$/.test(distDir)) throw new Error("无效的 Web 构建目录");
    const sourceBuild = path.join(sourceWeb, distDir);
    const sourceStandalone = path.join(sourceBuild, "standalone");
    const sidecarRoot = path.join(bundledSidecars, `${platform}-${arch}`);
    const extension = platform === "win32" ? ".exe" : "";
    const executables = ["dola-api", "geminiai", "chatgpt-api", "geminiai-browser", "mihomo", "ffmpeg", "ffprobe", "dreamina", "video-depth"].map((name) => path.join(sidecarRoot, `${name}${extension}`));
    const browserDir = path.join(sidecarRoot, "camoufox", platform === "darwin" ? "Camoufox.app/Contents/MacOS" : "");
    executables.push(path.join(browserDir, platform === "darwin" ? "camoufox" : "camoufox.exe"));
    const required = [...executables, path.join(sidecarRoot, "camoufox", "version.json"), path.join(browserDir, "properties.json"), path.join(sidecarRoot, "playwright-driver", "index.js")];
    await assertFile(path.join(sourceStandalone, "server.js"));
    for (const file of required) await assertFile(file);
    for (const file of executables) await verifyExecutable(file, platform, arch);
    for (const modelFile of ["config.json", "model.safetensors", "preprocessor_config.json"]) await assertFile(path.join(sidecarRoot, "video-depth-model", modelFile));

    await rm(outputRoot, { recursive: true, force: true });
    const targetWeb = path.join(outputRoot, "web");
    const targetStandalone = path.join(targetWeb, distDir, "standalone");
    await mkdir(targetStandalone, { recursive: true });
    for (const item of ["server.js", "package.json", "node_modules", distDir, "src"]) {
        await cp(path.join(sourceStandalone, item), path.join(targetStandalone, item), { recursive: true, force: true });
    }
    await cp(path.join(sourceWeb, "public"), path.join(targetStandalone, "public"), { recursive: true });
    await cp(path.join(sourceWeb, "public"), path.join(targetWeb, "public"), { recursive: true });
    await mkdir(path.join(targetStandalone, distDir), { recursive: true });
    await cp(path.join(sourceBuild, "static"), path.join(targetStandalone, distDir, "static"), { recursive: true });
    await cp(path.join(sourceWeb, "scripts"), path.join(targetWeb, "scripts"), { recursive: true, filter: (entry) => !entry.endsWith(".test.mjs") && !entry.includes("local-data-migration") });
    for (const service of ["geminiai", "dola-api", "chatgpt-api"]) {
        const serviceRoot = path.join(sourceRoot, "services", service);
        const target = path.join(outputRoot, "services", service);
        await mkdir(target, { recursive: true });
        if (service === "geminiai") await cp(path.join(serviceRoot, "config.yaml"), path.join(target, "config.yaml"));
        if (service === "geminiai" || service === "dola-api") await cp(path.join(serviceRoot, "src"), path.join(target, "src"), { recursive: true });
        if (service === "chatgpt-api") {
            await cp(path.join(serviceRoot, "LICENSE.upstream"), path.join(target, "LICENSE.upstream"));
            await cp(path.join(serviceRoot, "NOTICE.upstream"), path.join(target, "NOTICE.upstream"));
        }
    }
    await cp(sidecarRoot, path.join(outputRoot, "sidecars"), { recursive: true });
    await mkdir(path.join(outputRoot, "desktop"), { recursive: true });
    await cp(path.join(sourceRoot, "apps", "desktop", "assets", "mihomo-bootstrap.yaml"), path.join(outputRoot, "desktop", "mihomo-bootstrap.yaml"));
    const manifest = { edition, platform, arch, distDir, webBuildId: (await readFile(path.join(sourceBuild, "BUILD_ID"), "utf8")).trim() };
    await writeFile(path.join(outputRoot, "manifest.json"), `${JSON.stringify(manifest)}\n`);
    return { outputRoot, manifest };
}

async function assertFile(file) {
    if (!(await stat(file).catch(() => null))?.isFile()) throw new Error(`桌面安装包缺少平台运行文件：${file}`);
}
