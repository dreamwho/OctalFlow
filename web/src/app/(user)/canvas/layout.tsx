import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = { title: "Canvas 项目 | dreamyo" };

export default function PageLayout({ children }: { children: ReactNode }) {
    return children;
}
