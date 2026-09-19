"use client";

import { usePathname } from "next/navigation";

import { resolveLoadingLabel } from "@/lib/loading-label";

export default function RootLoading() {
    const pathname = usePathname();
    const label = resolveLoadingLabel(pathname, "dreamyo");
    return (
        <main className="grid min-h-dvh place-items-center bg-[#080b14] px-6 text-[#f6f9ff]" role="status" aria-label={`正在加载${label}`}>
            <div
                aria-hidden="true"
                className="pointer-events-none fixed inset-0 bg-[radial-gradient(ellipse_80%_50%_at_50%_-10%,rgba(99,102,241,0.22)_0%,transparent_70%),radial-gradient(ellipse_60%_40%_at_85%_25%,rgba(192,132,252,0.16)_0%,transparent_60%),radial-gradient(ellipse_50%_40%_at_15%_75%,rgba(56,189,248,0.12)_0%,transparent_55%)]"
            />
            <section className="relative flex w-full max-w-sm flex-col items-center rounded-3xl border border-[#818cf8]/25 bg-[#0d111c]/90 p-8 text-center shadow-[0_24px_70px_rgba(0,0,0,0.55),0_0_40px_rgba(94,127,241,0.12)] backdrop-blur-xl">
                <img src="/brand/dreamyo/pure-mark.png" alt="dreamyo" className="size-14" />
                <div className="mt-4 h-1.5 w-40 overflow-hidden rounded-full bg-white/10">
                    <span className="block h-full w-1/2 animate-pulse rounded-full bg-gradient-to-r from-[#4e46e9] via-[#6e53f6] to-[#35cce1]" />
                </div>
                <p className="mt-4 text-sm text-[#9aa9c2]">正在加载 {label}…</p>
            </section>
        </main>
    );
}
