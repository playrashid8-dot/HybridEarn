"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "framer-motion";

const links = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/team", label: "Team" },
  { href: "/deposit", label: "Deposit" },
  { href: "/withdraw", label: "Withdraw" },
  { href: "/investment", label: "Invest" },
  { href: "/vip", label: "VIP" },
  { href: "/referral", label: "Referral" },
  { href: "/history", label: "History" },
  { href: "/profile", label: "Profile" },
];

export default function AppSidebar() {
  const path = usePathname();

  return (
    <aside className="hidden lg:flex lg:flex-col lg:w-56 lg:shrink-0 lg:border-r lg:border-white/[0.08] lg:bg-[#111827]/90 lg:backdrop-blur-xl">
      <nav className="sticky top-14 flex max-h-[calc(100vh-3.5rem)] flex-col gap-1 overflow-y-auto p-4 pt-6">
        <p className="mb-3 px-3 text-[10px] font-semibold uppercase tracking-[0.2em] text-gray-500">
          Menu
        </p>
        {links.map((item) => {
          const active = path === item.href || (item.href === "/withdraw" && path === "/withdrawal");
          return (
            <Link key={item.href} href={item.href}>
              <motion.span
                layout
                className={`flex rounded-xl px-3 py-2.5 text-sm font-medium transition ${
                  active
                    ? "bg-emerald-500/15 text-white shadow-[inset_0_0_0_1px_rgba(16,185,129,0.35)]"
                    : "text-gray-400 hover:bg-white/[0.04] hover:text-white"
                }`}
                whileHover={{ x: 2 }}
                transition={{ type: "spring", stiffness: 400, damping: 28 }}
              >
                {item.label}
              </motion.span>
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
