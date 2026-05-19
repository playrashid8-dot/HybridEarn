"use client";

import { useState, useEffect, useRef } from "react";
import { motion } from "framer-motion";
import QRCode from "react-qr-code";
import ProtectedRoute from "../../../components/ProtectedRoute";
import Card from "../../../components/ui/Card";
import { fetchCurrentUser } from "../../../lib/session";
import { fetchHybridSummary } from "../../../lib/hybrid";
import { showToast } from "../../../lib/vipToast";
import SkeletonCard from "../../../components/SkeletonCard";
import { SkeletonLine } from "../../../components/Skeleton";
import StatusBadge from "../../../components/StatusBadge";
import { STATUS } from "../../../lib/constants";

/** Matches server HYBRID_DEPOSIT_CONFIRMATIONS_REQUIRED (UI display only). */
const DEPOSIT_CONFIRMATIONS_REQUIRED = 3;

function isDepositDone(d: any): boolean {
  const conf = Number(d?.confirmations ?? 0);
  const failed =
    d?.confirmationStatus === STATUS.FAILED ||
    String(d?.status || "").toLowerCase() === STATUS.FAILED ||
    String(d?.status || "").toLowerCase().includes("fail");
  return !failed && conf >= DEPOSIT_CONFIRMATIONS_REQUIRED;
}

const CARD_GLASS =
  "border border-white/[0.08] bg-white/[0.03] shadow-soft backdrop-blur-xl ring-1 ring-white/[0.05]";

