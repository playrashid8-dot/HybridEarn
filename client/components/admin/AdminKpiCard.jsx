"use client";

const VARIANTS = {
  violet:
    "border-violet-500/35 bg-gradient-to-br from-violet-600/35 via-purple-900/20 to-transparent shadow-[0_0_40px_rgba(139,92,246,0.15)]",
  emerald:
    "border-emerald-500/30 bg-gradient-to-br from-emerald-600/30 via-emerald-900/15 to-transparent shadow-[0_0_40px_rgba(52,211,153,0.12)]",
  sky: "border-sky-500/30 bg-gradient-to-br from-sky-600/28 via-sky-900/15 to-transparent shadow-[0_0_40px_rgba(56,189,248,0.12)]",
  amber:
    "border-amber-500/40 bg-gradient-to-br from-amber-600/35 via-amber-900/20 to-transparent shadow-[0_0_40px_rgba(251,191,36,0.14)]",
};

export default function AdminKpiCard({ title, value, hint, variant = "violet" }) {
  const ring = VARIANTS[variant] || VARIANTS.violet;
  return (
    <div
      className={`rounded-2xl border p-6 sm:p-7 ${ring}`}
    >
      <p className="text-xs font-medium uppercase tracking-wider text-white/60">{title}</p>
      <p className="mt-3 text-3xl font-bold tabular-nums tracking-tight text-white sm:text-4xl">
        {value}
      </p>
      {hint ? <p className="mt-3 text-xs text-white/45">{hint}</p> : null}
    </div>
  );
}
