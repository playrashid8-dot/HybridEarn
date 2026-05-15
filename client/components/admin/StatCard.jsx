"use client";

export default function StatCard({ title, value, hint }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.06] p-5 shadow-[0_0_30px_rgba(124,58,237,0.12)]">
      <p className="text-sm text-gray-400">{title}</p>
      <h3 className="mt-2 text-2xl font-bold text-white">{value}</h3>
      {hint ? <p className="mt-2 text-xs text-gray-500">{hint}</p> : null}
    </div>
  );
}
