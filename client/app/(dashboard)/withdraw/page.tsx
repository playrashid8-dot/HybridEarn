"use client";

import { useCallback, useEffect, useMemo, useState, type ChangeEvent } from "react";
import { motion } from "framer-motion";
import ProtectedRoute from "../../../components/ProtectedRoute";
import { showToast as showVipToast, getMessage } from "../../../lib/vipToast";
import { estimateWithdrawNetUsd, inferWithdrawFeeRate } from "../../../lib/withdrawFeeEstimate";
import { fetchHybridSummary, fetchHybridWithdrawals, requestHybridWithdraw } from "../../../lib/hybrid";
import { maskAddress, isValidEvmAddress42 } from "../../../lib/helpers";
import { getWithdrawalBadgeVariant, getWithdrawalStatusLabel } from "../../../lib/withdrawUi";
import Card from "../../../components/ui/Card";
import Button from "../../../components/ui/Button";
import Input from "../../../components/ui/Input";
import Badge from "../../../components/ui/Badge";
import Modal from "../../../components/ui/Modal";
import { SkeletonLine } from "../../../components/Skeleton";

const OPEN_WITHDRAW_STATUSES = new Set(["pending", "claimable", "approved"]);

/** Remaining ms until unlock; prefers API `unlockAt` (unix ms), then `withdrawLockUntil` ISO. */
function getWithdrawCooldownRemainingMs(
  unlockAt: unknown,
  withdrawLockUntil: unknown,
  now: number,
): number {
  if (unlockAt != null && unlockAt !== "") {
    const n = Number(unlockAt);
    if (Number.isFinite(n)) {
      const raw = Math.max(0, n - now);
      return raw;
    }
  }
  if (withdrawLockUntil == null || withdrawLockUntil === "") return 0;
  const raw = Math.max(0, new Date(String(withdrawLockUntil)).getTime() - now);
  return Number.isFinite(raw) ? raw : 0;
}

/** Binance-style primary CTA label for cooldown. */
function formatUnlockInLabel(remainingMs: number): string {
  if (remainingMs <= 0) return "Unlock in 0h";
  const h = remainingMs / (1000 * 60 * 60);
  if (h >= 1) return `Unlock in ${h.toFixed(1)}h`;
  const mins = Math.max(1, Math.ceil(remainingMs / (1000 * 60)));
  return `Unlock in ${mins}m`;
}

/** Short crypto-style ellipsis (Binance-like). */
function formatHash(hash: string): string {
  if (!hash) return "";
  return `${hash.slice(0, 10)}...${hash.slice(-6)}`;
}

function formatWithdrawSubmitError(err: unknown, fallback: string): string {
  const e = err as {
    code?: string;
    response?: { status?: number; data?: { msg?: string; message?: string } };
  };
  if (!e?.response) {
    if (e?.code === "ECONNABORTED" || e?.code === "TIMEOUT") return "Request timed out. Try again.";
    return "Network error, try again";
  }
  const status = e.response.status;
  const msg = String(e.response.data?.msg || e.response.data?.message || "").trim();

  if (status === 401 || /token missing|invalid token|authorization failed/i.test(msg)) {
    return "Please sign in — no valid session token";
  }
  if (/invalid password/i.test(msg)) return "Invalid password";
  if (/withdrawal locked/i.test(msg)) return msg;
  if (/pending withdrawal must be completed first/i.test(msg)) {
    return "Withdrawal already pending";
  }
  if (/insufficient hybrid balance or pending withdrawal exists/i.test(msg)) {
    return "Insufficient balance or a withdrawal may already be in progress";
  }
  const minMatch = msg.match(/minimum withdrawal is\s+(\d+(?:\.\d+)?)/i);
  if (minMatch) return `Minimum amount is $${minMatch[1]}`;
  if (/insufficient hybrid balance/i.test(msg)) return "Insufficient balance";

  return msg || fallback;
}

const glassCard =
  "rounded-2xl border border-white/[0.08] bg-white/5 shadow-soft backdrop-blur-xl";

