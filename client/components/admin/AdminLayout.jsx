"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { adminFetch, ADMIN_API_BASE } from "../../lib/adminFetch";
import { isAdmin as isAdminUser } from "../../lib/auth";
import { fetchCurrentUser } from "../../lib/session";
import { showSafeToast } from "../../lib/toast";
import AdminSystemStatusCard from "./AdminSystemStatusCard";
import Loader from "./Loader";

export { adminFetch, ADMIN_API_BASE };
/** @deprecated Use ADMIN_API_BASE */
export const API_BASE = ADMIN_API_BASE;

const navItems = [
  { label: "Dashboard", href: "/admin/dashboard" },
  { label: "Runtime", href: "/admin/runtime" },
  { label: "Queues", href: "/admin/queues" },
  { label: "Treasury", href: "/admin/treasury" },
  { label: "Recovery", href: "/admin/recovery" },
  { label: "Security", href: "/admin/security" },
  { label: "Users", href: "/admin/users" },
  { label: "Deposits", href: "/admin/deposits" },
  { label: "Withdrawals", href: "/admin/withdrawals" },
  { label: "ROI", href: "/admin/roi" },
  { label: "Staking", href: "/admin/staking" },
  { label: "Referrals", href: "/admin/referrals" },
  { label: "Salary", href: "/admin/salary" },
  { label: "Fraud", href: "/admin/fraud" },
  { label: "Logs", href: "/admin/logs" },
  { label: "Audit", href: "/admin/audit" },
  { label: "Analytics", href: "/admin/analytics" },
  { label: "Control", href: "/admin" },
  { label: "Ledger", href: "/admin/ledger" },
  { label: "Settings", href: "/admin/settings" },
];

export function formatCurrency(value) {
  const amount = Number(value || 0);
  return `$${amount.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function formatDate(value) {
  if (!value) return "-";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";

  return date.toLocaleString();
}

export function getUserLabel(user) {
  if (!user) return "Unknown";
  return user.username || user.email || user._id || "Unknown";
}

export default function AdminLayout({ title, subtitle, children }) {
  const pathname = usePathname();
  const [checking, setChecking] = useState(true);
  const [accessDenied, setAccessDenied] = useState("");

  useEffect(() => {
    let active = true;

    const verifyAdmin = async () => {
      try {
        const user = await fetchCurrentUser();
        if (!isAdminUser(user)) {
          if (active) {
            setAccessDenied("Access denied");
          }
          return;
        }
        await adminFetch("/admin/stats");
        if (active) setAccessDenied("");
      } catch (error) {
        if (active) {
          const msg = error?.message || "Access Denied";
          setAccessDenied(msg);
          showSafeToast(msg);
        }
      } finally {
        if (active) setChecking(false);
      }
    };

    verifyAdmin();

    return () => {
      active = false;
    };
  }, []);

  if (checking) {
    return (
      <AdminShell>
        <Loader label="Checking admin access..." />
      </AdminShell>
    );
  }

  if (accessDenied) {
    return (
      <AdminShell>
        <div className="mx-auto mt-20 max-w-md rounded-2xl border border-red-500/20 bg-red-500/10 p-6 text-center">
          <h1 className="text-2xl font-bold text-white">Access Denied</h1>
          <p className="mt-3 text-sm text-red-100">{accessDenied}</p>
          <Link
            href="/dashboard"
            className="mt-5 inline-flex rounded-xl bg-white/10 px-4 py-2 text-sm text-white hover:bg-white/15"
          >
            Back to dashboard
          </Link>
        </div>
      </AdminShell>
    );
  }

  return (
    <AdminShell>
      <header className="mb-4 flex flex-col gap-3 border-b border-white/10 pb-4 md:flex-row md:items-end md:justify-between">
        <div className="min-w-0">
          <p className="text-[10px] font-bold uppercase tracking-[0.28em] text-cyan-300/90">HybridEarn VIP Operations</p>
          <h1 className="mt-1 truncate text-2xl font-bold tracking-tight text-white sm:text-3xl">{title}</h1>
          {subtitle ? <p className="mt-1 max-w-3xl text-xs leading-relaxed text-gray-400 sm:text-sm">{subtitle}</p> : null}
        </div>
        <Link
          href="/dashboard"
          className="w-fit rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-xs font-medium text-gray-200 transition hover:border-white/20 hover:bg-white/10"
        >
          ← Back to app
        </Link>
      </header>

      <div className="sticky top-0 z-30 -mx-4 mb-4 border-y border-white/10 bg-[#07070d]/92 px-4 py-2 backdrop-blur-xl sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
        <nav className="admin-snap-nav scrollbar-none flex gap-2 overflow-x-auto scroll-smooth pb-0.5" aria-label="Admin operations navigation">
          {navItems.map((item) => {
            const activeNav =
              pathname === item.href ||
              (item.href === "/admin" && (pathname === "/admin" || pathname === "/admin/"));

            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={activeNav ? "page" : undefined}
                className={`shrink-0 whitespace-nowrap rounded-full px-3.5 py-2 text-xs font-semibold transition sm:px-4 ${
                  activeNav
                    ? "border border-cyan-300/45 bg-cyan-400/15 text-white shadow-[0_0_22px_rgba(34,211,238,0.22)]"
                    : "border border-white/10 bg-white/[0.04] text-gray-300 hover:border-white/20 hover:bg-white/[0.08]"
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
      </div>

      <AdminSystemStatusCard />

      {children}
    </AdminShell>
  );
}

function AdminShell({ children }) {
  return (
    <section className="relative left-1/2 min-h-screen w-screen -translate-x-1/2 overflow-x-hidden bg-[#06070d] px-4 py-4 text-white sm:px-6 lg:px-8">
      <div className="pointer-events-none fixed inset-0 -z-10 bg-[radial-gradient(ellipse_at_top_left,_rgba(34,211,238,0.18),transparent_42%),radial-gradient(ellipse_at_top_right,_rgba(124,58,237,0.2),transparent_38%),linear-gradient(180deg,#06070d,#080b13)]" aria-hidden />
      <div className="pointer-events-none fixed inset-0 -z-10 bg-[linear-gradient(rgba(255,255,255,0.035)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.035)_1px,transparent_1px)] bg-[size:42px_42px] opacity-30" aria-hidden />
      <div className="mx-auto max-w-[92rem]">{children}</div>
    </section>
  );
}
