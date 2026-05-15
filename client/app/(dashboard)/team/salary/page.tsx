"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import ProtectedRoute from "../../../../components/ProtectedRoute";
import PageWrapper from "../../../../components/PageWrapper";
import LiveRefreshIndicator from "../../../../components/LiveRefreshIndicator";
import { fetchCurrentUser } from "../../../../lib/session";
import { logout } from "../../../../lib/auth";
import { claimHybridSalary, fetchSalaryProgress } from "../../../../lib/hybrid";
import { showToast, getMessage } from "../../../../lib/vipToast";

const CARD = "rounded-2xl border border-white/10 bg-white/5 backdrop-blur-xl";
const GLOW = "shadow-[0_0_25px_rgba(16,185,129,0.35)]";

type RuleRow = {
  stage: number;
  directCount: number;
  teamCount: number;
  amount: number;
};

type HistoryRow = { stage?: number; amount?: number; claimedAt?: string | null };

export default function TeamSalaryPage() {
  const [user, setUser] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [salaryPayload, setSalaryPayload] = useState<any>(null);
  const [claiming, setClaiming] = useState<number | null>(null);
  const [historyShown, setHistoryShown] = useState(12);
  const [syncedAt, setSyncedAt] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const data = await fetchCurrentUser();
      if (!data) throw new Error("No user data");
      setUser(data);
      const sal = await fetchSalaryProgress();
      setSalaryPayload(sal);
      setSyncedAt(Date.now());
    } catch (err: any) {
      showToast("error", getMessage(err, "Session expired. Please sign in again."));
      logout("silent");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    setHistoryShown(12);
  }, [salaryPayload]);

  const direct = Number(salaryPayload?.direct ?? 0);
  const team = Number(salaryPayload?.team ?? 0);
  const lastClaimedAtRaw = salaryPayload?.lastClaimedAt;
  const claimableStage = Number(salaryPayload?.claimableStage ?? 0);
  const claimingLoading = claiming !== null;
  const claimedStages: number[] = useMemo(
    () =>
      [...(salaryPayload?.claimedSalaryStages ?? [])]
        .map((n: unknown) => Number(n))
        .filter((n) => Number.isFinite(n)),
    [salaryPayload]
  );

  const loadingHistory = false;
  const stages: RuleRow[] = useMemo(() => {
    const r = salaryPayload?.rules;
    return Array.isArray(r) ? r : [];
  }, [salaryPayload]);

  const history: HistoryRow[] = useMemo(
    () =>
      [...(salaryPayload?.salaryHistory ?? [])].sort((a: HistoryRow, b: HistoryRow) => {
        const ta = new Date(a.claimedAt || 0).getTime();
        const tb = new Date(b.claimedAt || 0).getTime();
        return tb - ta;
      }),
    [salaryPayload]
  );

  const hasMore = history.length > historyShown;

  const progressPct = useMemo(() => {
    if (!stages.length) return 0;
    const claimedCount = stages.filter((r) => claimedStages.includes(Number(r.stage))).length;
    return Math.min(100, (claimedCount / stages.length) * 100);
  }, [stages, claimedStages]);

  const formattedLastClaim = useMemo(
    () => (lastClaimedAtRaw ? new Date(lastClaimedAtRaw).toLocaleString() : null),
    [lastClaimedAtRaw]
  );

  const handleClaim = async (stageRule: RuleRow) => {
    const target = Number(stageRule.stage);
    if (claimableStage !== target) {
      showToast("error", "This stage cannot be claimed yet.");
      return;
    }
    if (direct < Number(stageRule.directCount) || team < Number(stageRule.teamCount)) {
      showToast("error", "Requirements not met for this stage.");
      return;
    }
    try {
      setClaiming(target);
      const res = await claimHybridSalary();
      if (!res || typeof res.stage !== "number") {
        throw new Error("Unexpected response");
      }
      showToast("success", "Salary reward claimed");
      await load();
    } catch (err: any) {
      const raw = getMessage(err, "Claim failed");
      const msg =
        err?.response?.status === 403 || /not allowed|forbidden/i.test(raw)
          ? "Action not allowed"
          : raw;
      showToast("error", msg);
    } finally {
      setClaiming(null);
    }
  };

  return (
    <ProtectedRoute>
      <PageWrapper loading={loading} data={user?._id} emptyText="No data available">
        <div className="relative w-full max-w-full overflow-x-hidden px-1 pb-24 text-white sm:px-0 sm:pb-24">
          <motion.header
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            className="mb-6 flex flex-col gap-3 sm:mb-8 sm:flex-row sm:items-start sm:justify-between"
          >
            <div className="min-w-0">
              <Link
                href="/team"
                className="mb-1 inline-flex text-[10px] font-semibold uppercase tracking-wider text-emerald-300/90 transition duration-300 hover:text-emerald-200 hover:scale-[1.02] sm:mb-2"
              >
                ← Back to Team
              </Link>
              <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-gray-500">HybridEarn</p>
              <h1 className="text-lg font-bold tracking-tight text-white sm:text-2xl">Team salary</h1>
              <p className="mt-0.5 text-[11px] text-gray-400 sm:text-xs">Smart Income · Milestone rewards</p>
              <p className="mt-2 text-xs text-yellow-400">Active team only (≥ 50 USDT deposit)</p>
              <p className="mt-1 text-xs text-gray-400">Last claim: {formattedLastClaim || "Never"}</p>
            </div>
            <LiveRefreshIndicator lastUpdatedAt={syncedAt} className="shrink-0 sm:pt-1" />
          </motion.header>

          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            className={`mb-6 p-3 transition duration-300 hover:scale-[1.01] sm:p-4 ${CARD}`}
          >
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-gray-400">Progress</p>
            <div className="mt-3 w-full h-2 bg-gray-800 rounded-full overflow-hidden">
              <div
                className="h-full bg-emerald-500 transition-all duration-500 ease-out"
                style={{ width: `${progressPct}%` }}
              />
            </div>
            <div className="mt-4 grid grid-cols-2 gap-2 sm:gap-3">
              <div className="rounded-xl border border-white/10 bg-black/25 px-3 py-2.5 backdrop-blur-sm">
                <p className="text-[10px] text-gray-400 sm:text-xs">Direct (window)</p>
                <p className="mt-1 text-lg font-bold tabular-nums text-white sm:text-xl">{direct}</p>
              </div>
              <div className="rounded-xl border border-white/10 bg-black/25 px-3 py-2.5 backdrop-blur-sm">
                <p className="text-[10px] text-gray-400 sm:text-xs">Team (window)</p>
                <p className="mt-1 text-lg font-bold tabular-nums text-white sm:text-xl">{team}</p>
              </div>
            </div>
          </motion.div>

          <motion.section initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-3 sm:space-y-4">
            {stages.map((rule) => {
              const unlocked = direct >= Number(rule.directCount) && team >= Number(rule.teamCount);
              const stageNum = Number(rule.stage);
              const currentStageMarker = Number(claimableStage);
              const isClaimed = claimedStages.includes(stageNum);
              const isCurrent = unlocked && currentStageMarker !== 0 && stageNum === currentStageMarker;
              const canClaim = unlocked && isCurrent && !isClaimed && !claimingLoading;

              const cardStyle = isClaimed
                ? "bg-blue-500/10 border-blue-400/80"
                : canClaim || (isCurrent && !isClaimed && claimingLoading)
                  ? `bg-emerald-500/10 border-emerald-400/80 ${GLOW}`
                  : "bg-white/5 border-white/10";

              return (
                <div
                  key={rule.stage}
                  className={`rounded-2xl border p-3 transition duration-300 hover:scale-[1.02] sm:p-4 ${cardStyle}`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <h2 className="text-base font-bold text-white sm:text-lg">Stage {rule.stage}</h2>
                      <p className="mt-1.5 text-[11px] text-gray-400 sm:text-xs">
                        Direct: {direct}/{rule.directCount}
                      </p>
                      <p className="text-[11px] text-gray-400 sm:text-xs">
                        Team: {team}/{rule.teamCount}
                      </p>
                    </div>
                    <p className="text-lg font-bold tabular-nums text-emerald-400 sm:text-xl">${rule.amount}</p>
                  </div>

                  <button
                    type="button"
                    disabled={!canClaim}
                    className={`mt-3 w-full rounded-xl py-2 text-sm font-semibold transition duration-300 sm:mt-4 sm:py-2.5 ${
                      canClaim
                        ? "bg-emerald-600 text-white hover:bg-emerald-500"
                        : "bg-gray-600 text-gray-300 cursor-not-allowed"
                    }`}
                    onClick={() => handleClaim(rule)}
                  >
                    {claimingLoading && isCurrent
                      ? "Processing…"
                      : isClaimed
                        ? "Claimed"
                        : canClaim
                          ? "Claim"
                          : "Locked"}
                  </button>
                </div>
              );
            })}
          </motion.section>

          <motion.section initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mt-8 space-y-3 sm:mt-10">
            <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-gray-400">History</p>

            {history.length === 0 && (
              <p className={`py-6 text-center text-sm text-gray-400 ${CARD} px-4`}>No salary claimed yet</p>
            )}

            {history.length > 0 ? (
              <div className={`space-y-0 divide-y divide-white/10 ${CARD} overflow-hidden p-0`}>
                {history.slice(0, historyShown).map((item, idx) => (
                  <div
                    key={`${item.stage}-${String(item.claimedAt ?? idx)}`}
                    className="flex flex-col gap-1 px-4 py-3 transition duration-300 hover:bg-white/[0.03] sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="flex items-center gap-3">
                      <span className="min-w-[3.5rem] text-sm font-semibold text-white">Stage {item.stage}</span>
                      <span className="text-[11px] tabular-nums text-gray-500">
                        {item.claimedAt
                          ? new Date(item.claimedAt).toLocaleString()
                          : "—"}
                      </span>
                    </div>
                    <span className="font-bold tabular-nums text-emerald-400">
                      ${Number(item.amount ?? 0).toFixed(2)}
                    </span>
                  </div>
                ))}
              </div>
            ) : null}

            {history.length > 0 ? (
              <div className="flex justify-center pt-1">
                <button
                  type="button"
                  disabled={!hasMore || loadingHistory}
                  onClick={() => setHistoryShown((s) => Math.min(s + 12, history.length))}
                  className={`rounded-xl px-6 py-2 text-sm transition duration-300 ${
                    hasMore && !loadingHistory
                      ? "text-gray-400 hover:text-gray-300 hover:scale-[1.02]"
                      : "cursor-not-allowed text-gray-600"
                  }`}
                >
                  {loadingHistory ? "Loading..." : "Load more"}
                </button>
              </div>
            ) : null}
          </motion.section>
        </div>
      </PageWrapper>
    </ProtectedRoute>
  );
}