export default function WithdrawPage() {
  const [amount, setAmount] = useState("");
  const [walletAddress, setWalletAddress] = useState("");
  const [withdrawPassword, setWithdrawPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [submitError, setSubmitError] = useState("");
  const [hybrid, setHybrid] = useState<any>(null);
  const [withdrawals, setWithdrawals] = useState<any[]>([]);
  const [dataLoading, setDataLoading] = useState(true);
  const [detail, setDetail] = useState<any | null>(null);
  const [successBanner, setSuccessBanner] = useState<{ net: number; gross: number } | null>(null);
  const [nowTick, setNowTick] = useState(() => Date.now());

  const withdrawLockUntil = hybrid?.withdrawLockUntil;

  const remainingMs = useMemo(
    () =>
      getWithdrawCooldownRemainingMs(hybrid?.unlockAt, withdrawLockUntil, nowTick),
    [hybrid?.unlockAt, withdrawLockUntil, nowTick],
  );

  const spendableHybridBalance =
    Number(hybrid?.depositBalance || 0) + Number(hybrid?.rewardBalance || 0);

  const withdrawMin =
    hybrid?.withdrawMinAmount != null && Number.isFinite(Number(hybrid.withdrawMinAmount))
      ? Number(hybrid.withdrawMinAmount)
      : null;

  const summaryReady = hybrid != null && !dataLoading;
  const hasOpenWithdrawal = withdrawals.some((w) =>
    OPEN_WITHDRAW_STATUSES.has(String(w.status || "").toLowerCase()),
  );

  const legacyCooldownLocked = remainingMs > 0;

  const usesApiWithdrawGate =
    hybrid != null &&
    typeof hybrid.canWithdraw === "boolean" &&
    (hybrid.withdrawReason === "cooldown" || hybrid.withdrawReason == null);

  const cooldownLocked = usesApiWithdrawGate
    ? hybrid.withdrawReason === "cooldown"
    : legacyCooldownLocked;

  const canWithdrawEffective = usesApiWithdrawGate
    ? hybrid.canWithdraw === true
    : !legacyCooldownLocked;

  const withdrawalSubmitLocked =
    !summaryReady ||
    hasOpenWithdrawal ||
    !canWithdrawEffective ||
    withdrawMin == null;

  const lockHours = Math.floor(remainingMs / (1000 * 60 * 60));
  const lockMins = Math.floor((remainingMs / (1000 * 60)) % 60);

  useEffect(() => {
    if (!cooldownLocked) return;
    const id = window.setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, [cooldownLocked]);

  const loadHybrid = useCallback(async (silent = false) => {
    try {
      if (!silent) {
        setDataLoading(true);
        setLoadError("");
      }
      const [hybridData, withdrawalData] = await Promise.all([
        fetchHybridSummary().catch(() => null),
        fetchHybridWithdrawals().catch(() => []),
      ]);
      if (silent) {
        if (hybridData) setHybrid(hybridData);
        if (Array.isArray(withdrawalData)) setWithdrawals(withdrawalData);
      } else {
        if (hybridData) setHybrid(hybridData);
        setWithdrawals(withdrawalData || []);
      }
    } catch (e: any) {
      if (!silent) setLoadError(getMessage(e, "Could not load withdrawal data"));
    } finally {
      if (!silent) setDataLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadHybrid(false);
  }, [loadHybrid]);

  useEffect(() => {
    const id = window.setInterval(() => void loadHybrid(true), 16000);
    return () => clearInterval(id);
  }, [loadHybrid]);

  const feeRateDisplay = useMemo(() => inferWithdrawFeeRate(withdrawals) * 100, [withdrawals]);

  const feeAppliedLabel = useMemo(() => {
    const r = feeRateDisplay;
    const pct = Math.abs(r - Math.round(r)) < 0.05 ? Math.round(r).toString() : r.toFixed(1);
    return `≈ ${pct}% fee applied`;
  }, [feeRateDisplay]);

  const netPreview = useMemo(
    () => estimateWithdrawNetUsd(Number(amount || 0), withdrawals),
    [amount, withdrawals],
  );

  const withdrawButtonLabel = hasOpenWithdrawal
    ? "Withdrawal pending"
    : cooldownLocked
      ? formatUnlockInLabel(remainingMs)
      : "Withdraw Now";

  const amountPlaceholder = cooldownLocked ? "Preview only — cooldown active" : "0.00";
  const walletPlaceholder = cooldownLocked ? "You can still enter your address" : "0x…";

  const withdraw = async () => {
    if (loading) return;
    setSubmitError("");

    if (withdrawalSubmitLocked) {
      if (hasOpenWithdrawal) showVipToast("error", "Withdrawal already pending");
      else if (cooldownLocked) showVipToast("error", "Cooldown active — try again after unlock.");
      return;
    }

    const amt = Number(amount || 0);

    if (withdrawMin == null) {
      return;
    }

    if (!Number.isFinite(amt) || amt < withdrawMin) {
      return showVipToast("error", `Minimum amount is $${withdrawMin}`);
    }

    if (amt > spendableHybridBalance) {
      return showVipToast("error", "Insufficient balance");
    }

    if (!isValidEvmAddress42(walletAddress.trim())) {
      return showVipToast("error", "Enter a valid wallet: 0x + 40 hex characters (42 total)");
    }

    if (!withdrawPassword.trim()) {
      return showVipToast("error", "Enter password");
    }

    try {
      setLoading(true);
      const payload = {
        amount: amt,
        walletAddress: walletAddress.trim(),
        password: withdrawPassword,
      };

      const result: any = await requestHybridWithdraw(
        payload,
        globalThis.crypto?.randomUUID?.(),
      );

      const nw = Number(result?.withdrawal?.netAmount ?? netPreview);
      const gr = Number(result?.withdrawal?.grossAmount ?? amt);
      setSuccessBanner({
        net: Number.isFinite(nw) ? nw : netPreview,
        gross: Number.isFinite(gr) ? gr : amt,
      });
      window.setTimeout(() => setSuccessBanner(null), 12000);

      showVipToast("success", "Withdrawal request submitted");
      setAmount("");
      setWithdrawPassword("");
      await loadHybrid(true);
    } catch (err: any) {
      const msg = formatWithdrawSubmitError(err, getMessage(err, "Request failed"));
      setSubmitError(msg);
      const toastMsg =
        /already pending/i.test(msg) ? "Withdrawal already pending" : msg;
      showVipToast("error", toastMsg);
    } finally {
      setLoading(false);
    }
  };

  const modalBody = useMemo(() => {
    if (!detail) return null;
    const gross = Number(detail.grossAmount ?? 0);
    const fee = Number(detail.feeAmount ?? Math.max(0, gross - Number(detail.netAmount ?? 0)));
    const net = Number(detail.netAmount ?? 0);
    const label = getWithdrawalStatusLabel(detail.status);
    const hash = detail.txHash ? String(detail.txHash) : "";
    const badgeClass = withdrawalStatusBadgeClass(detail.status);

    const glassSection =
      "rounded-xl border border-white/10 bg-white/5 px-4 py-3.5 backdrop-blur-md";

    return (
      <div className="space-y-5 text-sm">
        {/* Header + status — hierarchy: STATUS first */}
        <div className="space-y-4">
          <h2 className="bg-gradient-to-r from-purple-300 via-violet-400 to-blue-400 bg-clip-text text-2xl font-bold leading-tight tracking-tight text-transparent drop-shadow-[0_0_28px_rgba(168,85,247,0.45)] sm:text-3xl">
            Withdrawal Details
          </h2>
          <div className="flex flex-wrap items-center gap-2">
            <span className={`${badgeClass}`}>{label}</span>
          </div>
        </div>

        <div className={glassSection}>
          <p className="text-xs text-gray-500">Amount</p>
          <p className="mt-1 text-xl font-semibold tabular-nums text-white drop-shadow-[0_0_14px_rgba(255,255,255,0.12)]">
            {gross.toFixed(2)} USDT
          </p>
        </div>

        <div
          className={`${glassSection} border-red-500/15 bg-white/[0.03] shadow-[0_0_24px_rgba(248,113,113,0.08)]`}
        >
          <p className="text-xs text-gray-500">Fee</p>
          <p className="mt-1 text-lg font-semibold tabular-nums text-red-400 drop-shadow-[0_0_12px_rgba(248,113,113,0.35)]">
            −{fee.toFixed(2)} USDT
          </p>
        </div>

        <div className="rounded-xl border border-emerald-400/40 bg-gradient-to-br from-emerald-500/25 via-emerald-600/15 to-cyan-950/30 px-4 py-4 shadow-[0_0_48px_rgba(16,185,129,0.35)] backdrop-blur-md ring-1 ring-emerald-400/25">
          <p className="text-xs font-medium text-gray-400">You receive</p>
          <p className="mt-2 flex flex-wrap items-baseline gap-2.5 text-3xl font-bold tabular-nums text-white">
            <span aria-hidden className="select-none text-[1.1em] leading-none">
              💰
            </span>
            <span className="drop-shadow-[0_0_20px_rgba(52,211,153,0.45)]">{net.toFixed(2)} USDT</span>
          </p>
        </div>

        <AddressDetailSection address={detail.walletAddress ? String(detail.walletAddress) : ""} />

        <div className={`${glassSection} bg-white/[0.03]`}>
          <p className="text-xs text-gray-500">Transaction</p>
          {hash ? (
            <TransactionDetailSection txHash={hash} />
          ) : (
            <p className="mt-2 text-xs leading-relaxed text-gray-600">
              TX hash appears after payout is recorded.
            </p>
          )}
        </div>
      </div>
    );
  }, [detail]);

  return (
    <ProtectedRoute>
      <div className={`relative w-full max-w-lg space-y-4 px-4 pb-24 text-white`}>
        {loadError ? (
          <div className="rounded-2xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-100">
            {loadError}
          </div>
        ) : null}

        {submitError ? (
          <div
            role="alert"
            className="rounded-2xl border border-red-500/35 bg-red-500/[0.14] px-4 py-3 text-sm font-medium text-red-50 shadow-[0_8px_32px_rgba(220,38,38,0.12)] ring-1 ring-red-400/25"
          >
            {submitError}
          </div>
        ) : null}

        {cooldownLocked ? (
          <div
            className="mb-4 rounded-xl border border-amber-400/25 bg-amber-500/[0.08] p-4 backdrop-blur-md"
            role="status"
          >
            <p className="text-sm font-medium text-amber-50">Withdrawal temporarily unavailable</p>
            <p className="mt-1 text-xs tabular-nums text-amber-200/90">
              Unlocks in {lockHours}h {lockMins}m
            </p>
          </div>
        ) : null}

        {successBanner ? (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            className="rounded-2xl border border-emerald-500/35 bg-emerald-500/[0.12] px-4 py-3 text-sm text-emerald-50 ring-1 ring-emerald-400/25"
          >
            <p className="font-semibold text-emerald-100">
              Queued — est.{" "}
              <span className="tabular-nums">${successBanner.net.toFixed(2)}</span> net (from{" "}
              <span className="tabular-nums">${successBanner.gross.toFixed(2)}</span> gross).
            </p>
          </motion.div>
        ) : null}

        <Card className={`!bg-white/5 !shadow-soft backdrop-blur-xl ${glassCard} !border-white/[0.08]`}>
          <div className="space-y-4">
            <Input
              label="Amount (USDT)"
              type="number"
              inputMode="decimal"
              placeholder={amountPlaceholder}
              value={amount}
              disabled={loading}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setAmount(e.target.value)}
            />
            <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/[0.06] px-4 py-3">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-emerald-200/90">
                Est. receive
              </p>
              <p className="mt-1 text-lg font-bold tabular-nums text-emerald-100">
                {Number(amount || 0) > 0 ? `${netPreview.toFixed(2)} USDT` : "—"}
              </p>
              <p className="mt-1 text-[11px] text-emerald-200/80">{feeAppliedLabel}</p>
            </div>
            <Input
              label="Wallet Address"
              autoComplete="off"
              placeholder={walletPlaceholder}
              value={walletAddress}
              disabled={loading}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setWalletAddress(e.target.value)}
              hint="Enter BEP20 address"
            />
            <Input
              label="Account Password"
              type="password"
              placeholder="••••••••"
              value={withdrawPassword}
              disabled={loading}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setWithdrawPassword(e.target.value)}
            />
          </div>

          <Button
            type="button"
            className="mt-6 !rounded-xl !bg-gradient-to-r !from-emerald-600 !to-emerald-600 !py-3 !shadow-none hover:!from-emerald-500 hover:!to-emerald-500 hover:!brightness-100"
            size="lg"
            loading={loading}
            disabled={withdrawalSubmitLocked}
            onClick={() => void withdraw()}
          >
            {withdrawButtonLabel}
          </Button>
        </Card>

        <div className="space-y-3">
          <h3 className="text-sm font-semibold text-white">Withdrawal History</h3>

          {dataLoading ? (
            <div className="space-y-3">
              <SkeletonLine className="h-28 w-full rounded-2xl" />
              <SkeletonLine className="h-28 w-full rounded-2xl" />
            </div>
          ) : withdrawals.length === 0 ? (
            <div className={`${glassCard} px-4 py-10 text-center text-sm text-gray-500`}>
              No withdrawals yet
            </div>
          ) : (
            <div className="space-y-3">
              {withdrawals.map((w) => {
                const variant = getWithdrawalBadgeVariant(w.status);
                const net = Number(w.netAmount ?? 0);
                const addr = w.walletAddress ? maskAddress(String(w.walletAddress)) : "—";
                const dateStr = w.createdAt ? new Date(w.createdAt).toLocaleString() : "";
                return (
                  <motion.div key={w._id} layout initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}>
                    <Card className={`!p-4 transition hover:border-white/[0.12] ${glassCard} !bg-white/[0.04]`}>
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                        <div className="min-w-0 space-y-2 text-sm">
                          <p className="text-white">
                            <span className="text-gray-500">Amount: </span>
                            <span className="font-bold tabular-nums">${net.toFixed(2)}</span>
                          </p>
                          <p className="truncate text-white">
                            <span className="text-gray-500">Wallet: </span>
                            <span className="font-mono text-xs text-gray-300">{addr}</span>
                          </p>
                          <p className="flex flex-wrap items-center gap-2">
                            <span className="text-gray-500">Status: </span>
                            <Badge variant={variant}>{getWithdrawalStatusLabel(w.status)}</Badge>
                          </p>
                          <p className="text-xs text-gray-500">{dateStr}</p>
                        </div>
                        <button
                          type="button"
                          onClick={() => setDetail(w)}
                          className="min-h-[44px] shrink-0 rounded-xl border border-blue-500/35 bg-blue-500/10 px-4 py-3 text-xs font-semibold text-blue-100 transition hover:bg-blue-500/20 active:scale-[0.98] sm:min-w-[88px]"
                        >
                          View
                        </button>
                      </div>
                    </Card>
                  </motion.div>
                );
              })}
            </div>
          )}
        </div>

        <Modal
          open={!!detail}
          title=""
          onClose={() => setDetail(null)}
          footer={
            <button
              type="button"
              onClick={() => setDetail(null)}
              className="w-full rounded-xl bg-gradient-to-r from-purple-600 via-indigo-600 to-blue-600 py-3.5 text-sm font-semibold text-white shadow-[0_14px_48px_rgba(99,102,241,0.5)] transition hover:scale-[1.02] hover:shadow-[0_18px_56px_rgba(139,92,246,0.45)] active:scale-[0.98]"
            >
              Close
            </button>
          }
        >
          {modalBody}
        </Modal>
      </div>
    </ProtectedRoute>
  );
}

