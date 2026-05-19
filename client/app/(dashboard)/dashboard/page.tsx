"use client";

import useSWR from "swr";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { motion, useMotionValue, useMotionValueEvent, useSpring } from "framer-motion";
import { claimHybridRoi, fetchRoiClaimStatus } from "../../../lib/hybrid";
import {
  fetchDashboardMainBundleSWR,
  DASHBOARD_MAIN_BUNDLE_KEY,
  hybridDashboardSWRConfig,
} from "../../../lib/swr-fetch";
import { showToast, getMessage } from "../../../lib/vipToast";
import ProtectedRoute from "../../../components/ProtectedRoute";
import PageWrapper from "../../../components/PageWrapper";
import LiveRefreshIndicator from "../../../components/LiveRefreshIndicator";
import RewardNotification from "../../../components/dashboard/RewardNotification";

const CARD = "rounded-2xl border border-white/10 bg-white/5 backdrop-blur-xl";
const ROI_POLL_INTERVAL_MS = 2500;
const ROI_POLL_MAX_ELAPSED_MS = 180_000;
const ROI_FAILURE_MSG = "Unable to process payout. Please retry.";
const ROI_ACTIVE_STATUSES = new Set(["queued", "processing", "broadcasting"]);
const ROI_TRANSIENT_FAILED_STATES = new Set(["status_unavailable"]);
const ROI_INACTIVE_CONFIRMED_STATES = new Set(["missing", "missing_requested_job"]);
const formatUsd = (value: number) => `$${Number(value || 0).toFixed(2)}`;
const roiDebug = (...args: unknown[]) => {
  if (process.env.NODE_ENV === "development") {
    console.debug(...args);
  }
};

type RoiQueueStatus = {
  queued?: boolean;
  status?: string | null;
  state?: string | null;
  failedReason?: string | null;
  result?: { amount?: unknown } | null;
};

type RoiClaimStatusResponse = {
  claimedTodayPkt?: boolean;
  queue?: RoiQueueStatus | null;
} | null;

function getRoiQueueStatus(queue: RoiQueueStatus | null | undefined) {
  return String(queue?.status || "").toLowerCase();
}

function getRoiQueueState(queue: RoiQueueStatus | null | undefined) {
  return String(queue?.state || "").toLowerCase();
}

function isRoiQueueActive(queue: RoiQueueStatus | null | undefined) {
  const queueStatus = getRoiQueueStatus(queue);
  return queue?.queued === true || ROI_ACTIVE_STATUSES.has(queueStatus);
}

function isRoiTerminalFailure(queue: RoiQueueStatus | null | undefined) {
  const queueStatus = getRoiQueueStatus(queue);
  const queueState = getRoiQueueState(queue);
  return (
    queueStatus === "failed" &&
    !ROI_TRANSIENT_FAILED_STATES.has(queueState) &&
    !ROI_INACTIVE_CONFIRMED_STATES.has(queueState)
  );
}

function isRoiInactiveConfirmed(queue: RoiQueueStatus | null | undefined) {
  const queueState = getRoiQueueState(queue);
  return ROI_INACTIVE_CONFIRMED_STATES.has(queueState);
}

const VIP_STAT_VARIANTS = {
  balance: {
    ring: "border-emerald-400/45 shadow-[0_0_0_1px_rgba(52,211,153,0.22),0_0_28px_-6px_rgba(16,185,129,0.55),inset_0_1px_0_rgba(255,255,255,0.07)]",
    iconWrap:
      "border-emerald-400/35 bg-emerald-500/15 text-emerald-200 shadow-[0_0_14px_rgba(52,211,153,0.35)]",
    valueClass: "text-emerald-100",
  },
  plan: {
    ring: "border-violet-400/45 shadow-[0_0_0_1px_rgba(167,139,250,0.22),0_0_28px_-6px_rgba(139,92,246,0.5),inset_0_1px_0_rgba(255,255,255,0.07)]",
    iconWrap:
      "border-violet-400/35 bg-violet-500/15 text-violet-200 shadow-[0_0_14px_rgba(167,139,250,0.35)]",
    valueClass: "text-violet-100",
  },
  teamRoi: {
    ring: "border-sky-400/45 shadow-[0_0_0_1px_rgba(56,189,248,0.22),0_0_28px_-6px_rgba(14,165,233,0.48),inset_0_1px_0_rgba(255,255,255,0.07)]",
    iconWrap:
      "border-sky-400/35 bg-sky-500/15 text-sky-200 shadow-[0_0_14px_rgba(56,189,248,0.35)]",
    valueClass: "text-sky-100",
  },
  firstBonus: {
    ring: "border-amber-400/45 shadow-[0_0_0_1px_rgba(251,191,36,0.22),0_0_28px_-6px_rgba(245,158,11,0.45),inset_0_1px_0_rgba(255,255,255,0.07)]",
    iconWrap:
      "border-amber-400/35 bg-amber-500/15 text-amber-200 shadow-[0_0_14px_rgba(251,191,36,0.32)]",
    valueClass: "text-amber-100",
  },
} as const;

