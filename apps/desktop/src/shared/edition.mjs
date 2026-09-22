import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const packagedManifest = process.resourcesPath && path.join(process.resourcesPath, "desktop-edition-manifest.json");
const sourceManifest = path.resolve(import.meta.dirname, "../../../../web/src/lib/desktop-edition-manifest.json");
const manifest = JSON.parse(readFileSync(packagedManifest && existsSync(packagedManifest) ? packagedManifest : sourceManifest, "utf8"));
export const EDITIONS = Object.freeze(Object.fromEntries(Object.entries(manifest).map(([key, value]) => [key, Object.freeze(value)])));

export function resolveEdition(value) {
    const key = String(value || "").trim().toLowerCase();
    const edition = EDITIONS[key];
    if (!edition) throw new Error(`Unsupported desktop edition: ${value || "(empty)"}`);
    return edition;
}
