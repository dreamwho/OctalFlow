"use client";

import { ChevronRight, CircleHelp } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

import { SiteLogo } from "@/components/layout/site-logo";
import { navigationGroups, navigationTools, type NavigationToolSlug } from "@/constant/navigation-tools";
import { cn } from "@/lib/utils";
import { DEFAULT_SITE_TITLE, resolveSiteTitle } from "@/lib/site-brand";
import { usePublicSessionStore } from "@/stores/use-public-session-store";

export function AppSidebar({ activeToolSlug, expanded }: { activeToolSlug?: NavigationToolSlug; expanded: boolean }) {
    const pathname = usePathname();
    const router = useRouter();
    const site = usePublicSessionStore((state) => state.payload?.settings?.site) || { title: DEFAULT_SITE_TITLE, logoUrl: "/logo.svg" };
    const siteTitle = resolveSiteTitle(site.title);
    const helpActive = pathname.startsWith("/help");

    return (
        <aside className={cn("app-sidebar hidden h-full shrink-0 flex-col border-r text-[#111827] transition-[width] duration-200 lg:flex dark:text-[#f3f5f7]", expanded ? "w-[156px]" : "w-[60px]")}>
            <Link href="/create" className={cn("app-sidebar-brand cursor-pointer flex h-14 shrink-0 items-center px-2.5", expanded ? "justify-start px-4" : "justify-center")} aria-label={siteTitle}>
                <SiteLogo logoUrl={site.logoUrl} className="size-7" />
                {expanded ? <span className="ml-2.5 min-w-0 truncate text-sm font-semibold">{siteTitle}</span> : null}
            </Link>

            <nav className={cn("hide-scrollbar min-h-0 flex-1 overflow-y-auto py-4", expanded ? "px-2.5" : "px-2")} aria-label="工作空间导航">
                {navigationGroups.map((group, groupIndex) => {
                    const tools = navigationTools.filter((tool) => tool.group === group.id);
                    return (
                        <div key={group.id} className={cn(groupIndex > 0 && "mt-4")}>
                            {expanded ? <div className="mb-1 px-2 text-[10px] font-medium uppercase tracking-[0.08em] text-[#8d9aad] dark:text-[#68768b]">{group.label}</div> : null}
                            <div className="space-y-1">
                                {tools.map((tool) => {
                                    const Icon = tool.icon;
                                    const active = tool.slug === activeToolSlug;
                                    const primary = "primary" in tool && tool.primary;
                                    return (
                                        <Link
                                            key={tool.slug}
                                            href={`/${tool.slug}`}
                                            prefetch
                                            title={tool.label}
                                            onMouseEnter={() => router.prefetch(`/${tool.slug}`)}
                                            onFocus={() => router.prefetch(`/${tool.slug}`)}
                                            className={cn(
                                                "app-sidebar-item group relative flex h-9 cursor-pointer items-center rounded-lg border border-transparent px-2 text-[13px] font-medium transition duration-150",
                                                expanded ? "justify-start gap-2.5 px-2.5" : "justify-center",
                                                active
                                                    ? "is-active octaflow-selection-surface"
                                                    : primary
                                                      ? "text-[#243044] hover:border-cyan-300/20 hover:bg-cyan-50/50 dark:text-[#d4d9df] dark:hover:bg-cyan-300/[.05]"
                                                      : "text-[#526077] hover:border-cyan-300/20 hover:bg-cyan-50/50 hover:text-[#172033] dark:text-[#aeb9c8] dark:hover:bg-cyan-300/[.05] dark:hover:text-[#f3fbff]",
                                            )}
                                            aria-current={active ? "page" : undefined}
                                        >
                                            <Icon className={cn("size-[17px] shrink-0", active && "text-[var(--octa-selection-accent)]")} />
                                            {expanded ? <span className="min-w-0 truncate">{tool.label}</span> : null}
                                            {active ? <span className="app-sidebar-active-mark absolute right-1 h-4 w-px rounded-full" /> : null}
                                        </Link>
                                    );
                                })}
                            </div>
                        </div>
                    );
                })}
            </nav>

            <div className={cn("app-sidebar-footer shrink-0", expanded ? "px-2.5 pb-3 pt-2.5" : "p-2")}>
                <Link
                    href="/help"
                    prefetch
                    title="帮助"
                    onMouseEnter={() => router.prefetch("/help")}
                    onFocus={() => router.prefetch("/help")}
                    className={cn(
                        "app-sidebar-item relative flex min-h-9 cursor-pointer items-center rounded-lg border border-transparent px-2 text-[13px] font-medium text-[#526077] transition duration-150 hover:border-cyan-300/20 hover:bg-cyan-50/50 hover:text-[#172033] dark:text-[#aeb9c8] dark:hover:bg-cyan-300/[.05] dark:hover:text-[#f3fbff]",
                        expanded ? "justify-start gap-2.5 px-2.5" : "justify-center",
                        helpActive && "is-active octaflow-selection-surface",
                    )}
                    aria-current={helpActive ? "page" : undefined}
                >
                    <CircleHelp className="size-[17px] shrink-0" />
                    {expanded ? (
                        <>
                            <span className="min-w-0 flex-1">
                                <span className="block truncate">帮助</span>
                            </span>
                            <ChevronRight className="size-4 shrink-0 text-[#7f8995]" />
                        </>
                    ) : null}
                    {helpActive ? <span className="app-sidebar-active-mark absolute right-1 h-4 w-px rounded-full" /> : null}
                </Link>
            </div>
        </aside>
    );
}
