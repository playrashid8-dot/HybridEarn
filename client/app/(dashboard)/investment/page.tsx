"use client";

import { motion } from "framer-motion";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import ProtectedRoute from "../../../components/ProtectedRoute";
import PrimaryButton from "../../../components/PrimaryButton";
import GradientButton from "../../../components/GradientButton";
import GlassCard from "../../../components/GlassCard";
import ProgressBar from "../../../components/ProgressBar";
import CountdownTimer from "../../../components/CountdownTimer";
import { claimHybridStake, createHybridStake, fetchHybridSummary, fetchHybridStakes } from "../../../lib/hybrid";
import { showToast, getMessage } from "../../../lib/vipToast";
import PageSkeleton from "../../../components/Skeleton";

export default function Investment() {
  const router = useRouter();

  const [loadingPlan, setLoadingPlan] = useState<string | null>(null);
  const [selectedPlan, setSelectedPlan] = useState<any>(null);
  const [amount, setAmount] = useState("");
  const [hybrid, setHybrid]: any = useState(null);
  const [stakes, setStakes] = useState<any[]>([]);
  const [claimingStake, setClaimingStake] = useState<string | null>(null);
  const [pageLoading, setPageLoading] = useState(true);

  const plans = [
    { name: "7d", key: "stake-7", days: 7, roi: 1.3, color: "from-purple-500 to-indigo-500" },
    { name: "15d", key: "stake-15", days: 15, roi: 1.5, color: "from-blue-500 to-cyan-500" },
    { name: "30d", key: "stake-30", days: 30, roi: 1.8, color: "from-green-500 to-emerald-500" },
    { name: "60d", key: "stake-60", days: 60, roi: 2.2, color: "from-fuchsia-500 to-blue-500" },
  ];

  // 🔐 USER LOAD
  useEffect(() => {
    Promise.all([fetchHybridSummary(), fetchHybridStakes().catch(() => [])])
      .then(([hybridData, stakeData]) => {
        if (hybridData) setHybrid(hybridData);
        setStakes(stakeData || []);
      })
      .catch(() => {
        router.replace("/login");
      })
      .finally(() => setPageLoading(false));
  }, [router]);

  // 🚀 INVEST
  const confirmInvest = async () => {
    const amt = Number(amount);

    if (!amount.trim() || !Number.isFinite(amt) || amt <= 0) {
      showToast("error", "Enter a valid amount");
      return;
    }

    if (amt < 10) {
      showToast("error", "Minimum stake is $10");
      return;
    }

    if (amt > (Number(hybrid?.depositBalance ?? 0) + Number(hybrid?.rewardBalance ?? 0))) {
      return showToast("error", "Insufficient Hybrid balance");
    }

    try {
      setLoadingPlan(selectedPlan.key);
      const result = await createHybridStake({ amount: amt, planDays: selectedPlan.days });
      const stakeMsg =
        typeof (result as { msg?: string })?.msg === "string" && (result as { msg?: string }).msg?.trim()
          ? String((result as { msg?: string }).msg).trim()
          : "";
      showToast("success", stakeMsg || "Stake created successfully");

      setSelectedPlan(null);
      setAmount("");
      const [hybridData, stakeData] = await Promise.all([
        fetchHybridSummary().catch(() => null),
        fetchHybridStakes().catch(() => []),
      ]);
      if (hybridData) setHybrid(hybridData);
      setStakes(stakeData || []);

    } catch (err: unknown) {
      showToast("error", getMessage(err, "Something went wrong"));
    } finally {
      setLoadingPlan(null);
    }
  };

  const claimStake = async (stakeId: string) => {
    if (claimingStake) return;
    try {
      setClaimingStake(stakeId);
      const result = await claimHybridStake(stakeId);
      const claimMsg =
        typeof (result as { msg?: string })?.msg === "string" &&
        (result as { msg?: string }).msg?.trim()
          ? String((result as { msg?: string }).msg).trim()
          : "";
      showToast(
        "success",
        claimMsg || `Stake claimed: $${Number((result as { payout?: number })?.payout || 0).toFixed(2)}`,
      );
      const [hybridData, stakeData] = await Promise.all([
        fetchHybridSummary().catch(() => null),
        fetchHybridStakes().catch(() => []),
      ]);
      if (hybridData) setHybrid(hybridData);
      setStakes(stakeData || []);
    } catch (err: unknown) {
      showToast("error", getMessage(err, "Stake is not ready to claim"));
    } finally {
      setClaimingStake(null);
    }
  };

  if (pageLoading) {
    return (
      <ProtectedRoute>
        <div className="w-full px-3 pb-24 pt-2 sm:px-6" aria-busy aria-label="Loading investment">
          <PageSkeleton />
        </div>
      </ProtectedRoute>
    );
  }

  if (!hybrid) {
    return (
      <ProtectedRoute>
        <div className="min-h-screen max-w-[420px] mx-auto px-4 py-10 flex flex-col items-center justify-center bg-[#040406] text-gray-400">
          <p className="text-sm text-center">No data available</p>
          <button
            type="button"
            onClick={() => router.push("/dashboard")}
            className="mt-4 w-full max-w-xs rounded-xl bg-white/[0.08] border border-white/10 p-3 text-sm text-purple-200"
          >
            Back to dashboard
          </button>
        </div>
      </ProtectedRoute>
    );
  }

  return (
    <ProtectedRoute>
    <div className="min-h-screen max-w-[420px] mx-auto px-4 py-6 pb-24 text-white relative bg-[#040406] overflow-x-hidden w-full">
      {/* 🌌 BACKGROUND */}
      <div className="absolute w-[500px] h-[500px] bg-purple-600 opacity-20 blur-[150px] top-[-150px] left-[-150px]" />
      <div className="absolute w-[500px] h-[500px] bg-indigo-600 opacity-20 blur-[150px] bottom-[-150px] right-[-150px]" />

      {/* HEADER */}
      <div className="flex justify-between items-center mb-6 relative z-10">
        <h1 className="text-xl font-bold bg-gradient-to-r from-purple-400 to-indigo-400 bg-clip-text text-transparent">
          HybridEarn Staking
        </h1>

        <button
          type="button"
          onClick={() => router.push("/dashboard")}
          className="shrink-0 rounded-xl border border-white/10 bg-white/[0.06] px-4 py-3 text-sm text-purple-400 shadow-md transition hover:shadow-lg hover:bg-white/10 max-w-full"
        >
          Back
        </button>
      </div>

      {/* BALANCE */}
      <div className="bg-white/5 p-4 rounded-2xl border border-white/10 text-center mb-6">
        <p className="text-xs text-gray-400">Available Balance</p>
        <h2 className="text-3xl font-bold text-green-400">
          ${(Number(hybrid?.depositBalance || 0) + Number(hybrid?.rewardBalance || 0)).toFixed(2)}
        </h2>
      </div>

      <div className="space-y-4 relative z-10">

        {plans.map((plan) => (
          <motion.div
            key={plan.key}
            whileHover={{ scale: 1.03 }}
            className={`p-[1px] rounded-3xl bg-gradient-to-r ${plan.color} shadow-[0_0_35px_rgba(124,58,237,0.22)]`}
          >
            <div className="bg-[#0b0b0f]/95 p-5 rounded-3xl backdrop-blur-2xl">

              <div className="flex justify-between items-center">
                <h2 className="font-bold text-lg">{plan.name} Staking</h2>
                <span className="text-xs bg-white/10 px-2 py-1 rounded-lg">
                  {plan.days}D
                </span>
              </div>

              <p className="text-green-400 font-semibold mt-2 text-lg">
                {plan.roi}% / day
              </p>

              <p className="text-xs text-gray-400 mt-1">
                Total Return ≈ {(plan.roi * plan.days).toFixed(1)}%
              </p>

              {/* ROI BAR */}
              <div className="w-full bg-white/5 h-2 rounded-full mt-3 overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-purple-500 to-indigo-500"
                  style={{ width: `${plan.roi * 20}%` }}
                />
              </div>

              <GradientButton onClick={() => setSelectedPlan(plan)} className="mt-4 py-2">
                Stake Now
              </GradientButton>

            </div>
          </motion.div>
        ))}

      </div>

      <GlassCard glow="cyan" className="mt-6">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <p className="text-[10px] uppercase tracking-[0.24em] text-cyan-200/80">Active Stakes</p>
            <h3 className="text-lg font-black">Claim Center</h3>
          </div>
          <span className="rounded-full border border-cyan-300/20 bg-cyan-400/10 px-3 py-1 text-[10px] font-bold text-cyan-100">
            {stakes.filter((stake) => stake.status === "active").length} Active
          </span>
        </div>

        <div className="space-y-3">
          {stakes.length === 0 && (
            <p className="rounded-2xl border border-white/10 bg-black/30 p-4 text-center text-xs text-gray-500">
              No active stakes yet.
            </p>
          )}

          {stakes.slice(0, 5).map((stake) => {
            const ready = new Date(stake.endAt).getTime() <= Date.now() && stake.status === "active";
            const progress = Date.now() - new Date(stake.startAt).getTime();
            const total = new Date(stake.endAt).getTime() - new Date(stake.startAt).getTime();

            return (
              <div key={stake._id} className="rounded-2xl border border-white/10 bg-black/30 p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-bold text-white">{stake.planDays}d Stake</p>
                    <p className="text-xs text-gray-500">
                      ${Number(stake.amount || 0).toFixed(2)} + ${Number(stake.totalReward || 0).toFixed(2)}
                    </p>
                  </div>
                  <span className="rounded-full border border-white/10 bg-white/[0.06] px-3 py-1 text-[10px] text-gray-300">
                    {stake.status}
                  </span>
                </div>
                <ProgressBar value={progress} max={total} className="mt-3" />
                <div className="mt-3 grid grid-cols-2 gap-2 min-h-0">
                  <CountdownTimer targetTime={stake.endAt} label="Matures In" completeText="Ready" className="p-3 min-w-0" />
                  <GradientButton
                    onClick={() => claimStake(stake._id)}
                    disabled={!ready || claimingStake === stake._id}
                    loading={claimingStake === stake._id}
                    className="h-full min-h-[48px] rounded-xl py-3 text-xs shadow-lg hover:shadow-xl transition-shadow"
                  >
                    Claim
                  </GradientButton>
                </div>
              </div>
            );
          })}
        </div>
      </GlassCard>

      {/* 🔥 MODAL */}
      {selectedPlan && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center px-4 z-50">

          <motion.div
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="w-full max-w-sm p-[1px] rounded-2xl bg-gradient-to-r from-purple-500 to-indigo-500"
          >
            <div className="bg-[#0b0b0f] p-5 rounded-2xl">

              <h2 className="font-bold text-lg mb-2">
                Stake in {selectedPlan.name}
              </h2>

              <p className="text-xs text-gray-400 mb-3">
                HybridEarn Balance: ${(Number(hybrid?.depositBalance || 0) + Number(hybrid?.rewardBalance || 0)).toFixed(2)}
              </p>

              {/* QUICK AMOUNTS */}
              <div className="grid grid-cols-3 gap-2 mb-3">
                {[10, 50, 100].map((val) => (
                  <button
                    key={val}
                    onClick={() => setAmount(String(val))}
                    className="bg-white/5 p-2 rounded-lg text-xs"
                  >
                    ${val}
                  </button>
                ))}
              </div>

              <input
                type="number"
                placeholder="Enter Amount"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="w-full bg-white/5 border border-white/10 p-3 rounded-xl text-sm"
              />

              <div className="flex gap-2 mt-4">
                <button
                  onClick={() => setSelectedPlan(null)}
                  className="w-full bg-white/5 p-2 rounded-xl text-sm"
                >
                  Cancel
                </button>

                <PrimaryButton
                  onClick={() => confirmInvest()}
                  disabled={loadingPlan === selectedPlan.key}
                  loading={loadingPlan === selectedPlan.key}
                  className="flex-1 p-3 text-sm"
                >
                  Confirm
                </PrimaryButton>
              </div>

            </div>
          </motion.div>

        </div>
      )}

    </div>
    </ProtectedRoute>
  );
}