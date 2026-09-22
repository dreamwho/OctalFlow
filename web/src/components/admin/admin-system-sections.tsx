"use client";

import { AdminDataBackup } from "@/components/admin/admin-data-backup";
import { AdminExternalStorage } from "@/components/admin/admin-external-storage";
import { AdminLocalMediaStorage } from "@/components/admin/admin-local-media-storage";
import { UpdateCenterPanel } from "@/components/admin/admin-update-center";

import type { AdminDashboardController } from "./use-admin-dashboard-controller";

export function AdminMediaStorageSection({ controller }: { controller: AdminDashboardController }) {
    const { activeSection } = controller;
    if (activeSection !== "mediaStorage") return null;
    return <AdminLocalMediaStorage />;
}

export function AdminExternalStorageSection({ controller }: { controller: AdminDashboardController }) {
    if (controller.activeSection !== "externalStorage") return null;
    return <AdminExternalStorage />;
}

export function AdminBackupSection({ controller, desktopEdition }: { controller: AdminDashboardController; desktopEdition?: "commercial" | "admin" | null }) {
    if (controller.activeSection !== "backup") return null;
    return <AdminDataBackup desktopEdition={desktopEdition} />;
}

export function AdminUpdatesSection({ controller }: { controller: AdminDashboardController }) {
    const { activeSection } = controller;
    if (activeSection !== "updates") return null;
    return <UpdateCenterPanel />;
}
