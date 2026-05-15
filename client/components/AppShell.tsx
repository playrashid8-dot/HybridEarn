"use client";

import type { ReactNode } from "react";
import AppNavbar from "./AppNavbar";
import AppSidebar from "./AppSidebar";
import BottomNav from "./BottomNav";

export default function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-[#0B0F19] text-white antialiased">
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute left-[-120px] top-[-120px] h-[420px] w-[420px] rounded-full bg-[#6366F1]/18 blur-[120px]" />
        <div className="absolute bottom-[-140px] right-[-100px] h-[400px] w-[400px] rounded-full bg-emerald-500/10 blur-[110px]" />
        <div className="absolute inset-0 bg-[radial-gradient(rgba(255,255,255,0.045)_1px,transparent_1px)] [background-size:24px_24px]" />
      </div>

      <AppNavbar />

      <div className="relative z-10 flex min-h-[calc(100vh-3.5rem)] w-full max-w-[100vw] overflow-x-hidden">
        <AppSidebar />
        <main className="mx-auto w-full min-w-0 flex-1 px-4 pb-24 pt-6 sm:px-6 lg:max-w-4xl xl:max-w-5xl">
          {children}
        </main>
      </div>

      <div className="lg:hidden">
        <BottomNav />
      </div>
    </div>
  );
}
