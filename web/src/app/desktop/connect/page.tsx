import { notFound } from "next/navigation";

import { getDesktopEdition } from "@/lib/server/desktop-runtime";

import ConnectDesktop from "./connect-desktop";

export default function DesktopConnectPage() {
    if (getDesktopEdition() !== "commercial") notFound();
    return <ConnectDesktop />;
}
