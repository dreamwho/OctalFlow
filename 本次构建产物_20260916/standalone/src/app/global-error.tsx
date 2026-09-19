"use client";

import { useEffect } from "react";

import { Button } from "antd";

const CHUNK_ERROR_PATTERN = /Loading chunk \d|ChunkLoadError|Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed/i;
const AUTO_RELOAD_KEY = "dreamyo-global-error-auto-reload-at";

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
            <head>
                <title>页面加载失败 | dreamyo</title>
            </head>
            <body
                style={{
                    alignItems: "center",
                    background: "linear-gradient(135deg, #eef4ff 0%, #e8fbfa 52%, #f2edff 100%)",
                    color: "#12245f",
                    display: "flex",
                    fontFamily: "system-ui, sans-serif",
                    height: "100vh",
                    justifyContent: "center",
                    margin: 0,
                    padding: 24,
                }}
            >
                <main style={{ background: "rgba(255,255,255,.86)", border: "1px solid rgba(102,137,255,.35)", borderRadius: 24, boxShadow: "0 24px 70px rgba(70,102,220,.18)", maxWidth: 440, padding: "32px 28px", textAlign: "center", width: "100%" }}>
                    <img src="/icon.svg" alt="dreamyo" width="48" height="48" style={{ display: "block", margin: "0 auto 18px" }} />
                    <h1 style={{ color: "#12245f", fontSize: 20, fontWeight: 650, margin: "0 0 8px" }}>页面加载失败</h1>
                    <p style={{ color: "#3d568c", fontSize: 14, lineHeight: 1.6, margin: "0 0 4px" }}>站点更新后浏览器缓存可能引用了失效资源，已尝试自动恢复。</p>
                    <p style={{ color: "#60739d", fontSize: 12, lineHeight: 1.6, margin: "0 0 20px" }}>若仍未恢复，请使用 Ctrl+F5 / Cmd+Shift+R 强制刷新，或清除浏览器缓存后重试。</p>
                    <div style={{ alignItems: "center", display: "flex", gap: 12, justifyContent: "center" }}>
                        <Button type="primary" style={{ background: "linear-gradient(90deg, #3978ff, #28cfe0 52%, #9b79f7)", border: 0, boxShadow: "0 8px 20px rgba(57,120,255,.25)" }} onClick={() => window.location.reload()}>
                            重新加载
                        </Button>
                        <Button style={{ borderColor: "#b9caff", color: "#244394" }} onClick={reset}>
                            重试渲染
                        </Button>
                    </div>
                </main>
            </body>
        </html>
    );
}
