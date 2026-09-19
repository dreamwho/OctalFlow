import { redirect } from "next/navigation";

import { getInstallStatus } from "@/lib/server/install-status";
import { getPublicSiteSettings } from "@/lib/server/site-metadata";
import { AmbientBackground } from "@/components/ui/ambient-background";
import { HomeActionsProvider } from "./home/home-actions";
import { HomeAgentHero } from "./home/home-agent-hero";
import { HomeFooter } from "./home/home-footer";
import { HomeGallery } from "./home/home-gallery";
import { HomeHeader } from "./home/home-header";
import { HomeSideNav } from "./home/home-side-nav";
import styles from "./home/home.module.css";

export const dynamic = "force-dynamic";

export default async function HomePage() {
    const [install, site] = await Promise.all([getInstallStatus(), getPublicSiteSettings()]);
    if (!install.ready) redirect("/install");

    return (
        <HomeActionsProvider initialSite={site}>
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
