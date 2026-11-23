import type { Metadata, Viewport } from "next";
import { Geist } from "next/font/google";
import { BRAND } from "@/lib/brand";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });

export const metadata: Metadata = {
  title: `${BRAND.name} — ${BRAND.tagline.toLowerCase()}`,
  description: BRAND.description,
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: BRAND.color };

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="pt-BR" className={`${geistSans.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col font-sans">{children}</body>
    </html>
  );
}