function withdrawalStatusBadgeClass(status?: string): string {
  const s = String(status || "").toLowerCase();
  const base =
    "inline-flex items-center rounded-full px-4 py-1.5 text-sm font-semibold backdrop-blur-md";

  if (s === "paid" || s === "claimed") {
    return `${base} border border-emerald-400/45 bg-emerald-500/20 text-emerald-200 shadow-[0_0_28px_rgba(52,211,153,0.45)]`;
  }
  if (s === "approved") {
    return `${base} border border-blue-400/40 bg-blue-500/20 text-blue-200 shadow-[0_0_28px_rgba(59,130,246,0.45)]`;
  }
  if (s === "rejected") {
    return `${base} border border-red-400/40 bg-red-500/15 text-red-200 shadow-[0_0_26px_rgba(248,113,113,0.4)]`;
  }
  /* pending, claimable, unknown */
  return `${base} border border-amber-400/30 bg-gradient-to-r from-yellow-500/30 to-orange-500/25 text-amber-100 shadow-[0_0_30px_rgba(251,191,36,0.35)]`;
}

function AddressDetailSection({ address }: { address: string }) {
  const trimmed = address.trim();

  return (
    <div className="rounded-xl border border-white/10 bg-white/5 px-4 py-3.5 backdrop-blur-md">
      <p className="text-xs text-gray-500">Address</p>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <p className="min-w-0 flex-1 break-all font-mono text-xs text-gray-400">
          {trimmed ? formatHash(trimmed) : "—"}
        </p>
        {trimmed ? (
          <button
            type="button"
            onClick={() => void navigator.clipboard.writeText(trimmed)}
            className="shrink-0 rounded-lg border border-white/10 bg-white/[0.06] px-2.5 py-1.5 text-xs font-medium text-gray-300 backdrop-blur-sm transition hover:border-violet-400/35 hover:bg-violet-500/15 hover:text-white active:scale-[0.97]"
          >
            Copy
          </button>
        ) : null}
      </div>
    </div>
  );
}

function TransactionDetailSection({ txHash }: { txHash: string }) {
  const full = txHash.trim();

  return (
    <div className="mt-2 flex flex-wrap items-center gap-3">
      <p className="min-w-0 flex-1 font-mono text-xs text-gray-400">{formatHash(full)}</p>
      <button
        type="button"
        onClick={() => void navigator.clipboard.writeText(full)}
        className="shrink-0 rounded-lg border border-white/10 bg-white/[0.06] px-2.5 py-1.5 text-xs font-medium text-gray-300 backdrop-blur-sm transition hover:border-white/20 hover:text-gray-100 active:scale-[0.98]"
      >
        Copy
      </button>
    </div>
  );
}
