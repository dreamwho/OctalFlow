import type { Metadata } from "next";

export const metadata: Metadata = { title: "创作工作台 | dreamyo", robots: { index: false, follow: false, noarchive: true } };

export default function CreateLayout({ children }: { children: React.ReactNode }) {
    return children;
}
