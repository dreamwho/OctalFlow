import { resolveEdition } from "./src/shared/edition.mjs";

const edition = resolveEdition(process.env.DREAMYO_DESKTOP_EDITION);

export default {
    appId: edition.appId,
    productName: edition.productName,
    asar: true,
    directories: { output: `dist/${edition.id}` },
    files: ["package.json", "src/main/**/*", "src/preload/**/*", "src/shared/**/*"],
    extraResources: [
        { from: "build/edition.json", to: "edition.json" },
        { from: "build/runtime", to: "runtime" }
    ],
    mac: { category: "public.app-category.graphics-design", ...(process.env.DREAMYO_DESKTOP_UNSIGNED_TEST === "1" ? { identity: null } : {}), target: [{ target: "dmg", arch: [process.arch] }, { target: "zip", arch: [process.arch] }], artifactName: `${edition.productName}-mac-\${arch}-\${version}.\${ext}` },
    win: { target: [{ target: "nsis", arch: ["x64"] }], artifactName: `${edition.productName}-win-\${arch}-\${version}.\${ext}` },
    nsis: { oneClick: false, allowToChangeInstallationDirectory: true, createDesktopShortcut: true, createStartMenuShortcut: true },
};
