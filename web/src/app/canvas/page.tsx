import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { AuthUserHydrator } from "@/components/auth/auth-user-hydrator";
import { AmbientBackground } from "@/components/ui/ambient-background";
import { getAuthenticatedPageAccess } from "@/lib/server/page-access";
import { getDesktopEdition } from "@/lib/server/desktop-runtime";
import { getPublicSiteSettings } from "@/lib/server/site-metadata";
import { HomeActionsProvider } from "@/app/home/home-actions";
import { HomeHeader } from "@/app/home/home-header";
import { HomeSideNav } from "@/app/home/home-side-nav";
import homeStyles from "@/app/home/home.module.css";

import { CanvasLibraryClient } from "./canvas-library-client";
import styles from "./canvas-library.module.css";

export const metadata: Metadata = {
    title: "我的项目 | dreamyo",
    robots: { index: false, follow: false, noarchive: true, noimageindex: true, nosnippet: true },
};

export const dynamic = "force-dynamic";

export default async function CanvasLibraryPage() {
    const [access, site] = await Promise.all([getAuthenticatedPageAccess(), getPublicSiteSettings()]);
    if (!access.user) redirect("/");
    const user = access.user;
    const adminLocal = getDesktopEdition() === "admin";

    return (
        <HomeActionsProvider initialSite={site}>
            <AuthUserHydrator
                user={{
                    id: user.id,
                    accountId: user.accountId,
                    username: user.username,
                    email: user.email,
                    displayName: user.displayName,
                    bio: user.bio,
                    avatarUrl: user.avatarUrl,
                    role: user.role,
                    adminPermissions: user.adminPermissions,
                    status: user.status,
                    planId: user.planId,
                    planName: user.planName,
                    hasActivePlan: user.hasActivePlan,
                    pointsBalance: user.pointsBalance,
                    permanentPointsBalance: user.permanentPointsBalance,
                    dailyPointsBalance: user.dailyPointsBalance,
                    dailyPointsExpiresAt: user.dailyPointsExpiresAt,
                    mfaEnabled: user.mfaEnabled,
                }}
            >
                {!adminLocal ? <AmbientBackground /> : null}
                <main className={`app-scroll-page ${adminLocal ? styles.desktopLibrary : homeStyles.root}`}>
                    {!adminLocal ? <><HomeHeader /><HomeSideNav /></> : null}
                    <CanvasLibraryClient adminLocal={adminLocal} />
                </main>
            </AuthUserHydrator>
        </HomeActionsProvider>
    );
}
