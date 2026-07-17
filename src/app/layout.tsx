import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "NOMI Everywhere · 出行代理 Demo",
  description: "自然语言驱动的跨端出行规划与主动服务演示",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
