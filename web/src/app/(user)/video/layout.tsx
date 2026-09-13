import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = { title: "视频生成 | dreamyo" };

export default function PageLayout({ children }: { children: ReactNode }) {
    return children;
}
