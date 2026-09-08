import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

export async function prepareStandaloneAssets({ webRoot, distDir = ".next" }) {
    const buildRoot = resolveChildPath(webRoot, distDir, "build directory");
    const standaloneOutputRoot = path.join(buildRoot, "standalone");
    const standaloneRoot = await findStandaloneServerRoot(standaloneOutputRoot);
    const serverEntry = path.join(standaloneRoot, "server.js");
    const sourceStatic = path.join(buildRoot, "static");
    const targetStatic = path.join(standaloneRoot, distDir, "static");
    const sourcePublic = path.join(webRoot, "public");
    const targetPublic = path.join(standaloneRoot, "public");

    await assertFile(serverEntry, `Standalone server was not found: ${serverEntry}`);
    const sharpRuntimePackages = await copySharpRuntimePackages(webRoot, standaloneOutputRoot);
    const sourceStaticFiles = await listRelativeFiles(sourceStatic);
    if (!sourceStaticFiles.length) throw new Error(`Build static directory is empty: ${sourceStatic}`);

    const sourcePublicFiles = await listRelativeFiles(sourcePublic);
    for (const requiredAsset of ["logo.svg", "icon.svg"]) {
        if (!sourcePublicFiles.includes(requiredAsset)) throw new Error(`Required brand asset is missing: public/${requiredAsset}`);
    }

    await copyDirectoryContents(sourceStatic, targetStatic);
    await copyDirectoryContents(sourcePublic, targetPublic);

    const targetStaticFiles = await listRelativeFiles(targetStatic);
    const targetPublicFiles = await listRelativeFiles(targetPublic);
    if (!targetStaticFiles.length) throw new Error(`Standalone static directory is empty: ${targetStatic}`);
    const missingPublicFiles = sourcePublicFiles.filter((file) => !targetPublicFiles.includes(file));
    if (missingPublicFiles.length) throw new Error(`Standalone public directory is incomplete: ${missingPublicFiles.join(", ")}`);

    return { serverEntry, standaloneRoot, staticFiles: targetStaticFiles.length, publicFiles: targetPublicFiles.length, sharpRuntimePackages };
}

async function findStandaloneServerRoot(root, current = root, depth = 0) {
    const candidate = path.join(current, "server.js");
    try {
        if ((await stat(candidate)).isFile()) return current;
    } catch {}
    if (depth >= 6) return root;
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
        if (!entry.isDirectory() || entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        const found = await findStandaloneServerRoot(root, path.join(current, entry.name), depth + 1);
        if (found !== root || found === current) return found;
    }
    return root;
}

async function copySharpRuntimePackages(webRoot, standaloneRoot) {
    const sourcePnpmRoot = path.join(webRoot, "node_modules", ".pnpm");
    const targetPnpmRoot = path.join(standaloneRoot, "node_modules", ".pnpm");
    const packages = (await readdir(sourcePnpmRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory() && entry.name.startsWith("@img+sharp-"));
    if (!packages.length) throw new Error(`Sharp runtime packages were not found: ${sourcePnpmRoot}`);
    if (process.platform === "linux" && !packages.some((entry) => entry.name.startsWith("@img+sharp-linux"))) {
        throw new Error(`Sharp native Linux runtime package was not found: ${sourcePnpmRoot}`);
    }
    if (process.platform === "linux" && !packages.some((entry) => entry.name.startsWith("@img+sharp-libvips-linux"))) {
        throw new Error(`Sharp libvips runtime package was not found: ${sourcePnpmRoot}`);
    }

    await mkdir(targetPnpmRoot, { recursive: true });
    await Promise.all(
        packages.map(async (entry) => {
            const sourcePackageRoot = path.join(sourcePnpmRoot, entry.name);
            const targetPackageRoot = path.join(targetPnpmRoot, entry.name);
            await rm(targetPackageRoot, { recursive: true, force: true });
            await cp(sourcePackageRoot, targetPackageRoot, { recursive: true, force: true });
            await hydrateTracedSharpPackages(sourcePackageRoot, standaloneRoot);
        }),
    );
    return packages.map((entry) => entry.name).sort();
}

async function hydrateTracedSharpPackages(sourcePackageRoot, standaloneRoot) {
    const sourceScopeRoot = path.join(sourcePackageRoot, "node_modules", "@img");
    const payloads = (await readdir(sourceScopeRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory());
    for (const payload of payloads) {
        const source = path.join(sourceScopeRoot, payload.name);
        const targets = await findDirectoriesNamed(standaloneRoot, payload.name);
        await Promise.all(targets.map((target) => cp(source, target, { recursive: true, force: true })));
    }
}

async function findDirectoriesNamed(root, name, current = root) {
    const entries = await readdir(current, { withFileTypes: true });
    const matches = [];
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const target = path.join(current, entry.name);
        if (entry.name === name && (await isFile(path.join(target, "package.json")))) {
            matches.push(target);
            continue;
        }
        matches.push(...(await findDirectoriesNamed(root, name, target)));
    }
    return matches;
}

async function isFile(target) {
    try {
        return (await stat(target)).isFile();
    } catch {
        return false;
    }
}

async function assertFile(target, message) {
    try {
        if (!(await stat(target)).isFile()) throw new Error(message);
    } catch {
        throw new Error(message);
    }
}

async function copyDirectoryContents(source, target) {
    await mkdir(target, { recursive: true });
    const entries = await readdir(source, { withFileTypes: true });
    await Promise.all(entries.map((entry) => cp(path.join(source, entry.name), path.join(target, entry.name), { recursive: true, force: true })));
}

async function listRelativeFiles(root, current = root) {
    const entries = await readdir(current, { withFileTypes: true });
    const files = await Promise.all(
        entries.map(async (entry) => {
            const target = path.join(current, entry.name);
            if (entry.isDirectory()) return listRelativeFiles(root, target);
            return entry.isFile() ? [path.relative(root, target).replaceAll(path.sep, "/")] : [];
        }),
    );
    return files.flat().sort();
}

function resolveChildPath(root, child, label) {
    const resolvedRoot = path.resolve(root);
    const resolved = path.resolve(resolvedRoot, child);
    if (resolved === resolvedRoot || !resolved.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error(`Invalid ${label}: ${child}`);
    return resolved;
}
