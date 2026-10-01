import { redirect } from "next/navigation";

import { getInstallStatus } from "@/lib/server/install-status";
import { getPublicSiteSettings } from "@/lib/server/site-metadata";
import { getCurrentUser } from "@/lib/auth/session";
import { readHomeLogin } from "./home/home-login";
import { AmbientBackground } from "@/components/ui/ambient-background";
import { HomeActionsProvider } from "./home/home-actions";
import { HomeAgentHero } from "./home/home-agent-hero";
import { HomeResolutionScale } from "./home/home-resolution-scale";
import { HomeFooter } from "./home/home-footer";
import { HomeGallery } from "./home/home-gallery";
import { HomeHeader } from "./home/home-header";
import { HomeSideNav } from "./home/home-side-nav";
import styles from "./home/home.module.css";

export const dynamic = "force-dynamic";

export default async function HomePage({ searchParams }: { searchParams?: Promise<Record<string, string | string[] | undefined>> } = {}) {
    const [install, site] = await Promise.all([getInstallStatus(), getPublicSiteSettings()]);
    if (!install.ready) redirect("/install");
    const params = searchParams ? await searchParams : {};
    const wantsLogin = params.login === "1";
    const login = readHomeLogin(params);
    if (wantsLogin && await getCurrentUser()) redirect(login.nextPath);

    return (
        <HomeActionsProvider initialSite={site} initialLogin={wantsLogin ? login : undefined}>
            <HomeResolutionScale />
            <AmbientBackground />
            <main className={`app-scroll-page ${styles.root}`}>
                <HomeHeader />
                <HomeSideNav />
                <HomeAgentHero />
                <HomeGallery />
                <HomeFooter />
            </main>
        </HomeActionsProvider>
    );
}
