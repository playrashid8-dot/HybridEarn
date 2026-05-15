"use client";

import { logout } from "../../../lib/auth";
import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import Image from "next/image";
import ProtectedRoute from "../../../components/ProtectedRoute";
import { fetchCurrentUser, updateUserPassword } from "../../../lib/session";
import { fetchHybridSummary } from "../../../lib/hybrid";
import GlassCard from "../../../components/GlassCard";
import PageWrapper from "../../../components/PageWrapper";
import { copyToClipboard, maskAddress } from "../../../lib/helpers";
import { showToast, getMessage } from "../../../lib/vipToast";
import VipBadge from "../../../components/ui/VipBadge";

export default function Profile() {
  const [user, setUser]: any = useState(null);
  const [hybrid, setHybrid]: any = useState(null);
  const [loading, setLoading] = useState(true);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [pwdBusy, setPwdBusy] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);

  useEffect(() => {
    Promise.all([fetchCurrentUser(), fetchHybridSummary().catch(() => null)])
      .then(([fresh, hybridData]) => {
        if (fresh) setUser(fresh);
        if (hybridData) setHybrid(hybridData);
      })
      .finally(() => setLoading(false));
  }, []);

  const walletDisplayRaw = hybrid?.walletAddress || user?.walletAddress || "";
  const walletMasked = walletDisplayRaw ? maskAddress(walletDisplayRaw) : "—";
  const vipLevel = Number(hybrid?.level ?? user?.level ?? 0);

  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const referralLink =
    user?.referralCode && origin
      ? `${origin}/signup?ref=${encodeURIComponent(user.referralCode)}`
      : "";

  const submitPassword = async () => {
    if (pwdBusy) return;
    const cur = currentPassword.trim();
    const neu = newPassword.trim();
    if (!cur || !neu) {
      showToast("error", "Enter current and new password");
      return;
    }
    if (neu.length < 8) {
      showToast("error", "New password must be at least 8 characters");
      return;
    }
    try {
      setPwdBusy(true);
      const res = await updateUserPassword(cur, neu);
      if (!res.success) {
        showToast("error", getMessage(res.msg, "Could not update password"));
        return;
      }
      showToast("success", getMessage(res.msg, "Password updated"));
      setCurrentPassword("");
      setNewPassword("");
    } catch (e: any) {
      showToast("error", getMessage(e, "Password update failed"));
    } finally {
      setPwdBusy(false);
    }
  };

  const copyRef = async () => {
    if (!referralLink) return;
    const ok = await copyToClipboard(referralLink);
    showToast(ok ? "success" : "error", ok ? "Referral link copied" : "Could not copy");
    if (ok) {
      setCopiedLink(true);
      setTimeout(() => setCopiedLink(false), 2000);
    }
  };

  return (
    <ProtectedRoute>
      <PageWrapper loading={loading} data={user?._id}>
        <div className="relative mx-auto min-h-screen w-full max-w-[420px] overflow-x-hidden px-4 pb-24 pt-6 text-white">
          <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}>
            <p className="text-[10px] uppercase tracking-[0.28em] text-emerald-400/75">HybridEarn</p>
            <h1 className="mt-1 text-2xl font-black tracking-tight text-white">Profile</h1>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.05 }}
            className="relative mt-8 rounded-3xl border border-white/[0.1] bg-white/[0.05] p-6 text-center shadow-[0_12px_48px_rgba(0,0,0,0.35)] backdrop-blur-xl ring-1 ring-white/[0.06]"
          >
            <div className="flex justify-center">
              <div className="rounded-full bg-gradient-to-br from-emerald-400/80 to-cyan-500/80 p-[3px] shadow-[0_0_32px_rgba(16,185,129,0.35)]">
                <Image src="/logo.png" alt="" width={88} height={88} className="rounded-full bg-black" />
              </div>
            </div>
            <h2 className="mt-4 text-xl font-bold">{user?.username || "—"}</h2>
            <div className="mt-3 flex justify-center">
              <VipBadge level={vipLevel} showGlow={vipLevel > 0} />
            </div>
            <div className="mt-5 rounded-2xl border border-white/[0.08] bg-black/30 px-4 py-3 text-left">
              <p className="text-[9px] font-semibold uppercase tracking-[0.2em] text-gray-500">Referral ID</p>
              <p className="mt-1 font-mono text-sm font-bold tracking-wide text-emerald-100/95">
                {user?.referralCode || "—"}
              </p>
            </div>
          </motion.div>

          <GlassCard glow="cyan" className="mt-6">
            <h3 className="mb-4 text-sm font-semibold text-gray-200">Account</h3>
            <div className="space-y-3 text-sm">
              <Info label="Email" value={user?.email || "—"} />
              <Info label="Wallet" value={walletMasked} mono />
            </div>
          </GlassCard>

          <GlassCard glow="purple" className="mt-5">
            <h3 className="mb-2 text-sm font-semibold text-gray-200">My referral link</h3>
            <p className="mb-3 text-[11px] text-gray-500">Share this URL to invite your network.</p>
            <p className="break-all rounded-xl border border-white/10 bg-black/40 p-3 font-mono text-[11px] text-purple-100">
              {referralLink || "—"}
            </p>
            <button
              type="button"
              onClick={copyRef}
              disabled={!referralLink}
              className="mt-3 w-full rounded-xl border border-purple-400/30 bg-purple-500/15 py-2.5 text-sm font-semibold text-purple-100 disabled:opacity-40"
            >
              {copiedLink ? "Copied" : "Copy referral link"}
            </button>
          </GlassCard>

          <GlassCard glow="gold" className="mt-5">
            <p className="text-[10px] uppercase tracking-[0.24em] text-yellow-200/80">Security</p>
            <h3 className="mt-1 text-lg font-black">Update password</h3>
            <p className="mt-2 text-xs text-gray-400">Fast & Secure Payments</p>
            <input
              type="password"
              placeholder="Current password"
              value={currentPassword}
              disabled={pwdBusy}
              onChange={(e) => setCurrentPassword(e.target.value)}
              className="mt-3 w-full rounded-xl border border-white/10 bg-white/[0.06] p-3 text-sm outline-none focus:border-yellow-400/40"
            />
            <input
              type="password"
              placeholder="New password (min 8 chars)"
              value={newPassword}
              disabled={pwdBusy}
              onChange={(e) => setNewPassword(e.target.value)}
              className="mt-2 w-full rounded-xl border border-white/10 bg-white/[0.06] p-3 text-sm outline-none focus:border-yellow-400/40"
            />
            <button
              type="button"
              onClick={submitPassword}
              disabled={pwdBusy}
              className="mt-3 w-full rounded-xl bg-gradient-to-r from-yellow-500 to-amber-600 py-3 text-sm font-black text-black disabled:opacity-50"
            >
              {pwdBusy ? "Saving…" : "Save new password"}
            </button>
          </GlassCard>

          <button
            type="button"
            onClick={logout}
            className="mt-8 w-full rounded-2xl border border-red-500/30 bg-red-500/15 py-3.5 text-sm font-semibold text-red-200 transition hover:bg-red-500/25"
          >
            Logout
          </button>
        </div>
      </PageWrapper>
    </ProtectedRoute>
  );
}

function Info({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-black/30 p-3">
      <p className="text-[10px] uppercase tracking-[0.18em] text-gray-500">{label}</p>
      <p className={`mt-1 break-all text-sm font-semibold text-white ${mono ? "font-mono text-[13px]" : ""}`}>
        {value}
      </p>
    </div>
  );
}
