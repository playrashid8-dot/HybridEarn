"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { adminFetch, ADMIN_API_BASE } from "../../lib/adminFetch";
import { fetchCurrentUser } from "../../lib/session";
import { showSafeToast } from "../../lib/toast";
import AdminSystemStatusCard from "./AdminSystemStatusCard";
import Loader from "./Loader";

export { adminFetch, ADMIN_API_BASE };
/** @deprecated Use ADMIN_API_BASE */
export const API_BASE = ADMIN_API_BASE;

const navItems = [
  { label: "Dashboard", href: "/admin/dashboard" },
  { label: "Users", href: "/admin/users" },
  { label: "Deposits", href: "/admin/deposits" },
  { label: "Withdrawals", href: "/admin/withdrawals" },
  { label: "Salary", href: "/admin/salary" },
  { label: "Fraud", href: "/admin/fraud" },
  { label: "Logs", href: "/admin/logs" },
  { label: "Analytics", href: "/admin/analytics" },
  { label: "Control", href: "/admin" },
  { label: "Ledger", href: "/admin/ledger" },
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
        if (!user?.isAdmin) {
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
      <header className="mb-6 flex flex-col gap-4 border-b border-white/10 pb-6 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-purple-300/90">NovaCentral Admin</p>
          <h1 className="mt-1 text-3xl font-bold tracking-tight text-white">{title}</h1>
          {subtitle ? <p className="mt-2 max-w-2xl text-sm leading-relaxed text-gray-400">{subtitle}</p> : null}
        </div>
        <Link
          href="/dashboard"
          className="w-fit rounded-xl border border-white/10 bg-white/[0.04] px-4 py-2 text-sm text-gray-200 transition hover:border-white/20 hover:bg-white/10"
        >
          ← Back to app
        </Link>
      </header>

      <nav className="mb-6 flex gap-2 overflow-x-auto pb-1">
        {navItems.map((item) => {
          const activeNav =
            pathname === item.href ||
            (item.href === "/admin" && (pathname === "/admin" || pathname === "/admin/"));

          return (
            <Link
              key={item.href}
              href={item.href}
              className={`whitespace-nowrap rounded-xl px-4 py-2 text-sm font-medium transition ${
                activeNav
                  ? "bg-purple-600 text-white shadow-md shadow-purple-900/40"
                  : "border border-white/10 bg-white/[0.04] text-gray-300 hover:border-white/15 hover:bg-white/[0.08]"
              }`}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>

      <AdminSystemStatusCard />

      {children}
    </AdminShell>
  );
}

function AdminShell({ children }) {
  return (
    <section className="relative left-1/2 min-h-screen w-screen -translate-x-1/2 bg-[#07070d] px-4 py-6 text-white sm:px-6 lg:px-8">
      <div className="pointer-events-none fixed inset-0 -z-10 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-purple-900/25 via-transparent to-transparent" aria-hidden />
      <div className="mx-auto max-w-7xl">{children}</div>
    </section>
  );
}
