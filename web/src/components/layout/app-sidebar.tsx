"use client";

import { BookMarked, ChevronRight, CircleHelp, Folder, GalleryVerticalEnd, Images, Maximize2, PencilLine, Plus, Settings, Sparkles, Video } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

import { SiteLogo } from "@/components/layout/site-logo";
import { SiteWordmark } from "@/components/layout/site-wordmark";
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
    const isCreateRoute = pathname === "/create";

    return (
        <aside className={cn("app-sidebar hidden h-full shrink-0 flex-col border-r text-[#111827] transition-[width] duration-200 lg:flex dark:text-[#f3f5f7]", expanded ? "w-[156px]" : "w-[60px]")}>
            <Link href="/" className={cn("app-sidebar-brand cursor-pointer flex h-14 shrink-0 items-center px-2.5", expanded ? "justify-start px-4" : "justify-center")} aria-label={siteTitle}>
                <SiteLogo logoUrl={site.logoUrl} className="size-7" />
                {expanded ? <SiteWordmark className="ml-2.5 h-[14px] min-w-0 max-w-full" title={siteTitle} /> : null}
            </Link>

            <nav className={cn("hide-scrollbar min-h-0 flex-1 overflow-y-auto py-4", expanded ? "px-2.5" : "px-2")} aria-label="工作空间导航">
                {isCreateRoute ? <CreateSidebarNavigation activeToolSlug={activeToolSlug} expanded={expanded} router={router} /> : <DefaultSidebarNavigation activeToolSlug={activeToolSlug} expanded={expanded} router={router} />}
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
                        helpActive && "is-active dreamyo-selection-surface",
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

function DefaultSidebarNavigation({ activeToolSlug, expanded, router }: { activeToolSlug?: NavigationToolSlug; expanded: boolean; router: ReturnType<typeof useRouter> }) {
    return (
        <>
            {navigationGroups.map((group, groupIndex) => {
                const tools = navigationTools.filter((tool) => tool.group === group.id);
                return (
                    <div key={group.id} className={cn(groupIndex > 0 && "mt-4")}>
                        {expanded ? <div className="mb-1 px-2 text-[10px] font-medium uppercase tracking-[0.08em] text-[#8d9aad] dark:text-[#68768b]">{group.label}</div> : null}
                        <div className="space-y-1">
                            {tools.map((tool) => (
                                <SidebarNavigationLink key={tool.slug} tool={tool} activeToolSlug={activeToolSlug} expanded={expanded} router={router} />
                            ))}
                        </div>
                    </div>
                );
            })}
        </>
    );
}

function CreateSidebarNavigation({ activeToolSlug, expanded, router }: { activeToolSlug?: NavigationToolSlug; expanded: boolean; router: ReturnType<typeof useRouter> }) {
    const groups = [
        { label: "创作", tools: [{ slug: "create", label: "创作", icon: PencilLine, primary: true }] },
        {
            label: "项目",
            tools: [
                { slug: "canvas", label: "画布", icon: Maximize2 },
                { slug: "video", label: "视频", icon: Video },
            ],
        },
        {
            label: "资产",
            tools: [
                { slug: "assets", label: "素材", icon: Images },
                { slug: "works", label: "作品", icon: GalleryVerticalEnd },
                { slug: "my-prompts", label: "提示词", icon: BookMarked },
                { slug: "profile", label: "设置", icon: Settings },
            ],
        },
    ] as const;
    return (
        <>
            {groups.map((group, groupIndex) => (
                <div key={group.label} className={cn(groupIndex > 0 && "mt-4")}>
                    {expanded ? <div className="mb-1 px-2 text-[10px] font-medium uppercase tracking-[0.08em] text-[#8d9aad] dark:text-[#68768b]">{group.label}</div> : null}
                    <div className="space-y-1">
                        {group.tools.map((tool) => (
                            <SidebarNavigationLink key={tool.slug} tool={tool} activeToolSlug={activeToolSlug} expanded={expanded} router={router} />
                        ))}
                    </div>
                </div>
            ))}
            {expanded ? (
                <div className="create-sidebar-workspace mt-5 border-t border-[#e7edf5] pt-4 dark:border-[#29323e]">
                    <div className="mb-2 px-2 text-[10px] font-medium uppercase tracking-[0.08em] text-[#8d9aad] dark:text-[#68768b]">我的空间</div>
                    <div className="space-y-1">
                        {["默认项目", "品牌设计", "短视频创作", "个人灵感"].map((label) => (
                            <Link
                                key={label}
                                href="/works"
                                className="create-sidebar-folder flex h-8 items-center gap-2 rounded-lg px-2.5 text-[12px] text-[#526077] transition hover:bg-cyan-50/50 hover:text-[#172033] dark:text-[#aeb9c8] dark:hover:bg-cyan-300/[.05] dark:hover:text-[#f3fbff]"
                            >
                                <Folder className="size-4 shrink-0" />
                                {label}
                            </Link>
                        ))}
                        <Link href="/works" className="create-sidebar-folder flex h-8 items-center gap-2 rounded-lg px-2.5 text-[12px] font-medium text-[#3478e5] transition hover:bg-cyan-50/50 dark:text-cyan-300 dark:hover:bg-cyan-300/[.05]">
                            <Plus className="size-4 shrink-0" />
                            新建文件夹
                        </Link>
                    </div>
                </div>
            ) : null}
        </>
    );
}

function SidebarNavigationLink({ tool, activeToolSlug, expanded, router }: { tool: { slug: string; label: string; icon: typeof Sparkles; primary?: boolean }; activeToolSlug?: NavigationToolSlug; expanded: boolean; router: ReturnType<typeof useRouter> }) {
    const Icon = tool.icon;
    const active = tool.slug === activeToolSlug;
    const primary = Boolean(tool.primary);
    const destination = tool.slug === "create" ? "/" : `/${tool.slug}`;
    return (
        <Link
            href={destination}
            prefetch
            title={tool.label}
            onMouseEnter={() => router.prefetch(destination)}
            onFocus={() => router.prefetch(destination)}
            className={cn(
                "app-sidebar-item group relative flex h-9 cursor-pointer items-center rounded-lg border border-transparent px-2 text-[13px] font-medium transition duration-150",
                expanded ? "justify-start gap-2.5 px-2.5" : "justify-center",
                active
                    ? "is-active dreamyo-selection-surface"
                    : primary
                      ? "text-[#243044] hover:border-cyan-300/20 hover:bg-cyan-50/50 dark:text-[#d4d9df] dark:hover:bg-cyan-300/[.05]"
                      : "text-[#526077] hover:border-cyan-300/20 hover:bg-cyan-50/50 hover:text-[#172033] dark:text-[#aeb9c8] dark:hover:bg-cyan-300/[.05] dark:hover:text-[#f3fbff]",
            )}
            aria-current={active ? "page" : undefined}
        >
            <Icon className={cn("size-[17px] shrink-0", active && "text-[var(--dreamyo-selection-accent)]")} />
            {expanded ? <span className="min-w-0 truncate">{tool.label}</span> : null}
            {active ? <span className="app-sidebar-active-mark absolute right-1 h-4 w-px rounded-full" /> : null}
        </Link>
    );
}
