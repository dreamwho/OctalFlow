export const EDITIONS = Object.freeze({
    commercial: Object.freeze({
        id: "commercial",
        appId: "com.dreamyo.desktop",
        productName: "Dreamyo",
        windowTitle: "Dreamyo",
        requiresLogin: true,
        cloudFeatures: false,
        cloudSync: false,
        localProviders: true,
        localProviderBilling: "free",
        startPath: "/login?next=/canvas",
        implementationStage: "foundation",
    }),
    admin: Object.freeze({
        id: "admin",
        appId: "com.dreamyo.desktop.admin",
        productName: "Dreamyo 管理员本地版",
        windowTitle: "Dreamyo 管理员本地版",
        requiresLogin: false,
        cloudFeatures: false,
        cloudSync: false,
        localProviders: true,
        localProviderBilling: "free",
        startPath: "/api/desktop/bootstrap?next=/canvas",
        implementationStage: "foundation",
    }),
});

export function resolveEdition(value) {
    const key = String(value || "").trim().toLowerCase();
    const edition = EDITIONS[key];
    if (!edition) throw new Error(`Unsupported desktop edition: ${value || "(empty)"}`);
    return edition;
}
