import "../styles/globals.css";
import type { ReactNode } from "react";
import type { Metadata } from "next";
import { Inter } from "next/font/google";
import VipToastHost from "../components/ui/VipToast";

const inter = Inter({
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "HybridEarn",
  description: "HybridEarn premium crypto earning platform with ROI, referrals, VIP rewards, and staking.",
  icons: {
    icon: "/logo.png",
  },
};

export default function RootLayout({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <html lang="en" data-scroll-behavior="smooth">
      <body className={`${inter.className} bg-[#0B0F19] text-white antialiased`}>
        <VipToastHost />
        {children}
      </body>
    </html>
  );
}