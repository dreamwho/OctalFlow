const ADMIN_LOCAL_HIDDEN_SECTIONS = new Set([
    "overview", "users", "products", "promotions", "coupons", "referrals", "orders", "points", "payments", "cdk", "wallet",
    "site", "accountDeletion", "externalStorage", "announcements", "works", "prompts", "updates", "adminHelp",
]);

export function isAdminLocalSectionEnabled(section: string, edition: "commercial" | "admin" | null = null) {
    return edition !== "admin" || !ADMIN_LOCAL_HIDDEN_SECTIONS.has(section);
}
