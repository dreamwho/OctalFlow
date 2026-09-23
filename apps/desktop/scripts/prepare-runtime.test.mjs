import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { prepareRuntime } from "./prepare-runtime.mjs";

test("packaging copies only compiled runtime and never imports account data or env files", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "dreamyo-desktop-stage-"));
    const source = path.join(directory, "source");
    const standalone = path.join(source, "web/.next-audit/standalone");
    const sidecars = path.join(directory, "sidecars", `${process.platform}-${process.arch}`);
    const output = path.join(directory, "output");
    try {
        for (const entry of ["node_modules", ".next-audit", "src", "public", "scripts", ".data"]) await mkdir(path.join(standalone, entry), { recursive: true });
        const manifest = {
            "/api/billing/orders/route": "app/api/billing/orders/route.js",
            "/api/admin/users/route": "app/api/admin/users/route.js",
            "/api/desktop/cloud-bootstrap/route": "app/api/desktop/cloud-bootstrap/route.js",
            "/api/admin/dola/accounts/route": "app/api/admin/dola/accounts/route.js",
            "/api/desktop/runtime/route": "app/api/desktop/runtime/route.js",
            "/api/desktop/bootstrap/route": "app/api/desktop/bootstrap/route.js",
            "/(user)/billing/page": "app/(user)/billing/page.js",
            "/(user)/community/page": "app/(user)/community/page.js",
            "/login/page": "app/login/page.js",
            "/canvas/page": "app/canvas/page.js",
        };
        await mkdir(path.join(standalone, ".next-audit/server/app"), { recursive: true });
        for (const modulePath of Object.values(manifest)) {
            const routeFile = path.join(standalone, ".next-audit/server", modulePath);
            await mkdir(path.dirname(routeFile), { recursive: true });
            const chunk = modulePath.includes("billing") || modulePath.includes("community") ? "cloud-only.js" : "local-shared.js";
            await writeFile(routeFile, `var R={c:(value)=>value}; R.c(${JSON.stringify(`server/chunks/${chunk}`)});`);
        }
        await mkdir(path.join(standalone, ".next-audit/server/chunks"), { recursive: true });
        for (const chunk of ["cloud-only.js", "local-shared.js", "orphan.js"]) await writeFile(path.join(standalone, `.next-audit/server/chunks/${chunk}`), chunk);
        await writeFile(path.join(standalone, ".next-audit/server/chunks/cloud-only.js.map"), "cloud source map");
        await writeFile(path.join(standalone, ".next-audit/server/app-paths-manifest.json"), JSON.stringify(manifest));
        for (const [file, route, chunk] of [
            ["app/(user)/billing/page_client-reference-manifest.js", "/(user)/billing/page", "billing"],
            ["app/canvas/page_client-reference-manifest.js", "/canvas/page", "canvas"],
        ]) {
            const rscManifest = { clientModules: { page: { chunks: [`/_next/static/chunks/${chunk}.js`, "/_next/static/chunks/shared.js"] } } };
            const clientManifest = `globalThis.__RSC_MANIFEST = {}; globalThis.__RSC_MANIFEST[${JSON.stringify(route)}] = ${JSON.stringify(rscManifest)};`;
            const filePath = path.join(standalone, ".next-audit/server", file);
            await mkdir(path.dirname(filePath), { recursive: true });
            await writeFile(filePath, clientManifest);
        }
        await mkdir(path.join(source, "web/.next-audit/static"), { recursive: true });
        await writeFile(path.join(source, "web/.next-audit/static/app.js"), "hydrate");
        await mkdir(path.join(source, "web/.next-audit/static/chunks"), { recursive: true });
        for (const chunk of ["billing.js", "canvas.js", "shared.js"]) await writeFile(path.join(source, `web/.next-audit/static/chunks/${chunk}`), chunk);
        await writeFile(path.join(standalone, ".next-audit/build-manifest.json"), JSON.stringify({ rootMainFiles: ["static/chunks/shared.js"] }));
        await mkdir(path.join(source, "web/public"), { recursive: true });
        await mkdir(path.join(source, "web/scripts"), { recursive: true });
        await mkdir(path.join(source, "web/src/lib"), { recursive: true });
        await writeFile(path.join(source, "web/src/lib/desktop-cloud-routes.json"), JSON.stringify(["/api/billing", "/api/admin/users", "/api/desktop/cloud-bootstrap"]));
        await writeFile(path.join(source, "web/src/lib/desktop-admin-cloud-pages.json"), JSON.stringify(["/billing", "/community", "/login", "/register", "/install"]));
        for (const service of ["geminiai", "dola-api"]) await mkdir(path.join(source, "services", service, "src"), { recursive: true });
        await mkdir(path.join(source, "apps", "desktop", "assets"), { recursive: true });
        await mkdir(sidecars, { recursive: true });
        await mkdir(path.join(sidecars, "camoufox"), { recursive: true });
        await mkdir(path.join(sidecars, "playwright-driver"), { recursive: true });
        await writeFile(path.join(sidecars, "playwright-driver", "index.js"), "driver");
        const extension = process.platform === "win32" ? ".exe" : "";
        for (const binary of ["dola-api", "geminiai", "chatgpt-api", "geminiai-browser", "mihomo", "ffmpeg", "ffprobe", "dreamina", "video-depth"]) await writeFile(path.join(sidecars, `${binary}${extension}`), fakeExecutable(process.platform, process.arch));
        await mkdir(path.join(sidecars, "video-depth-model"), { recursive: true });
        for (const file of ["config.json", "model.safetensors", "preprocessor_config.json"]) await writeFile(path.join(sidecars, "video-depth-model", file), "model");
        const camoufox = path.join(sidecars, "camoufox", process.platform === "darwin" ? "Camoufox.app/Contents/MacOS/camoufox" : "camoufox.exe");
        await mkdir(path.dirname(camoufox), { recursive: true });
        await writeFile(camoufox, fakeExecutable(process.platform, process.arch));
        await writeFile(path.join(path.dirname(camoufox), "properties.json"), "[]");
        await writeFile(path.join(sidecars, "camoufox", "version.json"), '{"version":"135.0.1"}');
        await writeFile(path.join(standalone, "server.js"), "server");
        await writeFile(path.join(standalone, "package.json"), "{}");
        await writeFile(path.join(standalone, ".data", "cookie.txt"), "never ship me");
        await writeFile(path.join(source, "web/.env.local"), "never ship me");
        await writeFile(path.join(source, "web/.next-audit/BUILD_ID"), "test-build");
        await writeFile(path.join(source, "services/geminiai/config.yaml"), "browser: camoufox");
        await mkdir(path.join(source, "services/chatgpt-api"), { recursive: true });
        await writeFile(path.join(source, "services/chatgpt-api/LICENSE.upstream"), "upstream license");
        await writeFile(path.join(source, "services/chatgpt-api/NOTICE.upstream"), "upstream notice");
        await writeFile(path.join(source, "apps/desktop/assets/mihomo-bootstrap.yaml"), "mode: rule\n");
        await writeFile(path.join(source, "web/scripts/start-standalone.mjs"), "runtime");

        const options = { edition: "admin", sourceRoot: source, outputRoot: output, bundledSidecars: path.join(directory, "sidecars"), distDir: ".next-audit" };
        const result = await prepareRuntime(options);

        assert.equal(result.manifest.webBuildId, "test-build");
        assert.equal(result.manifest.distDir, ".next-audit");
        assert.equal(await readFile(path.join(output, "web/.next-audit/standalone/server.js"), "utf8"), "server");
        assert.ok((await stat(path.join(output, "web/.next-audit/standalone/.next-audit"))).isDirectory());
        assert.equal(await readFile(path.join(output, "web/.next-audit/standalone/.next-audit/static/app.js"), "utf8"), "hydrate");
        const packagedRoutes = JSON.parse(await readFile(path.join(output, "web/.next-audit/standalone/.next-audit/server/app-paths-manifest.json"), "utf8"));
        assert.deepEqual(Object.keys(packagedRoutes), ["/api/admin/dola/accounts/route", "/api/desktop/runtime/route", "/api/desktop/bootstrap/route", "/canvas/page"]);
        assert.equal(await stat(path.join(output, "web/.next-audit/standalone/.next-audit/server/app/api/billing/orders/route.js")).catch(() => null), null);
        assert.match(await readFile(path.join(output, "web/.next-audit/standalone/.next-audit/server/app/api/admin/dola/accounts/route.js"), "utf8"), /server\/chunks\/local-shared\.js/);
        assert.equal(await readFile(path.join(output, "web/.next-audit/standalone/.next-audit/server/chunks/cloud-only.js"), "utf8"), "cloud-only.js");
        assert.equal(await readFile(path.join(output, "web/.next-audit/standalone/.next-audit/server/chunks/cloud-only.js.map"), "utf8"), "cloud source map");
        assert.equal(await readFile(path.join(output, "web/.next-audit/standalone/.next-audit/server/chunks/orphan.js"), "utf8"), "orphan.js");
        assert.equal(await readFile(path.join(output, "web/.next-audit/standalone/.next-audit/server/chunks/local-shared.js"), "utf8"), "local-shared.js");
        assert.equal(await stat(path.join(output, "web/.next-audit/standalone/.next-audit/static/chunks/billing.js")).catch(() => null), null);
        assert.equal(await readFile(path.join(output, "web/.next-audit/standalone/.next-audit/static/chunks/canvas.js"), "utf8"), "canvas.js");
        assert.equal(await readFile(path.join(output, "web/.next-audit/standalone/.next-audit/static/chunks/shared.js"), "utf8"), "shared.js");
        const commercialOutput = path.join(directory, "commercial-output");
        await prepareRuntime({ ...options, edition: "commercial", outputRoot: commercialOutput });
        const commercialRoutes = JSON.parse(await readFile(path.join(commercialOutput, "web/.next-audit/standalone/.next-audit/server/app-paths-manifest.json"), "utf8"));
        assert.ok(commercialRoutes["/api/billing/orders/route"]);
        assert.ok(commercialRoutes["/(user)/billing/page"]);
        assert.equal(await readFile(path.join(commercialOutput, "web/.next-audit/standalone/.next-audit/server/chunks/cloud-only.js"), "utf8"), "cloud-only.js");
        assert.equal(await stat(path.join(output, "web/.next-audit/standalone/.data")).catch(() => null), null);
        assert.equal(await stat(path.join(output, "web/.env.local")).catch(() => null), null);
        assert.equal(await readFile(path.join(output, "desktop/mihomo-bootstrap.yaml"), "utf8"), "mode: rule\n");
        assert.equal(await readFile(path.join(output, "services/chatgpt-api/LICENSE.upstream"), "utf8"), "upstream license");
        await rm(path.join(sidecars, `mihomo${extension}`));
        await assert.rejects(() => prepareRuntime(options), /mihomo/);
        await writeFile(path.join(sidecars, `mihomo${extension}`), fakeExecutable(process.platform, process.arch));
        await rm(path.join(path.dirname(camoufox), "properties.json"));
        await assert.rejects(() => prepareRuntime(options), /properties\.json/);
        await writeFile(path.join(path.dirname(camoufox), "properties.json"), "[]");
        await writeFile(path.join(sidecars, `mihomo${extension}`), fakeExecutable(process.platform, process.arch === "arm64" ? "x64" : "arm64"));
        await assert.rejects(() => prepareRuntime(options), /架构不匹配.*mihomo/);

        const windowsSidecars = path.join(directory, "sidecars", "win32-x64");
        await mkdir(path.join(windowsSidecars, "camoufox"), { recursive: true });
        await mkdir(path.join(windowsSidecars, "playwright-driver"), { recursive: true });
        await writeFile(path.join(windowsSidecars, "playwright-driver", "index.js"), "driver");
        await mkdir(path.join(windowsSidecars, "video-depth-model"), { recursive: true });
        for (const name of ["dola-api", "geminiai", "chatgpt-api", "geminiai-browser", "mihomo", "ffmpeg", "ffprobe", "dreamina", "video-depth"]) {
            await writeFile(path.join(windowsSidecars, `${name}.exe`), fakeExecutable("win32", "x64"));
        }
        const dreaminaHash = createHash("sha256").update(fakeExecutable("win32", "x64")).digest("hex");
        await writeFile(path.join(windowsSidecars, "dreamina-release.json"), JSON.stringify({ version: "1.4.18", filename: "dreamina_cli_windows_amd64.exe", sha256: dreaminaHash }));
        for (const name of ["config.json", "model.safetensors", "preprocessor_config.json"]) await writeFile(path.join(windowsSidecars, "video-depth-model", name), "model");
        await writeFile(path.join(windowsSidecars, "camoufox", "camoufox.exe"), fakeExecutable("win32", "x64"));
        await writeFile(path.join(windowsSidecars, "camoufox", "properties.json"), "{}");
        await writeFile(path.join(windowsSidecars, "camoufox", "version.json"), '{"version":"135.0.1"}');
        const windowsOutput = path.join(directory, "windows-output");
        const windows = await prepareRuntime({ ...options, platform: "win32", arch: "x64", outputRoot: windowsOutput });
        assert.equal(windows.manifest.platform, "win32");
        assert.deepEqual(await readFile(path.join(windowsOutput, "sidecars", "geminiai.exe")), fakeExecutable("win32", "x64"));
        assert.equal(await readFile(path.join(windowsOutput, "desktop", "mihomo-bootstrap.yaml"), "utf8"), "mode: rule\n");
        await writeFile(path.join(windowsSidecars, "dreamina-release.json"), JSON.stringify({ version: "1.4.18", filename: "dreamina_cli_windows_amd64.exe", sha256: "0".repeat(64) }));
        await assert.rejects(() => prepareRuntime({ ...options, platform: "win32", arch: "x64", outputRoot: windowsOutput }), /即梦 CLI 发布清单与 Windows x64 二进制不匹配/);
        await writeFile(path.join(windowsSidecars, "dreamina-release.json"), JSON.stringify({ version: "1.4.18", filename: "dreamina_cli_windows_amd64.exe", sha256: dreaminaHash }));
        await writeFile(path.join(windowsSidecars, "geminiai.exe"), fakeExecutable("win32", "arm64"));
        await assert.rejects(() => prepareRuntime({ ...options, platform: "win32", arch: "x64", outputRoot: windowsOutput }), /架构不匹配.*geminiai\.exe/);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

function fakeExecutable(platform, arch) {
    const buffer = Buffer.alloc(128);
    if (platform === "darwin") {
        buffer.writeUInt32LE(0xfeedfacf, 0);
        buffer.writeUInt32LE(arch === "arm64" ? 0x0100000c : 0x01000007, 4);
    } else {
        buffer.write("MZ", 0, "ascii");
        buffer.writeUInt32LE(0x40, 0x3c);
        buffer.write("PE\0\0", 0x40, "ascii");
        buffer.writeUInt16LE(arch === "arm64" ? 0xaa64 : 0x8664, 0x44);
    }
    return buffer;
}

test("packaging accepts an isolated production build without reading the live build", async () => {
    await assert.rejects(
        () => prepareRuntime({ edition: "admin", sourceRoot: "/nonexistent", distDir: "../../.next" }),
        /无效的 Web 构建目录/,
    );
});
