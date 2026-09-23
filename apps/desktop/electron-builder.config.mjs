import { resolveEdition } from "./src/shared/edition.mjs";
import { macSigningOptions } from "./scripts/macos-release.mjs";

const edition = resolveEdition(process.env.DREAMYO_DESKTOP_EDITION);

export default {
    appId: edition.appId,
    productName: edition.productName,
    asar: true,
    directories: { output: process.env.DREAMYO_DESKTOP_OUTPUT_DIR || `dist/${edition.id}` },
    files: ["package.json", "src/main/**/*", "src/preload/**/*", "src/shared/**/*"],
    extraResources: [
        { from: "build/edition.json", to: "edition.json" },
        { from: "../../web/src/lib/desktop-edition-manifest.json", to: "desktop-edition-manifest.json" },
        { from: "build/runtime", to: "runtime" }
    ],
    mac: { icon: "assets/dreamyo.icns", category: "public.app-category.graphics-design", ...macSigningOptions(process.env), target: [{ target: "dmg", arch: [process.arch] }, { target: "zip", arch: [process.arch] }], artifactName: `${edition.productName}-mac-\${arch}-\${version}.\${ext}` },
    win: { icon: "assets/dreamyo.ico", target: [{ target: "nsis", arch: ["x64"] }], artifactName: `${edition.productName}-win-\${arch}-\${version}.\${ext}` },
    nsis: { oneClick: true, perMachine: false, createDesktopShortcut: true, createStartMenuShortcut: true },
};
