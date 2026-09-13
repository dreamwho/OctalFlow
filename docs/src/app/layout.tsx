import { Provider } from "@/components/provider";
import type { Metadata } from "next";
import "./global.css";

export const metadata: Metadata = {
  title: {
    default: "dreamyo 文档",
    template: "%s | dreamyo 文档",
  },
  description:
    "dreamyo - AI 创意工作台官方文档，提供图片、视频、音频、短剧等多种 AI 生成能力的完整指南。",
  keywords: [
    "dreamyo",
    "AI创意",
    "图片生成",
    "视频生成",
    "短剧制作",
    "AI工作台",
    "文档",
  ],
  authors: [{ name: "dreamyo Team" }],
  creator: "dreamyo Team",
  publisher: "dreamyo",
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_SITE_URL || "https://docs.dreamyo.pro",
  ),
  alternates: {
    canonical: "/",
  },
  icons: {
    icon: "/brand/dreamyo/mark.png",
    shortcut: "/brand/dreamyo/mark.png",
    apple: "/brand/dreamyo/mark.png",
  },
  openGraph: {
    type: "website",
    locale: "zh_CN",
    url: "/",
    title: "dreamyo 文档",
    description: "dreamyo - AI 创意工作台官方文档",
    siteName: "dreamyo 文档",
    images: ["/brand/dreamyo/mark.png"],
  },
  twitter: {
    card: "summary_large_image",
    title: "dreamyo 文档",
    description: "dreamyo - AI 创意工作台官方文档",
    images: ["/brand/dreamyo/mark.png"],
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-video-preview": -1,
      "max-image-preview": "large",
      "max-snippet": -1,
    },
  },
};

export default function Layout({ children }: LayoutProps<"/">) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body className="flex flex-col min-h-screen">
        <Provider>{children}</Provider>
      </body>
    </html>
  );
}
