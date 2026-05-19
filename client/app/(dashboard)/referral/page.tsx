"use client";

import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import API, { normalize } from "../../../lib/api";
import ProtectedRoute from "../../../components/ProtectedRoute";
import PageWrapper from "../../../components/PageWrapper";
import { fetchCurrentUser } from "../../../lib/session";
import { showToast, getMessage } from "../../../lib/vipToast";
import { claimHybridSalary, fetchHybridSummary, fetchSalaryProgress } from "../../../lib/hybrid";
import GradientButton from "../../../components/GradientButton";

/** Mirrors server `SALARY_RULES` — stage-based fresh counts (stage 1 removed) */
const SALARY_UI_STAGES = [
  { level: 2, direct: 10, team: 35, reward: 80 },
  { level: 3, direct: 25, team: 100, reward: 250 },
  { level: 4, direct: 45, team: 150, reward: 500 },
] as const;

export default function Referral() {
  const [copied, setCopied] = useState(false);
  const [stats, setStats] = useState<any>(null);
  const [user, setUser]: any = useState(null);
  const [hybrid, setHybrid] = useState<any>(null);
  const [salaryProgress, setSalaryProgress] = useState<any>(null);
  const [salaryLoading, setSalaryLoading] = useState(false);
  const [pageLoading, setPageLoading] = useState(true);

  useEffect(() => {
    const loadStats = async () => {
      try {
        const [fresh, res, hybridData, salaryData] = await Promise.all([
          fetchCurrentUser(),
          API.get("/user/referral-stats"),
          fetchHybridSummary().catch(() => null),
          fetchSalaryProgress().catch(() => null),
        ]);
        if (fresh) setUser(fresh);
        const response = normalize(res.data);
        const payload =
          response.data && typeof response.data === "object" && Object.keys(response.data).length
            ? response.data
            : null;
        setStats(payload);
        setHybrid(hybridData);
        setSalaryProgress(salaryData);
      } catch (err: any) {
        showToast("error", getMessage(err, "Could not load referral data"));
      } finally {
        setPageLoading(false);
      }
    };
    loadStats();
  }, []);

  const origin =
    typeof window !== "undefined" ? window.location.origin : "http://localhost:3000";
  const link = `${origin}/signup?ref=${stats?.referralCode || user?.referralCode || ""}`;

  const copyLink = async () => {
    await navigator.clipboard.writeText(link);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const directFresh = Number(salaryProgress?.direct ?? 0);
  const teamFresh = Number(salaryProgress?.team ?? 0);

  /** Next milestone index for progress bar — first unclaimed */
  const backendClaimableStage = Number(salaryProgress?.claimableStage ?? 0);

  const claimedStages = useMemo(
    () => [...(salaryProgress?.claimedSalaryStages ?? [])].map(Number),
    [salaryProgress?.claimedSalaryStages],
  );

  const nextStage =
    SALARY_UI_STAGES.find((s) => !claimedStages.includes(s.level)) ?? null;

  const salaryComplete = salaryProgress?.salaryComplete === true;

  const handleClaimStage = async (stageLevel: number) => {
    const canPay =
      backendClaimableStage === stageLevel &&
      backendClaimableStage > 0 &&
      !salaryLoading;
    if (!canPay) return;

    try {
      setSalaryLoading(true);
      await claimHybridSalary();
      showToast("success", "Salary reward claimed");
      const [hybridData, salaryData] = await Promise.all([
        fetchHybridSummary().catch(() => null),
        fetchSalaryProgress().catch(() => null),
      ]);
      if (hybridData) setHybrid(hybridData);
      if (salaryData) setSalaryProgress(salaryData);
    } catch (err: any) {
      const raw = getMessage(err, "Could not claim salary");
      const msg =
        err?.response?.status === 403 || /not allowed|forbidden/i.test(raw)
          ? "Action not allowed"
          : raw;
      showToast("error", msg);
    } finally {
      setSalaryLoading(false);
    }
  };

  const salaryStagesUi = useMemo(
    () =>
      SALARY_UI_STAGES.map((stage) => {
        const isUnlocked = directFresh >= stage.direct && teamFresh >= stage.team;
        const isClaimed = claimedStages.includes(stage.level);
        const isNext = backendClaimableStage === stage.level;

        return {
          ...stage,
          isUnlocked,
          isClaimed,
          isNext,
        };
      }),
    [directFresh, teamFresh, claimedStages, backendClaimableStage],
  );

  const salaryClaimable = backendClaimableStage > 0;

  /** Totals shown in stat grid remain full-network referral stats */
  const statsDirect = Number(stats?.directCount ?? 0);
  const statsTeam = Number(stats?.teamCount ?? 0);

  return (
    <ProtectedRoute>
      <PageWrapper loading={pageLoading} skipEmpty>
        <div className="min-h-screen max-w-[420px] mx-auto px-4 py-6 pb-24 text-white relative bg-[#040406] overflow-x-hidden w-full">
          <div className="absolute w-[500px] h-[500px] bg-purple-600 opacity-20 blur-[150px] top-[-150px] left-[-150px]" />
          <div className="absolute w-[500px] h-[500px] bg-indigo-600 opacity-20 blur-[150px] bottom-[-150px] right-[-150px]" />

          <h1 className="text-xl font-bold mb-6 bg-gradient-to-r from-purple-400 to-indigo-400 bg-clip-text text-transparent">
            HybridEarn Referral
          </h1>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 mb-5">
            <motion.div
              initial={{ opacity: 0, y: 30 }}
              animate={{ opacity: 1, y: 0 }}
              className="bg-white/5 p-5 rounded-2xl border border-white/10 text-center"
            >
              <p className="text-xs text-gray-400">Team ROI income</p>
              <h2 className="text-2xl font-bold text-emerald-400 mt-1 tabular-nums">
                $
                {Number(hybrid?.teamRoiIncome ?? stats?.teamRoiIncome ?? 0).toFixed(2)}
              </h2>
              <p className="mt-2 text-[10px] text-gray-500">From L1–L3 when downlines claim daily ROI</p>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, y: 30 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.05 }}
              className="bg-white/5 p-5 rounded-2xl border border-white/10 text-center"
            >
              <p className="text-xs text-gray-400">First deposit bonus</p>
              <h2 className="text-2xl font-bold text-lime-300 mt-1 tabular-nums">
                $
                {Number(hybrid?.firstDepositBonusEarned ?? stats?.firstDepositBonusEarned ?? 0).toFixed(2)}
              </h2>
              <p className="mt-2 text-[10px] text-gray-500">One-time fixed reward per direct when they first deposit</p>
            </motion.div>
          </div>

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.08 }}
            className="bg-white/[0.03] p-4 rounded-2xl border border-white/10 mb-5 text-center"
          >
            <p className="text-[10px] uppercase tracking-wider text-gray-500">Total referral rewards</p>
            <p className="text-lg font-bold text-green-400 tabular-nums mt-1">
              $
              {Number(hybrid?.referralEarnings ?? stats?.referralEarnings ?? user?.referralEarnings ?? 0).toFixed(2)}
            </p>
          </motion.div>

          <div className="p-[1px] rounded-2xl bg-gradient-to-r from-purple-500 to-indigo-500 mb-5">
            <div className="bg-[#0b0b0f] p-4 rounded-2xl">
              <p className="text-sm text-gray-400 mb-2">Your Referral Link</p>

              <div className="bg-black/40 p-3 rounded-xl border border-white/10 text-xs break-all">{link}</div>

              <GradientButton onClick={copyLink} className="mt-3 w-full rounded-xl p-3">
                {copied ? "Copied ✅" : "Copy Link"}
              </GradientButton>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Stat title="Team Count" value={statsTeam} />
            <Stat title="Direct Count" value={statsDirect} />
            <Stat title="Team ROI volume" value={`$${Number(stats?.teamVolume || 0).toFixed(2)}`} />
            <Stat title="Referral Code" value={stats?.referralCode || user?.referralCode || "-"} />
          </div>

          <div className="grid grid-cols-2 gap-3 mt-3">
            <Stat title="Hybrid Level" value={hybrid?.level || 0} />
            <Stat title="ROI Rate" value={`${(Number(hybrid?.roiRate || 0) * 100).toFixed(2)}%`} />
          </div>

          <div className="mt-5 p-[1px] rounded-2xl bg-gradient-to-r from-yellow-400/70 via-purple-500/70 to-cyan-400/70">
            <div className="rounded-2xl bg-[#08080d]/95 p-4 backdrop-blur-2xl">
              <p className="text-sm font-semibold text-white">Team ROI income</p>
              <p className="mt-2 text-xs leading-relaxed text-gray-400">
                When your direct team claims daily ROI, you earn L1–L3 percentages (10% / 6% / 5%) of their claimed ROI
                amount. Figures reflect your live HybridEarn account only.
              </p>
            </div>
          </div>

          <div className="mt-5 p-[1px] rounded-2xl bg-gradient-to-r from-lime-400/50 via-emerald-500/60 to-teal-500/50">
            <div className="rounded-2xl bg-[#08080d]/95 p-4 backdrop-blur-2xl">
              <p className="text-sm font-semibold text-white">First deposit bonus (direct sponsors only)</p>
              <p className="mt-2 text-xs leading-relaxed text-gray-400">
                One-time reward when your direct downline completes their{" "}
                <span className="text-gray-300">first hybrid deposit</span> — slabs: 50 → $7 · 100 → $13 · 150 →
                $18 · 200 → $25 · <span className="text-gray-300">300+</span> → $35 USDT (fixed, not ROI-based).
              </p>
            </div>
          </div>

          <div className="mt-5 p-[1px] rounded-2xl bg-gradient-to-r from-yellow-300/80 via-purple-500/60 to-cyan-400/70">
            <div className="rounded-2xl bg-[#08080d]/95 p-4 backdrop-blur-2xl">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-[10px] uppercase tracking-[0.24em] text-yellow-200/80">Salary Rewards (HybridEarn)</p>
                  <h3 className="mt-1 text-lg font-black text-white">Stage milestones — fresh recruits</h3>
                </div>
                <span
                  className={`rounded-full border px-3 py-1 text-[10px] font-bold ${
                    salaryClaimable && !salaryComplete
                      ? "border-green-300/30 bg-green-400/10 text-green-200"
                      : salaryComplete
                        ? "border-blue-300/25 bg-blue-400/10 text-blue-200"
                        : "border-yellow-300/20 bg-yellow-400/10 text-yellow-200"
                  }`}
                >
                  {salaryComplete
                    ? "All stages claimed"
                    : salaryClaimable
                      ? "Reward ready"
                      : "In progress"}
                </span>
              </div>
              <p className="mt-3 text-xs text-gray-400">
                Salary uses fresh counts since your last claim: only recruits who joined after that time move you toward the
                next stage. Older team members stay in total stats above but do not repeat-count for salary.
              </p>
              {salaryProgress?.lastClaimedAt ? (
                <p className="mt-2 text-xs text-yellow-400">Fresh team required after last claim</p>
              ) : null}
              {nextStage && !salaryComplete ? (
                <div className="mt-4">
                  <p className="text-gray-400 text-xs">Next milestone {nextStage.team > 0 ? "(team pace)" : ""}</p>
                  <div className="mt-1.5 w-full bg-gray-700 h-2 rounded-full">
                    <div
                      className="bg-emerald-500 h-2 rounded-full transition-[width] duration-300"
                      style={{
                        width: `${Math.min((teamFresh / nextStage.team) * 100, 100)}%`,
                      }}
                    />
                  </div>
                  <p className="text-[11px] text-gray-500 mt-1.5 tabular-nums">
                    Team {teamFresh}/{nextStage.team}
                    {nextStage.direct > 0 ? ` · Direct ${directFresh}/${nextStage.direct}` : ""}
                  </p>
                </div>
              ) : null}
              <div className="mt-4 space-y-3">
                {salaryStagesUi.map((stage) => {
                  const borderClass = stage.isClaimed
                    ? "border-blue-400/80 bg-blue-500/10"
                    : stage.isUnlocked && stage.isNext && !salaryComplete
                      ? "border-emerald-400/70 bg-emerald-500/10"
                      : "border-white/10 bg-white/5";
                  const btnDisabled =
                    !stage.isUnlocked ||
                    stage.isClaimed ||
                    !stage.isNext ||
                    salaryLoading ||
                    salaryComplete;

                  return (
                    <div key={stage.level} className={`rounded-2xl border p-4 ${borderClass}`}>
                      <h2 className="text-base font-bold text-white">Stage {stage.level}</h2>
                      <p className="text-gray-400 text-xs mt-1">
                        Need direct {stage.direct} · team {stage.team}
                      </p>
                      <p className="text-emerald-400 font-bold mt-2">${stage.reward} USDT</p>
                      <p className="text-xs text-gray-400 mt-2 tabular-nums">
                        Direct: {directFresh}/{stage.direct}
                      </p>
                      <p className="text-xs text-gray-400 tabular-nums">Team: {teamFresh}/{stage.team}</p>
                      <button
                        type="button"
                        disabled={btnDisabled}
                        onClick={() => handleClaimStage(stage.level)}
                        className={`mt-3 w-full py-2 rounded-xl text-sm font-semibold text-white transition disabled:cursor-not-allowed disabled:opacity-60 ${
                          stage.isClaimed
                            ? "bg-blue-500"
                            : stage.isUnlocked && stage.isNext && !salaryComplete
                              ? "bg-emerald-500 hover:bg-emerald-400"
                              : "bg-gray-600"
                        }`}
                      >
                        {salaryComplete && stage.isClaimed
                          ? "Done"
                          : stage.isClaimed
                            ? "Claimed"
                            : stage.isUnlocked
                              ? stage.isNext
                                ? salaryLoading
                                  ? "Claiming…"
                                  : "Claim Salary"
                                : "Waiting"
                              : "Locked"}
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          <div className="mt-5 bg-white/5 p-4 rounded-2xl border border-white/10 text-sm">
            <p className="text-yellow-400 font-semibold mb-2">💡 How it works</p>

            <ul className="space-y-1 text-gray-400 text-xs">
              <li>• Share your referral link</li>
              <li>• Earn first deposit bonuses when directs fund for the first time (fixed slabs)</li>
              <li>• Earn team ROI income when downlines claim daily ROI</li>
              <li>• Get team bonuses daily</li>
              <li>• Build passive income network</li>
              <li>• Salary stages unlock on fresh recruits after each claim</li>
            </ul>
          </div>
        </div>
      </PageWrapper>
    </ProtectedRoute>
  );
}

function Stat({ title, value }: any) {
  return (
    <div className="bg-white/5 p-3 rounded-xl border border-white/10 text-center">
      <p className="text-[10px] text-gray-400">{title}</p>
      <h4 className="font-bold text-sm text-purple-400 mt-1">{value}</h4>
    </div>
  );
}
