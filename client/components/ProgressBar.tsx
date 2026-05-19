"use client";

import React from "react";

export default function ProgressBar({
  value = 0,
  max = 100,
  label,
  hint,
  className = "",
}: any) {
  const percent = max > 0 ? Math.min(100, Math.max(0, (Number(value || 0) / Number(max)) * 100)) : 0;

  return (
    <div className={className}>
      {(label || hint) && (
        <div className="mb-2 flex items-center justify-between gap-3 text-xs">
          <span className="font-semibold text-white">{label}</span>
          <span className="text-gray-400">{hint || `${Number(value || 0)} / ${Number(max || 0)}`}</span>
        </div>
      )}
      <div className="h-2.5 overflow-hidden rounded-full bg-white/[0.07] ring-1 ring-white/10">
        <div
          className="h-full rounded-full bg-gradient-to-r from-purple-400 via-fuchsia-400 to-cyan-300 shadow-[0_0_10px_rgba(168,85,247,0.28)] transition-all duration-700"
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}
