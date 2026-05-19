"use client";

import { AnimatePresence, motion } from "framer-motion";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import {
  countdownPartsFromIso,
  formatHms,
  getTimeUntil5AM,
} from "../../lib/roiPkt";

type Props = {
  cardClass: string;
  hybrid: Record<string, unknown> | null | undefined;
  roiLoading: boolean;
  handleClaimRoi: () => void;
  roiProgressLabel?: string | null;
  celebrationUsd: number | null;
  onCelebrationDismiss: () => void;
};

export default function DashboardRoiSection({
  cardClass,
  hybrid,
  roiLoading,
  handleClaimRoi,
  roiProgressLabel,
  celebrationUsd,
  onCelebrationDismiss,
}: Props) {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (celebrationUsd == null || !Number.isFinite(celebrationUsd)) return;
    const id = window.setTimeout(() => onCelebrationDismiss(), 3600);
    return () => window.clearTimeout(id);
  }, [celebrationUsd, onCelebrationDismiss]);

  void tick;

  const roiRatePct = (Number(hybrid?.roiRate || 0) * 100).toFixed(2);
  const canClaimRoi = hybrid?.canClaimRoi === true;
  const claimedTodayPkt = hybrid?.claimedTodayPkt === true;
  const isAfter5AMPkt = hybrid?.isAfter5AMPkt === true;

  const targetIso =
    typeof hybrid?.roiCountdownTargetIso === "string"
      ? hybrid.roiCountdownTargetIso
      : typeof hybrid?.nextRoiClaimAt === "string"
        ? hybrid.nextRoiClaimAt
        : null;

  const countdown = useMemo(() => {
    if (targetIso) return countdownPartsFromIso(targetIso);
    if (!isAfter5AMPkt) return getTimeUntil5AM();
    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- tick refreshes countdown every second
  }, [targetIso, isAfter5AMPkt, tick]);

  const buttonDisabled = roiLoading || !canClaimRoi;

  let buttonInner: ReactNode;
  if (roiLoading) {
    buttonInner = (
      <>
        <span className="relative h-5 w-5 shrink-0" aria-hidden>
          <span className="absolute inset-0 rounded-full border-2 border-gray-950/20" />
          <span className="absolute inset-0 animate-spin rounded-full border-2 border-transparent border-t-gray-950 shadow-[0_0_16px_rgba(6,78,59,0.65)]" />
          <span className="absolute inset-1 rounded-full bg-gray-950/15" />
        </span>
        {roiProgressLabel || "Processing Secure Payout..."}
      </>
    );
  } else if (claimedTodayPkt) {
    buttonInner = "Claimed today";
  } else {
    buttonInner = "Claim ROI";
  }

  return (
    <>
    <div
      className={`relative mt-5 overflow-hidden rounded-2xl p-4 shadow-[0_0_28px_rgba(16,185,129,0.08)] transition duration-300 ease-out hover:scale-[1.005] sm:p-5 ${cardClass}`}
    >
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-emerald-500/[0.07] via-transparent to-cyan-500/[0.05]" />

      <div className="relative z-[1] flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 flex-1 space-y-2">
          <p className="text-sm text-gray-400">
            Rate:{` `}
            <span className="font-bold tabular-nums text-white">{roiRatePct}%</span>
          </p>

          {!isAfter5AMPkt ? (
            <p className="text-xs tabular-nums text-amber-200/90">
              ⏳ ROI unlock in:{` `}
              <span className="font-semibold text-white">{countdown ? formatHms(countdown) : "—"}</span>
            </p>
          ) : claimedTodayPkt && countdown ? (
            <p className="text-xs tabular-nums text-slate-300/95">
              Next claim window:{` `}
              <span className="font-semibold text-emerald-200">{formatHms(countdown)}</span>
            </p>
          ) : null}
          <AnimatePresence mode="wait">
            {roiLoading && roiProgressLabel ? (
              <motion.div
                key="roi-secure-processing"
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.22, ease: "easeOut" }}
                className="inline-flex items-center gap-2 rounded-full border border-emerald-400/25 bg-emerald-400/[0.08] px-3 py-1.5 text-[11px] font-semibold text-emerald-100 shadow-[0_0_24px_rgba(16,185,129,0.12)]"
              >
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-300 shadow-[0_0_12px_rgba(110,231,183,0.9)]" />
                {roiProgressLabel}
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>

        <motion.button
          type="button"
          onClick={handleClaimRoi}
          disabled={buttonDisabled}
          aria-busy={roiLoading}
          whileTap={buttonDisabled ? undefined : { scale: 0.98 }}
          className={`relative inline-flex min-h-[48px] w-full shrink-0 items-center justify-center gap-2 overflow-hidden rounded-2xl bg-gradient-to-r from-emerald-500 via-green-400 to-cyan-300 bg-[length:180%_100%] px-6 py-3 text-sm font-black text-gray-950 shadow-[0_0_24px_rgba(52,211,153,0.22)] ring-1 ring-emerald-300/30 transition duration-300 ease-out hover:bg-right hover:brightness-110 disabled:cursor-not-allowed sm:w-auto sm:min-w-[160px] ${
            roiLoading
              ? "opacity-100 shadow-[0_0_34px_rgba(52,211,153,0.42)]"
              : "disabled:opacity-60 disabled:shadow-[0_0_22px_rgba(52,211,153,0.16)]"
          }`}
        >
          {roiLoading ? (
            <motion.span
              className="pointer-events-none absolute inset-y-0 -left-1/2 w-1/2 bg-gradient-to-r from-transparent via-white/35 to-transparent"
              animate={{ x: ["0%", "320%"] }}
              transition={{ duration: 1.25, repeat: Infinity, ease: "easeInOut" }}
              aria-hidden
            />
          ) : null}
          <span className="relative z-[1] inline-flex items-center justify-center gap-2">
            {buttonInner}
          </span>
        </motion.button>
      </div>

    </div>

    <AnimatePresence>
      {celebrationUsd != null && Number.isFinite(celebrationUsd) ? (
        <motion.div
          key="roi-success-overlay"
          role="status"
          aria-live="polite"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.24, ease: "easeOut" }}
          className="pointer-events-none fixed inset-0 z-[120] flex items-center justify-center overflow-hidden bg-slate-950/45 px-4 py-6 backdrop-blur-md"
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.86, y: 18 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.94, y: -8 }}
            transition={{ type: "spring", stiffness: 360, damping: 26, mass: 0.8 }}
            className="relative w-[90%] max-w-[320px] overflow-hidden rounded-[28px] border border-emerald-300/45 bg-slate-950/80 px-5 py-6 text-center shadow-[0_0_40px_rgba(0,255,120,0.35),0_0_110px_rgba(52,211,153,0.22),inset_0_1px_0_rgba(255,255,255,0.14)] ring-1 ring-emerald-200/15 backdrop-blur-2xl"
          >
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_0%,rgba(74,222,128,0.24),transparent_55%),linear-gradient(135deg,rgba(255,255,255,0.12),transparent_38%)]" />
            <div className="absolute -inset-16 bg-[radial-gradient(circle,rgba(34,197,94,0.12),transparent_58%)]" />
            <motion.span
              className="absolute inset-x-10 top-0 h-px bg-gradient-to-r from-transparent via-emerald-200/80 to-transparent"
              animate={{ opacity: [0.35, 1, 0.35] }}
              transition={{ duration: 1.8, repeat: Infinity, ease: "easeInOut" }}
              aria-hidden
            />
            <div className="relative mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl border border-emerald-200/35 bg-emerald-400/15 text-2xl shadow-[0_0_35px_rgba(52,211,153,0.42),inset_0_1px_0_rgba(255,255,255,0.12)]">
              <span className="drop-shadow-[0_0_12px_rgba(52,211,153,0.9)]" aria-hidden>
                ✓
              </span>
            </div>
            <motion.p
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.05 }}
              className="relative text-base font-black tracking-tight text-white sm:text-lg"
            >
              ROI Claimed Successfully ✅
            </motion.p>
            <motion.p
              initial={{ opacity: 0, y: 8, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              transition={{ delay: 0.12, type: "spring", stiffness: 360, damping: 20 }}
              className="relative mt-2 text-3xl font-black tabular-nums tracking-tight text-emerald-200"
              style={{
                textShadow: "0 0 28px rgba(52,211,153,0.68)",
              }}
            >
              +{celebrationUsd.toFixed(2)} USDT
            </motion.p>
            <p className="relative mt-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-emerald-100/70">
              Balance updated
            </p>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
    </>
  );
}
