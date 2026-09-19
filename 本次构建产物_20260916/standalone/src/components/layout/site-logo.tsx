"use client";

import { useState } from "react";

import { cn } from "@/lib/utils";

const DEFAULT_LIGHT_LOGO = "/brand/dreamyo/mark.png";
const DEFAULT_DARK_LOGO = "/brand/dreamyo/mark.png";

export function SiteLogo({ logoUrl, darkLogoUrl, className }: { logoUrl: string; darkLogoUrl?: string; className?: string }) {
    const configuredLogoUrl = logoUrl.trim() && logoUrl !== "/logo.svg" ? logoUrl.trim() : "";
    const lightLogoUrl = configuredLogoUrl || DEFAULT_LIGHT_LOGO;
    const darkLogoUrlResolved = configuredLogoUrl ? configuredLogoUrl : darkLogoUrl?.trim() || DEFAULT_DARK_LOGO;
    const [failedLightLogoUrl, setFailedLightLogoUrl] = useState("");
    const [failedDarkLogoUrl, setFailedDarkLogoUrl] = useState("");
    const lightSource = failedLightLogoUrl === lightLogoUrl ? DEFAULT_LIGHT_LOGO : lightLogoUrl;
    const darkSource = failedDarkLogoUrl === darkLogoUrlResolved ? DEFAULT_DARK_LOGO : darkLogoUrlResolved;
    const imageClass = "size-full shrink-0 object-contain";

    return (
        <span className={cn("inline-flex shrink-0 items-center justify-center bg-transparent", className)} style={{ backgroundColor: "transparent" }} aria-hidden="true">
            <img src={lightSource} alt="" className={cn(imageClass, "dark:hidden")} referrerPolicy="no-referrer" onError={() => setFailedLightLogoUrl(lightLogoUrl)} />
            <img src={darkSource} alt="" className={cn(imageClass, "hidden dark:block")} referrerPolicy="no-referrer" onError={() => setFailedDarkLogoUrl(darkLogoUrlResolved)} />
        </span>
    );
}
