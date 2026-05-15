"use client";

export default function StatCard({
  title,
  value,
  hint,
  tone = "purple",
  className = "",
}: any) {
  const tones: any = {
    purple: "from-purple-400/25 via-fuchsia-400/10 to-blue-400/10 text-purple-100",
    cyan: "from-cyan-400/25 via-blue-400/10 to-purple-400/10 text-cyan-100",
    green: "from-emerald-400/20 via-green-400/10 to-cyan-400/10 text-emerald-100",
  };

  return (
    <div
      className={`rounded-2xl border border-white/10 bg-gradient-to-br ${tones[tone] || tones.purple} p-4 shadow-[0_18px_50px_rgba(0,0,0,0.28)] backdrop-blur-2xl ${className}`}
    >
      <p className="text-[10px] uppercase tracking-[0.18em] text-gray-400">{title}</p>
      <p className="mt-1 text-lg font-black">{value}</p>
      {hint && <p className="mt-1 text-[11px] text-gray-500">{hint}</p>}
    </div>
  );
}
