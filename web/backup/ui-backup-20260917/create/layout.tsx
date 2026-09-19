import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = { title: "创作工作台 | dreamyo" };

export default function PageLayout({ children }: { children: ReactNode }) {
    return children;
}
