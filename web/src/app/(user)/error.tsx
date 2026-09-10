"use client";

import { useEffect } from "react";
import { Button } from "antd";

export default function UserWorkspaceError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
    useEffect(() => {
        console.error("[workspace]", error);
    }, [error]);

    return (
        <main className="flex h-full items-center justify-center overflow-auto bg-background px-6">
            <section className="flex max-w-md flex-col items-center gap-3 py-10 text-center">
                <h1 className="text-lg font-medium text-stone-950 sm:text-xl dark:text-stone-100">页面加载失败</h1>
                <p className="text-sm leading-6 text-stone-500">
                    {error?.message || "渲染时出现异常，请重试。"}
                    {error?.digest ? <span className="mt-1 block text-xs text-stone-400">错误编号：{error.digest}</span> : null}
                </p>
                <div className="flex items-center gap-2">
                    <Button type="primary" size="small" onClick={reset}>
                        重试
                    </Button>
                    <Button size="small" onClick={() => window.location.reload()}>
                        重新加载页面
                    </Button>
                </div>
            </section>
        </main>
    );
}
