import type { Metadata } from "next";
import { Home } from "lucide-react";
import Link from "next/link";

export const metadata: Metadata = { title: "页面不存在 | dreamyo" };

export default function NotFound() {
    return (
        <div className="flex h-dvh flex-col overflow-hidden bg-background text-foreground">
            <main className="flex h-full min-h-0 items-center justify-center overflow-y-auto bg-[#f1f5ff] bg-[radial-gradient(#cddcff_1px,transparent_1px)] px-6 py-10 text-[#12245f] [background-size:16px_16px] dark:bg-[#081225] dark:bg-[radial-gradient(rgba(108,160,255,.24)_1px,transparent_1px)] dark:text-[#edf4ff]">
                <section className="w-full max-w-md rounded-3xl border border-[#b9caff] bg-white/85 p-8 text-center shadow-[0_24px_70px_rgba(70,102,220,.16)] backdrop-blur-xl dark:border-[#294679] dark:bg-[#0d1b38]/90">
                    <img src="/icon.svg" alt="dreamyo" className="mx-auto mb-5 size-12" />
                    <div className="mx-auto mb-5 flex size-16 items-center justify-center rounded-2xl border border-[#b9caff] bg-gradient-to-br from-[#3978ff]/15 via-[#28cfe0]/15 to-[#9b79f7]/20 text-2xl font-semibold text-[#294da5] dark:border-[#36558e] dark:text-[#d9e5ff]">
                        404
                    </div>
                    <h1 className="text-3xl font-semibold tracking-normal">页面不存在</h1>
                    <p className="mt-3 text-sm leading-6 text-[#4e6496] dark:text-[#a9badb]">这个地址没有对应的页面，可能已经移动或被合并到其他入口。</p>
                    <div className="mt-8 flex flex-wrap justify-center gap-3">
                        <Link
                            href="/"
                            className="inline-flex h-10 items-center gap-2 rounded-lg bg-gradient-to-r from-[#3978ff] via-[#28cfe0] to-[#9b79f7] px-4 text-sm font-semibold text-white shadow-[0_8px_20px_rgba(57,120,255,.22)] transition hover:brightness-105"
                        >
                            <Home className="size-4" />
                            返回首页
                        </Link>
                    </div>
                </section>
            </main>
        </div>
    );
}
