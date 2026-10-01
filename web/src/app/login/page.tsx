import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { getCurrentUser } from "@/lib/auth/session";
import { getInstallStatus } from "@/lib/server/install-status";
import { readHomeLogin } from "@/app/home/home-login";

export const metadata: Metadata = { title: "登录 | dreamyo" };

type LoginPageProps = {
    searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function LoginPage({ searchParams }: LoginPageProps) {
    const params = searchParams ? await searchParams : {};
    const { nextPath, authError } = readHomeLogin(params);
    const install = await getInstallStatus();
    if (!install.ready) redirect("/install");

    const user = await getCurrentUser();
    if (user) redirect(nextPath);

    const query = new URLSearchParams({ login: "1", next: nextPath });
    if (authError) query.set("error", authError);
    redirect(`/?${query}`);
}