export default function Deposit() {
  const [copied, setCopied] = useState(false);
  const [user, setUser]: any = useState(null);
  const [hybrid, setHybrid]: any = useState(null);
  const [walletLoading, setWalletLoading] = useState(true);
  const [slowWalletHint, setSlowWalletHint] = useState(false);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const prevDoneMap = useRef<Map<string, boolean>>(new Map());
  const [flashId, setFlashId] = useState<string | null>(null);

  const wallet = hybrid?.walletAddress || user?.walletAddress || "";
  const minDeposit =
    hybrid?.minDepositAmount != null && Number.isFinite(Number(hybrid.minDepositAmount))
      ? Number(hybrid.minDepositAmount)
      : 50;

  useEffect(() => {
    if (!walletLoading) {
      setSlowWalletHint(false);
      return;
    }
    const id = window.setTimeout(() => setSlowWalletHint(true), 2000);
    return () => clearTimeout(id);
  }, [walletLoading]);

  useEffect(() => {
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout>;
    setWalletLoading(true);

    const loadWallet = async (attempt = 0) => {
      const [fresh, hybridData] = await Promise.all([
        fetchCurrentUser().catch(() => null),
        fetchHybridSummary().catch(() => null),
      ]);

      if (cancelled) return;

      if (fresh) setUser(fresh);
      if (hybridData) setHybrid(hybridData);

      const loadedWallet = hybridData?.walletAddress || fresh?.walletAddress || "";

      if (!loadedWallet && attempt < 4) {
        retryTimer = setTimeout(() => loadWallet(attempt + 1), 2000);
        return;
      }

      setWalletLoading(false);
    };

    loadWallet();

    return () => {
      cancelled = true;
      clearTimeout(retryTimer);
    };
  }, [refreshNonce]);

  const refreshWalletUi = () => {
    setRefreshNonce((n) => n + 1);
  };

  useEffect(() => {
    const list = hybrid?.deposits || [];
    for (const deposit of list) {
      const id = String(deposit?._id ?? "");
      if (!id) continue;
      const done = isDepositDone(deposit);
      const prev = prevDoneMap.current.get(id);
      if (done && prev === false) {
        setFlashId(id);
        window.setTimeout(() => setFlashId((cur) => (cur === id ? null : cur)), 1600);
      }
      prevDoneMap.current.set(id, done);
    }
  }, [hybrid?.deposits]);

  const copyWallet = async () => {
    if (!wallet) return;
    await navigator.clipboard.writeText(wallet);
    setCopied(true);
    showToast("success", "Address copied");
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <ProtectedRoute>
      <div className="relative w-full max-w-full overflow-x-hidden pb-24 text-white">
        <h1 className="mb-6 text-2xl font-bold tracking-tight text-white sm:text-3xl">Deposit</h1>

        <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35 }}>
          <Card className={CARD_GLASS}>
            <div className="mb-5 flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-semibold text-white">Send USDT (BEP20)</p>
              <span className="rounded-full border border-emerald-500/30 bg-emerald-500/12 px-3 py-1 text-[10px] font-bold uppercase tracking-wide text-emerald-100">
                BEP20
              </span>
            </div>

            {wallet ? (
              <div className="mx-auto mb-6 flex max-w-[240px] justify-center rounded-2xl border border-white/[0.1] bg-white p-4 shadow-inner ring-1 ring-black/15">
                <QRCode value={wallet} size={188} level="M" fgColor="#0B0F19" bgColor="#ffffff" />
              </div>
            ) : (
              <div className="mx-auto mb-6 flex justify-center">
                {walletLoading ? (
                  <SkeletonCard className="mb-0 h-[228px] w-full max-w-[240px] rounded-2xl bg-white/10" />
                ) : (
                  <div className="flex h-[228px] w-full max-w-[240px] items-center justify-center rounded-2xl border border-dashed border-white/15 bg-black/30 text-xs text-gray-500">
                    No wallet yet
                  </div>
                )}
              </div>
            )}

            <div className="rounded-2xl border border-white/[0.08] bg-black/30 p-4 backdrop-blur-sm">
              <div className="min-w-0 break-all font-mono text-[13px] leading-relaxed text-gray-100">
                {!wallet && walletLoading ? (
                  <span className="flex flex-col gap-2">
                    <span className="inline-flex flex-wrap items-center gap-x-2 text-[11px] text-gray-400 sm:flex-row">
                      <SkeletonLine className="h-3 min-w-[120px] max-w-[min(100%,260px)] flex-1" />
                      {slowWalletHint ? (
                        <span>
                          Still generating…{" "}
                          <button
                            type="button"
                            onClick={refreshWalletUi}
                            className="font-semibold text-emerald-300/95 underline underline-offset-2 hover:text-emerald-200"
                          >
                            tap refresh
                          </button>
                        </span>
                      ) : (
                        <span className="text-gray-500">Preparing wallet address…</span>
                      )}
                    </span>
                  </span>
                ) : wallet ? (
                  wallet
                ) : (
                  "—"
                )}
              </div>
              <button
                type="button"
                onClick={copyWallet}
                disabled={!wallet}
                className="mt-4 w-full rounded-2xl bg-gradient-to-r from-emerald-500 to-green-400 px-5 py-4 text-sm font-bold text-gray-950 shadow-soft transition hover:brightness-110 disabled:opacity-40 sm:py-3.5"
              >
                {copied ? "Copied ✓" : "Copy address"}
              </button>
            </div>
          </Card>
        </motion.div>

        <Card className={`mt-5 ${CARD_GLASS} border-amber-500/20`}>
          <p className="mb-3 font-semibold text-white">Important</p>
          <ul className="space-y-2 text-sm text-gray-300">
            <li>Send only USDT (BEP20)</li>
            <li>Minimum deposit: ${50} USDT</li>
            <li>Confirmation: 1–2 minutes</li>
            
          </ul>
        </Card>

        <div className="mt-8">
          <p className="mb-3 text-sm font-semibold text-white">Deposit history</p>
          <div className={`overflow-hidden rounded-2xl ${CARD_GLASS}`}>
            <div className="overflow-x-auto">
              {walletLoading && !hybrid ? (
                <div className="space-y-0 px-2 py-4">
                  {[1, 2, 3, 4].map((i) => (
                    <div key={i} className="flex gap-3 border-b border-white/[0.04] py-3 last:border-0">
                      <div className="h-4 w-16 animate-pulse rounded bg-white/10" />
                      <div className="h-4 flex-1 animate-pulse rounded bg-white/10" />
                      <div className="h-4 w-24 animate-pulse rounded bg-white/10" />
                    </div>
                  ))}
                </div>
              ) : !!hybrid?.deposits?.length ? (
                <table className="w-full min-w-[300px] text-left text-sm">
                  <thead>
                    <tr className="border-b border-white/[0.08] text-[10px] font-semibold uppercase tracking-wide text-gray-500">
                      <th className="px-4 py-3">Amount</th>
                      <th className="px-4 py-3">Status</th>
                      <th className="px-4 py-3 text-right">Date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {hybrid.deposits.slice(0, 8).map((deposit: any) => {
                      const failed =
                        deposit?.confirmationStatus === STATUS.FAILED ||
                        String(deposit?.status || "").toLowerCase() === STATUS.FAILED ||
                        String(deposit?.status || "").toLowerCase().includes("fail");
                      const done = isDepositDone(deposit);
                      const rowClass = String(deposit._id) === flashId ? "deposit-row-highlight " : "";

                      const label = failed ? "Failed" : done ? "Confirmed" : "Pending";
                      const tier = failed ? "danger" : done ? "success" : "warning";

                      return (
                        <tr
                          key={deposit._id}
                          className={`border-b border-white/[0.04] last:border-0 transition hover:bg-white/[0.03] ${rowClass}`}
                        >
                          <td className="px-4 py-3.5 font-semibold tabular-nums text-white">
                            ${Number(deposit.amount ?? 0).toFixed(2)}
                          </td>
                          <td className="px-4 py-3.5">
                            <StatusBadge tier={tier}>{label}</StatusBadge>
                          </td>
                          <td className="px-4 py-3.5 text-right text-xs tabular-nums text-gray-400">
                            {deposit.createdAt ? new Date(deposit.createdAt).toLocaleDateString() : "—"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              ) : (
                <p className="px-4 py-12 text-center text-sm text-gray-500">No deposits yet.</p>
              )}
            </div>
          </div>
        </div>
      </div>
    </ProtectedRoute>
  );
}