type VipStatVariant = keyof typeof VIP_STAT_VARIANTS;

const DashboardRoiSection = dynamic(
  () => import("../../../components/dashboard/DashboardRoiSection"),
  {
    loading: () => <RoiBlockSkeleton cardClass={CARD} />,
    ssr: false,
  },
);

function StatTilesSkeleton() {
  return (
    <div
      className="mt-3 grid grid-cols-2 gap-1.5 sm:mt-4 sm:gap-2"
      aria-busy
      aria-label="Loading stats"
    >
      {[1, 2, 3, 4].map((i) => (
        <div
          key={i}
          className="flex min-h-[4.25rem] items-center gap-2 rounded-xl border border-white/10 bg-white/[0.06] p-2 backdrop-blur-xl sm:min-h-[4.5rem] sm:gap-2.5 sm:p-2.5"
        >
          <div className="h-8 w-8 shrink-0 animate-pulse rounded-lg bg-white/10 sm:h-9 sm:w-9" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="h-2 w-[52%] max-w-[5.75rem] animate-pulse rounded bg-white/10" />
            <div className="h-4 w-[68%] max-w-[7rem] animate-pulse rounded bg-white/10" />
          </div>
        </div>
      ))}
    </div>
  );
}

function RoiBlockSkeleton({ cardClass }: { cardClass: string }) {
  return (
    <div className={`${cardClass} mt-5 animate-pulse p-4 shadow-none sm:p-5`} aria-busy aria-label="Loading ROI">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="h-5 w-32 rounded bg-white/15" />
        <div className="h-12 w-full rounded-2xl bg-white/10 sm:w-36" />
      </div>
    </div>
  );
}

