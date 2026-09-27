export async function register() {
    if (process.env.NEXT_RUNTIME !== "nodejs") return;
    try {
        const { repairMagicProxyRuntimeConfig } = await import("./lib/server/magic-proxy-service");
        void repairMagicProxyRuntimeConfig();
    } catch {
        // 启动自愈失败不阻塞服务启动。
    }
}
