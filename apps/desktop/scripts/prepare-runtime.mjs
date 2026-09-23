import { cp, mkdir, readFile, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
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
    if (platform === "win32") await verifyDreaminaRelease(sidecarRoot);
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
    if (edition === "admin") await pruneAdminCloudRoutes(targetStandalone, distDir, path.join(sourceWeb, "src/lib/desktop-cloud-routes.json"), path.join(sourceWeb, "src/lib/desktop-admin-cloud-pages.json"));
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

export async function pruneAdminCloudRoutes(standaloneRoot, distDir, routeRootsFile, pageRootsFile) {
    const manifestPath = path.join(standaloneRoot, distDir, "server/app-paths-manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const configuredRoots = JSON.parse(await readFile(routeRootsFile, "utf8"));
    const pageRoots = JSON.parse(await readFile(pageRootsFile, "utf8"));
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest) || Object.values(manifest).some((modulePath) => typeof modulePath !== "string") || !Array.isArray(configuredRoots) || !Array.isArray(pageRoots) || [...configuredRoots, ...pageRoots].some((root) => typeof root !== "string" || !root.startsWith("/"))) {
        throw new Error("管理员本地版云端路由清单格式无效");
    }
    const apiRoots = configuredRoots.filter((root) => root.startsWith("/api/"));
    let removed = 0;
    for (const [route, modulePath] of Object.entries(manifest)) {
        const isApi = route.startsWith("/api/") && route.endsWith("/route");
        const isPage = route.endsWith("/page");
        if (!isApi && !isPage) continue;
        const pathname = route.slice(0, isApi ? -"/route".length : -"/page".length).replaceAll(/\/\([^/]+\)/g, "");
        const roots = isApi ? apiRoots : pageRoots;
        if (!roots.some((root) => pathname === root || pathname.startsWith(`${root}/`))) continue;
        const compiledPath = path.resolve(standaloneRoot, distDir, "server", modulePath);
        const serverRoot = `${path.resolve(standaloneRoot, distDir, "server")}${path.sep}`;
        if (!compiledPath.startsWith(serverRoot)) throw new Error(`管理员本地版路由清单包含越界模块：${modulePath}`);
        await unlink(compiledPath);
        await rm(path.join(serverRoot, `${modulePath.slice(0, -3)}_client-reference-manifest.js`), { force: true });
        if (isPage) await rm(path.join(serverRoot, path.dirname(modulePath), path.basename(modulePath, ".js"), "build-manifest.json"), { force: true });
        delete manifest[route];
        removed++;
    }
    if (pageRoots.length) await pruneUnreferencedAdminPageChunks(standaloneRoot, distDir);
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, "utf8");
    return removed;
}

async function pruneUnreferencedAdminPageChunks(standaloneRoot, distDir) {
    const distRoot = path.join(standaloneRoot, distDir);
    const serverApp = path.join(distRoot, "server/app");
    const staticRoot = path.join(distRoot, "static");
    const retainedAssets = new Set();
    const referenceFiles = (await listFiles(serverApp)).filter((file) => file.endsWith("_client-reference-manifest.js"));
    for (const file of referenceFiles) {
        collectStaticAssets(parseClientReferenceManifest(await readFile(file, "utf8")), retainedAssets);
    }
    const appBuildManifest = await readFile(path.join(distRoot, "build-manifest.json"), "utf8").catch(() => "");
    if (appBuildManifest) collectStaticAssets(JSON.parse(appBuildManifest), retainedAssets);
    if (!retainedAssets.size) throw new Error("管理员本地版未找到保留页面的静态资源引用，拒绝清理构建文件");
    for (const asset of retainedAssets) {
        const assetPath = path.resolve(distRoot, asset);
        const staticPath = `${path.resolve(staticRoot)}${path.sep}`;
        if (!assetPath.startsWith(staticPath) || !(await stat(assetPath).catch(() => null))?.isFile()) {
            throw new Error(`管理员本地版页面引用的静态资源缺失：${asset}`);
        }
    }
    for (const file of await listFiles(path.join(staticRoot, "chunks"))) {
        const relative = path.relative(distRoot, file).split(path.sep).join("/");
        const isChunk = /\.m?js$|\.css$/.test(relative);
        const isSourceMap = /\.(?:m?js|css)\.map$/.test(relative);
        if (isChunk && !retainedAssets.has(relative)) await unlink(file);
        if (isSourceMap && !retainedAssets.has(relative.replace(/\.map$/, ""))) await unlink(file);
    }
}

function parseClientReferenceManifest(source) {
    const manifests = {};
    const assignment = /globalThis\.__RSC_MANIFEST\[("(?:\\.|[^"\\])*")\]\s*=\s*/g;
    for (const match of source.matchAll(assignment)) {
        const start = match.index + match[0].length;
        if (source[start] !== "{") continue;
        let depth = 0;
        let inString = false;
        let escaped = false;
        let end = start;
        for (; end < source.length; end++) {
            const character = source[end];
            if (inString) {
                if (escaped) escaped = false;
                else if (character === "\\") escaped = true;
                else if (character === '"') inString = false;
                continue;
            }
            if (character === '"') inString = true;
            else if (character === "{") depth++;
            else if (character === "}" && --depth === 0) break;
        }
        if (depth !== 0) throw new Error("管理员本地版 RSC 页面资源清单 JSON 不完整");
        manifests[JSON.parse(match[1])] = JSON.parse(source.slice(start, end + 1));
    }
    return manifests;
}

async function listFiles(directory) {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    const files = [];
    for (const entry of entries) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) files.push(...await listFiles(file));
        else if (entry.isFile()) files.push(file);
    }
    return files;
}

function collectStaticAssets(value, assets) {
    if (typeof value === "string") {
        const relative = value.replace(/^\/_next\//, "").split(/[?#]/, 1)[0];
        if (/^static\/chunks\/.+\.(?:m?js|css)$/.test(relative)) assets.add(relative);
    } else if (Array.isArray(value)) {
        for (const item of value) collectStaticAssets(item, assets);
    } else if (value && typeof value === "object") {
        for (const item of Object.values(value)) collectStaticAssets(item, assets);
    }
}

async function assertFile(file) {
    if (!(await stat(file).catch(() => null))?.isFile()) throw new Error(`桌面安装包缺少平台运行文件：${file}`);
}

async function verifyDreaminaRelease(sidecarRoot) {
    const binary = await readFile(path.join(sidecarRoot, "dreamina.exe"));
    const release = JSON.parse(await readFile(path.join(sidecarRoot, "dreamina-release.json"), "utf8"));
    const digest = createHash("sha256").update(binary).digest("hex");
    if (release.filename !== "dreamina_cli_windows_amd64.exe" || !/^\d+\.\d+\.\d+$/.test(release.version ?? "") || release.sha256 !== digest) {
        throw new Error("桌面安装包即梦 CLI 发布清单与 Windows x64 二进制不匹配");
    }
}