export default function Dashboard() {
  const router = useRouter();

  const [roiLoading, setRoiLoading] = useState(false);
  const [roiCelebrationUsd, setRoiCelebrationUsd] = useState<number | null>(null);
  const [roiPendingJobId, setRoiPendingJobId] = useState<string | null>(null);
  const [roiPollingStartedAt, setRoiPollingStartedAt] = useState<number | null>(null);
  const [roiClaimSucceeded, setRoiClaimSucceeded] = useState(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const roiClaimInFlightRef = useRef(false);
  const roiPollInFlightRef = useRef(false);
  const roiLastStatusRef = useRef<string | null>(null);
  const roiPollErrorCountRef = useRef(0);
  const roiRewardBeforeClaimRef = useRef<number | null>(null);
  const roiSuccessHandledRef = useRef(false);
  const isMountedRef = useRef(true);

  const {
    data: bundle,
    mutate: mutateDashboardBundle,
    isLoading: loadingBundle,
  } = useSWR(DASHBOARD_MAIN_BUNDLE_KEY, fetchDashboardMainBundleSWR, hybridDashboardSWRConfig);

  const user = bundle?.user;
  const hybrid = bundle?.hybrid;
  const loadingStats = loadingBundle && !bundle;

  useEffect(() => {
    if (typeof document !== "undefined" && document.hidden) return;
    if (hybrid || user) setLastUpdatedAt(Date.now());
  }, [hybrid, user]);

  const depositUsd = Number(hybrid?.depositBalance ?? 0);
  const rewardUsd = Number(hybrid?.rewardBalance ?? 0);
  const totalBalanceUsd = depositUsd + rewardUsd;
  const stakingUsd = Number(hybrid?.activeStakeAmount ?? 0);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const stopRoiPolling = useCallback((reason: string) => {
    roiDebug("[roi] polling stopped", { reason, jobId: roiPendingJobId });
    roiPollInFlightRef.current = false;
    roiLastStatusRef.current = null;
    roiPollErrorCountRef.current = 0;
    if (!isMountedRef.current) return;
    setRoiPendingJobId(null);
    setRoiPollingStartedAt(null);
    setRoiLoading(false);
  }, [roiPendingJobId]);

  const refreshDashboardAfterRoi = useCallback(async (reason: string, creditedAmount?: number) => {
    roiDebug("[roi] balance refresh requested", { reason, jobId: roiPendingJobId });
    if (Number.isFinite(creditedAmount) && Number(creditedAmount) > 0) {
      await mutateDashboardBundle(
        (current: any) => {
          if (!current?.hybrid) return current;
          const rewardBalance = Number(current.hybrid.rewardBalance || 0);
          const totalEarnings = Number(current.hybrid.totalEarnings || 0);
          const todayProfit = Number(current.hybrid.todayProfit || 0);
          const amount = Number(creditedAmount);

          return {
            ...current,
            hybrid: {
              ...current.hybrid,
              rewardBalance: Number((rewardBalance + amount).toFixed(8)),
              totalEarnings: Number((totalEarnings + amount).toFixed(8)),
              todayProfit: Number((todayProfit + amount).toFixed(8)),
              canClaimRoi: false,
              claimedTodayPkt: true,
            },
          };
        },
        { revalidate: false },
      );
    }
    const refreshed = await mutateDashboardBundle();
    if (isMountedRef.current) {
      setLastUpdatedAt(Date.now());
    }
    return refreshed;
  }, [mutateDashboardBundle, roiPendingJobId]);

  const finishRoiClaim = useCallback(async (result: { amount?: unknown } | null, reason: string) => {
    if (roiSuccessHandledRef.current) return;
    roiSuccessHandledRef.current = true;

    const rawAmt = result && result.amount !== undefined ? Number(result.amount) : NaN;
    const creditedAmount = Number.isFinite(rawAmt) && rawAmt > 0 ? rawAmt : undefined;
    const refreshed = await refreshDashboardAfterRoi(reason, creditedAmount);
    const previousReward = roiRewardBeforeClaimRef.current;
    const refreshedReward = Number(refreshed?.hybrid?.rewardBalance ?? NaN);
    const actualDelta =
      previousReward != null && Number.isFinite(refreshedReward)
        ? Number((refreshedReward - previousReward).toFixed(8))
        : NaN;
    const displayAmount =
      creditedAmount ?? (Number.isFinite(actualDelta) && actualDelta > 0 ? actualDelta : null);

    if (isMountedRef.current) {
      if (displayAmount != null) {
        setRoiCelebrationUsd(displayAmount);
      }
      setRoiClaimSucceeded(true);
    }
    roiRewardBeforeClaimRef.current = null;
    stopRoiPolling(reason);
  }, [refreshDashboardAfterRoi, stopRoiPolling]);

  useEffect(() => {
    if (!roiPendingJobId || !roiPollingStartedAt) return;

    let cancelled = false;

    const pollOnce = async () => {
      if (cancelled || roiPollInFlightRef.current) return;
      const elapsedMs = Date.now() - roiPollingStartedAt;

      roiPollInFlightRef.current = true;
      try {
        const status = (await fetchRoiClaimStatus(roiPendingJobId)) as RoiClaimStatusResponse;
        if (cancelled || !isMountedRef.current) return;

        roiPollErrorCountRef.current = 0;
        const queue = status?.queue;
        const queueStatus = getRoiQueueStatus(queue);

        if (roiLastStatusRef.current !== queueStatus) {
          roiDebug("[roi] status changed", {
            jobId: roiPendingJobId,
            previous: roiLastStatusRef.current,
            next: queueStatus || "unknown",
          });
          roiLastStatusRef.current = queueStatus;
        }
        if (queueStatus === "completed" || status?.claimedTodayPkt === true) {
          await finishRoiClaim(queue?.result || null, "completed");
          return;
        }

        if (isRoiTerminalFailure(queue)) {
          showToast("error", ROI_FAILURE_MSG);
          await refreshDashboardAfterRoi("failed");
          stopRoiPolling("failed");
          return;
        }

        if (elapsedMs >= ROI_POLL_MAX_ELAPSED_MS) {
          roiDebug("[roi] polling timeout confirmation", {
            jobId: roiPendingJobId,
            elapsedMs,
            status: queueStatus || "unknown",
            state: getRoiQueueState(queue) || "unknown",
            active: isRoiQueueActive(queue),
          });

          if (isRoiInactiveConfirmed(queue)) {
            await refreshDashboardAfterRoi("inactive_after_timeout");
            if (!cancelled && isMountedRef.current) {
              showToast("error", ROI_FAILURE_MSG);
              stopRoiPolling("inactive_after_timeout");
            }
          }
        }
      } catch (err) {
        const raw = getMessage(err, ROI_FAILURE_MSG);
        roiDebug("[roi] status poll failed", {
          jobId: roiPendingJobId,
          message: raw,
          attempt: roiPollErrorCountRef.current + 1,
        });
        if (cancelled || !isMountedRef.current) return;
        roiPollErrorCountRef.current += 1;
      } finally {
        roiPollInFlightRef.current = false;
      }
    };

    roiDebug("[roi] polling started", { jobId: roiPendingJobId });
    void pollOnce();
    const id = window.setInterval(() => {
      void pollOnce();
    }, ROI_POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [
    finishRoiClaim,
    refreshDashboardAfterRoi,
    roiPendingJobId,
    roiPollingStartedAt,
    stopRoiPolling,
  ]);

  useEffect(() => {
    if (!roiPendingJobId || !roiLoading || hybrid?.claimedTodayPkt !== true) return;
    void finishRoiClaim(null, "balance_snapshot_claimed");
  }, [finishRoiClaim, hybrid?.claimedTodayPkt, roiLoading, roiPendingJobId]);

  useEffect(() => {
    if (hybrid?.canClaimRoi === true && !roiLoading && !roiPendingJobId) {
      setRoiClaimSucceeded(false);
    }
  }, [hybrid?.canClaimRoi, roiLoading, roiPendingJobId]);

  const handleClaimRoi = async () => {
    if (roiClaimInFlightRef.current || roiPendingJobId || roiLoading || hybrid?.canClaimRoi !== true) return;
    roiClaimInFlightRef.current = true;
    let queuedStarted = false;
    try {
      setRoiLoading(true);
      setRoiClaimSucceeded(false);
      setRoiCelebrationUsd(null);
      roiSuccessHandledRef.current = false;
      roiRewardBeforeClaimRef.current = rewardUsd;
      roiPollErrorCountRef.current = 0;
      const queued = (await claimHybridRoi()) as {
        amount?: unknown;
        queued?: boolean;
        jobId?: string;
      } | null;
      if (queued?.queued === true) {
        if (!queued.jobId) throw new Error("ROI claim queued without job id");
        roiDebug("[roi] claim queued", { jobId: queued.jobId });
        queuedStarted = true;
        setRoiPendingJobId(queued.jobId);
        setRoiPollingStartedAt(Date.now());
        return;
      }
      await finishRoiClaim(queued, "sync_completed");
    } catch (err: any) {
      const raw = getMessage(err, "Could not claim ROI");
      const msg =
        err?.response?.status === 403 || /not allowed|forbidden/i.test(raw)
          ? "Action not allowed"
          : ROI_FAILURE_MSG;
      showToast("error", msg);
      roiRewardBeforeClaimRef.current = null;
      roiSuccessHandledRef.current = false;
      stopRoiPolling("claim_failed");
    } finally {
      roiClaimInFlightRef.current = false;
      if (!queuedStarted && !roiPendingJobId) {
        setRoiLoading(false);
      }
    }
  };

  const dismissRoiCelebration = useCallback(() => {
    setRoiCelebrationUsd(null);
  }, []);

  return (
    <ProtectedRoute>
      <PageWrapper
        loading={false}
        data={loadingBundle ? true : user?._id}
        emptyText="No data available"
      >
        <div className="relative w-full max-w-full overflow-x-hidden px-1 pb-24 text-white sm:px-0">
          <header className="relative z-10 flex flex-col gap-3 transition-opacity duration-300 ease-out sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h1 className="text-lg font-bold tracking-tight text-white sm:text-xl">Smart Income Dashboard</h1>
            </div>
            <LiveRefreshIndicator lastUpdatedAt={lastUpdatedAt} className="sm:pt-1" />
          </header>

          <RewardNotification lastLogin={user?.lastLogin ?? user?.createdAt} />

          {loadingStats ? (
            <StatTilesSkeleton />
          ) : (
            <div className="mt-3 grid grid-cols-2 gap-1.5 sm:mt-4 sm:gap-2">
              <VipStatTile
                variant="balance"
                label="Total Balance"
                value={formatUsd(totalBalanceUsd)}
                animatedValue={totalBalanceUsd}
                live={roiClaimSucceeded}
              />
              <VipStatTile
                variant="plan"
                label="Active Plan"
                value={formatUsd(stakingUsd)}
                animatedValue={stakingUsd}
              />
              <VipStatTile
                variant="teamRoi"
                label="Team ROI Income"
                value={formatUsd(Number(hybrid?.teamRoiIncome ?? 0))}
                animatedValue={Number(hybrid?.teamRoiIncome ?? 0)}
              />
              <VipStatTile
                variant="firstBonus"
                label="First Deposit Bonus"
                value={formatUsd(Number(hybrid?.firstDepositBonusEarned ?? 0))}
                animatedValue={Number(hybrid?.firstDepositBonusEarned ?? 0)}
              />
            </div>
          )}

          {loadingStats ? (
            <RoiBlockSkeleton cardClass={CARD} />
          ) : (
            <DashboardRoiSection
              cardClass={CARD}
              hybrid={hybrid}
              roiLoading={roiLoading}
              handleClaimRoi={handleClaimRoi}
              celebrationUsd={roiCelebrationUsd}
              onCelebrationDismiss={dismissRoiCelebration}
            />
          )}

          <div className="mt-4 grid grid-cols-2 gap-2 sm:mt-5 sm:grid-cols-4 sm:gap-3">
            <QuickAction label="Deposit" icon="↓" onClick={() => router.push("/deposit")} />
            <QuickAction label="Withdraw" icon="↑" onClick={() => router.push("/withdraw")} />
            <QuickAction label="Stake" icon="◆" onClick={() => router.push("/staking")} />
            <QuickAction label="Team" icon="👥" onClick={() => router.push("/team")} />
          </div>
        </div>
      </PageWrapper>
    </ProtectedRoute>
  );
}

function VipStatIcon({ variant }: { variant: VipStatVariant }) {
  const cls = "h-[15px] w-[15px] sm:h-4 sm:w-4";
  switch (variant) {
    case "balance":
      return (
        <svg className={cls} viewBox="0 0 24 24" fill="none" aria-hidden>
          <path
            d="M12 4v16M8 8h8a3 3 0 0 1 0 6H8a3 3 0 0 1 0-6Z"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "plan":
      return (
        <svg className={cls} viewBox="0 0 24 24" fill="none" aria-hidden>
          <path
            d="M7 16V8l5-3 5 3v8l-5 3-5-3Z"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinejoin="round"
          />
          <path d="M12 5v14" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
        </svg>
      );
    case "teamRoi":
      return (
        <svg className={cls} viewBox="0 0 24 24" fill="none" aria-hidden>
          <path
            d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm10 2a4 4 0 0 0 2-7.5M21 21v-2a4 4 0 0 0-3-3.87"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "firstBonus":
      return (
        <svg className={cls} viewBox="0 0 24 24" fill="none" aria-hidden>
          <path
            d="M4 10h16v10a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V10Z"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinejoin="round"
          />
          <path d="M12 10v12M4 14h16" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
          <path
            d="M12 10a3.5 3.5 0 0 0 0-7c-1.7 0-3 1.2-3.5 3M12 10a3.5 3.5 0 0 1 0-7c1.7 0 3 1.2 3.5 3"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
          />
        </svg>
      );
    default:
      return null;
  }
}

function AnimatedCurrency({ value, className, title }: { value: number; className: string; title: string }) {
  const motionValue = useMotionValue(value);
  const springValue = useSpring(motionValue, {
    stiffness: 130,
    damping: 24,
    mass: 0.65,
  });
  const [display, setDisplay] = useState(formatUsd(value));

  useMotionValueEvent(springValue, "change", (latest) => {
    setDisplay(formatUsd(latest));
  });

  useEffect(() => {
    motionValue.set(value);
  }, [motionValue, value]);

  return (
    <motion.p className={className} title={title}>
      {display}
    </motion.p>
  );
}

function VipStatTile({
  variant,
  label,
  value,
  animatedValue,
  live = false,
}: {
  variant: VipStatVariant;
  label: string;
  value: string;
  animatedValue?: number;
  live?: boolean;
}) {
  const v = VIP_STAT_VARIANTS[variant];
  return (
    <div
      className={`group relative flex min-h-[4.25rem] min-w-0 items-center gap-2 overflow-hidden rounded-xl border bg-white/[0.06] p-2 backdrop-blur-xl transition duration-300 ease-out hover:-translate-y-0.5 hover:brightness-[1.06] active:scale-[0.99] sm:min-h-[4.5rem] sm:gap-2.5 sm:p-2.5 ${v.ring} ${
        live ? "shadow-[0_0_0_1px_rgba(52,211,153,0.28),0_0_34px_-4px_rgba(16,185,129,0.65)]" : ""
      }`}
    >
      {live ? (
        <motion.span
          className="pointer-events-none absolute inset-y-0 -left-1/2 w-1/2 bg-gradient-to-r from-transparent via-emerald-200/15 to-transparent"
          animate={{ x: ["0%", "310%"] }}
          transition={{ duration: 1.6, repeat: Infinity, ease: "easeInOut" }}
          aria-hidden
        />
      ) : null}
      <div
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border backdrop-blur-sm transition duration-300 group-hover:scale-105 sm:h-9 sm:w-9 ${v.iconWrap}`}
        aria-hidden
      >
        <VipStatIcon variant={variant} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-[9px] font-semibold uppercase leading-tight tracking-[0.08em] text-white/55 sm:text-[10px] sm:tracking-[0.1em]">
          {label}
        </p>
        {typeof animatedValue === "number" && Number.isFinite(animatedValue) ? (
          <AnimatedCurrency
            value={animatedValue}
            className={`mt-0.5 truncate text-sm font-extrabold leading-none tabular-nums sm:text-[0.9375rem] ${v.valueClass}`}
            title={value}
          />
        ) : (
          <p
            className={`mt-0.5 truncate text-sm font-extrabold leading-none tabular-nums sm:text-[0.9375rem] ${v.valueClass}`}
            title={value}
          >
            {value}
          </p>
        )}
      </div>
    </div>
  );
}

function QuickAction({
  label,
  icon,
  onClick,
  disabled = false,
}: {
  label: string;
  icon: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      aria-disabled={disabled}
      className={`min-h-[48px] w-full rounded-2xl border border-white/10 bg-white/5 p-2 text-center backdrop-blur-xl transition duration-300 ease-out sm:min-h-[52px] sm:p-2.5 ${
        disabled
          ? "cursor-not-allowed opacity-45 hover:border-white/10 hover:brightness-100"
          : "hover:border-emerald-500/35 hover:brightness-105 active:scale-[0.99]"
      }`}
    >
      <div className="mx-auto mb-1 flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-emerald-500 to-green-400 text-sm font-black text-gray-950 shadow-[0_2px_10px_rgba(16,185,129,0.28)]">
        {icon}
      </div>
      <p className="text-[9px] font-semibold uppercase tracking-[0.12em] text-gray-400">{label}</p>
    </button>
  );
}
