"use client";

const VIP_TOOLTIPS = {
  0: "Deposit to unlock VIP rewards and withdrawals",
  1: "Higher ROIs and monthly withdrawal quota",
  2: "Higher withdrawal limits and improved ROI tier",
  3: "Maximum tier perks, quotas, and priority treatment",
};

/** @param {{ level?: number | string; className?: string; showGlow?: boolean }} props */
export default function VipBadge({ level = 0, className = "", showGlow = false }) {
  const n = Math.max(0, Math.min(99, Number(level) || 0));
  const tip = VIP_TOOLTIPS[n] ?? VIP_TOOLTIPS[3];

  return (
    <span
      title={tip}
      className={`group relative inline-flex cursor-help items-center rounded-full bg-gradient-to-r from-yellow-400 to-orange-500 px-2.5 py-1 text-[10px] font-black uppercase tracking-wide text-gray-900 shadow-[0_0_20px_rgba(255,200,0,0.5)] ${
        showGlow ? "animate-pulse shadow-[0_0_28px_rgba(255,200,0,0.55)] ring-2 ring-amber-300/45" : ""
      } transition hover:brightness-105 ${className}`}
    >
      <span className="pointer-events-none absolute -inset-1 -z-10 rounded-full bg-gradient-to-r from-yellow-400/35 to-orange-500/25 opacity-70 blur-[6px]" aria-hidden />
      VIP {n}
    </span>
  );
}
