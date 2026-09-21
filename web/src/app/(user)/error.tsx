"use client";

import { useEffect } from "react";
import { Button } from "antd";

export default function UserWorkspaceError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
    useEffect(() => {
        console.error("[workspace]", error);
        document.title = "页面加载失败 | dreamyo";
    }, [error]);

    return (
        <main className="flex h-full items-center justify-center overflow-auto bg-[#f1f5ff] px-6 text-[#12245f] dark:bg-[#081225] dark:text-[#edf4ff]">
            <section className="flex max-w-md flex-col items-center gap-3 py-10 text-center">
                <img src="/brand/dreamyo/mark.png" alt="dreamyo" className="size-12" />
                <h1 className="text-lg font-semibold sm:text-xl">页面加载失败</h1>
                <p className="text-sm leading-6 text-[#4e6496] dark:text-[#a9badb]">
                    {error?.message || "渲染时出现异常，请重试。"}
                    {error?.digest ? <span className="mt-1 block text-xs text-[#7184b0] dark:text-[#8297c3]">错误编号：{error.digest}</span> : null}
                </p>
                <div className="flex items-center gap-2">
                    <Button type="primary" size="small" className="!border-0 !bg-gradient-to-r !from-[#3978ff] !via-[#28cfe0] !to-[#9b79f7] !text-white" onClick={reset}>
                        重试
                    </Button>
                    <Button size="small" className="!border-[#b9caff] !bg-white/80 !text-[#244394] dark:!border-[#36558e] dark:!bg-[#102348] dark:!text-[#d9e5ff]" onClick={() => window.location.reload()}>
                        重新加载页面
                    </Button>
                </div>
            </section>
        </main>
    );
}
