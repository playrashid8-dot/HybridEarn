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
  celebrationUsd: number | null;
  onCelebrationDismiss: () => void;
};

export default function DashboardRoiSection({
  cardClass,
  hybrid,
  roiLoading,
  handleClaimRoi,
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
    const id = window.setTimeout(() => onCelebrationDismiss(), 2800);
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
        <span
          className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-gray-900/35 border-t-gray-900"
          aria-hidden
        />
        Claiming…
      </>
    );
  } else if (claimedTodayPkt) {
    buttonInner = "Claimed today";
  } else {
    buttonInner = "Claim ROI";
  }

  return (
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
        </div>

        <motion.button
          type="button"
          onClick={handleClaimRoi}
          disabled={buttonDisabled}
          whileTap={buttonDisabled ? undefined : { scale: 0.98 }}
          className="inline-flex min-h-[48px] w-full shrink-0 items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-emerald-500 to-green-400 px-6 py-3 text-sm font-black text-gray-950 shadow-[0_0_24px_rgba(52,211,153,0.22)] ring-1 ring-emerald-300/30 transition duration-300 ease-out hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-45 disabled:shadow-none sm:w-auto sm:min-w-[160px]"
        >
          {buttonInner}
        </motion.button>
      </div>

      <AnimatePresence>
        {celebrationUsd != null && Number.isFinite(celebrationUsd) ? (
          <motion.div
            key="celebration"
            initial={{ opacity: 0, scale: 0.82 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 1.06 }}
            transition={{ type: "spring", stiffness: 420, damping: 22 }}
            className="pointer-events-none fixed left-1/2 top-[22%] z-[110] flex -translate-x-1/2 flex-col items-center gap-2 rounded-2xl border border-emerald-400/40 bg-gray-950/90 px-7 py-4 text-center shadow-[0_0_60px_rgba(16,185,129,0.55),0_0_120px_rgba(52,211,153,0.25)] backdrop-blur-xl"
          >
            <span className="text-4xl drop-shadow-[0_0_12px_rgba(52,211,153,0.8)]" aria-hidden>
              💰
            </span>
            <motion.p
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.08 }}
              className="text-lg font-black tabular-nums tracking-tight text-emerald-200"
              style={{
                textShadow: "0 0 26px rgba(52,211,153,0.55)",
              }}
            >
              +{celebrationUsd.toFixed(2)} USDT
            </motion.p>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
