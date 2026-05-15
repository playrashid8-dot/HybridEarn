"use client";

import { useRouter, usePathname } from "next/navigation";
import { motion } from "framer-motion";

export default function BottomNav() {
  const router = useRouter();
  const path = usePathname();

  const nav = [
    { name: "Home", path: "/dashboard", icon: "🏠" },
    { name: "Deposit", path: "/deposit", icon: "↓" },
    { name: "Withdraw", path: "/withdraw", icon: "↑" },
    { name: "History", path: "/history", icon: "📜" },
    { name: "Team", path: "/team", icon: "👥" },
    { name: "Profile", path: "/profile", icon: "👤" },
  ];

  return (
    <div className="fixed bottom-0 left-0 right-0 z-50 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2">
      <nav
        aria-label="Primary navigation"
        className="mx-auto max-w-lg rounded-2xl border border-white/[0.08] bg-[#111827]/95 backdrop-blur-xl shadow-[0_-8px_40px_rgba(0,0,0,0.45)]"
      >
        <div className="flex justify-around gap-0 py-2 sm:gap-0.5">
          {nav.map((item) => {
            const active = path === item.path;

            return (
              <button
                key={item.path}
                type="button"
                onClick={() => router.push(item.path)}
                className="relative flex min-h-[48px] min-w-0 flex-1 flex-col items-center justify-center px-0.5 py-1 text-[8px] font-semibold sm:min-h-[52px] sm:text-[9px]"
              >
                {active && (
                  <motion.div
                    layoutId="bottom-nav-pill"
                    className="absolute inset-x-1 inset-y-0 rounded-xl bg-emerald-500/25 ring-1 ring-emerald-500/40"
                    transition={{ type: "spring", stiffness: 380, damping: 32 }}
                  />
                )}
                <motion.span
                  animate={{ scale: active ? 1.06 : 1 }}
                  className={`relative z-10 flex h-7 w-full items-center justify-center text-[15px] leading-none sm:h-8 sm:text-[16px] ${
                    active ? "opacity-100" : "opacity-72"
                  }`}
                >
                  {item.icon}
                </motion.span>
                <span
                  className={`relative z-10 mt-0.5 truncate ${active ? "font-bold text-emerald-100" : "font-medium text-gray-500"}`}
                >
                  {item.name}
                </span>
              </button>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
