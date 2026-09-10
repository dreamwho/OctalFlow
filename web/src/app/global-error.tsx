"use client";

import { useEffect } from "react";

import { Button } from "antd";

const CHUNK_ERROR_PATTERN = /Loading chunk \d|ChunkLoadError|Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed/i;
const AUTO_RELOAD_KEY = "octal-global-error-auto-reload-at";

function shouldAutoReload(error: unknown) {
    const message = error instanceof Error ? `${error.message}` : "";
    if (!CHUNK_ERROR_PATTERN.test(message)) return false;
    const now = Date.now();
    try {
        const previous = Number(sessionStorage.getItem(AUTO_RELOAD_KEY) || 0);
        if (now - previous < 30_000) return false;
        sessionStorage.setItem(AUTO_RELOAD_KEY, String(now));
        return true;
    } catch {
        return true;
    }
}

export default function GlobalError({ error, reset }: { error: unknown; reset: () => void }) {
    useEffect(() => {
        if (shouldAutoReload(error)) window.location.reload();
    }, [error]);

    return (
        <html lang="zh-CN">
            <body style={{ alignItems: "center", backgroundColor: "#fafaf9", display: "flex", fontFamily: "system-ui, sans-serif", height: "100vh", justifyContent: "center", margin: 0 }}>
                <main style={{ maxWidth: 420, padding: 24, textAlign: "center" }}>
                    <h1 style={{ color: "#1c1917", fontSize: 20, fontWeight: 600, margin: "0 0 8px" }}>页面加载失败</h1>
                    <p style={{ color: "#57534e", fontSize: 14, lineHeight: 1.6, margin: "0 0 4px" }}>站点更新后浏览器缓存可能引用了失效资源，已尝试自动恢复。</p>
                    <p style={{ color: "#78716c", fontSize: 12, lineHeight: 1.6, margin: "0 0 20px" }}>若仍未恢复，请使用 Ctrl+F5 / Cmd+Shift+R 强制刷新，或清除浏览器缓存后重试。</p>
                    <div style={{ alignItems: "center", display: "flex", gap: 12, justifyContent: "center" }}>
                        <Button type="primary" onClick={() => window.location.reload()}>重新加载</Button>
                        <Button onClick={reset}>重试渲染</Button>
                    </div>
                </main>
            </body>
        </html>
    );
}
