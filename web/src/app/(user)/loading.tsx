"use client";

import { usePathname } from "next/navigation";

import { resolveLoadingLabel } from "@/lib/loading-label";

export default function UserLoading() {
    const pathname = usePathname();
    const label = resolveLoadingLabel(pathname, "工作区");
    return (
        <main className="grid h-full min-h-0 place-items-center bg-[#080b14] px-6 text-[#f6f9ff]" role="status" aria-label={`正在加载${label}`}>
            <section className="relative flex w-full max-w-sm flex-col items-center rounded-3xl border border-[#818cf8]/25 bg-[#0d111c]/90 p-8 text-center shadow-[0_24px_70px_rgba(0,0,0,0.55),0_0_40px_rgba(94,127,241,0.12)] backdrop-blur-xl">
                <img src="/brand/dreamyo/pure-mark.png" alt="dreamyo" className="size-12" />
                <div className="mt-4 h-1.5 w-40 overflow-hidden rounded-full bg-white/10">
                    <span className="block h-full w-1/2 animate-pulse rounded-full bg-gradient-to-r from-[#4e46e9] via-[#6e53f6] to-[#35cce1]" />
                </div>
                <p className="mt-4 text-sm text-[#9aa9c2]">正在加载 {label}…</p>
            </section>
        </main>
    );
}
