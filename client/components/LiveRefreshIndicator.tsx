"use client";

import { memo, useEffect, useState } from "react";

type Props = {
  lastUpdatedAt?: number | null;
  className?: string;
  label?: string;
};

function formatAgo(ms: number) {
  const s = Math.floor(ms / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}

/** Live pulse + “Updated X ago” for auto-refresh UX. */
function LiveRefreshIndicator({ lastUpdatedAt, className = "", label = "🟢 Live" }: Props) {
  const [, setTick] = useState(0);

  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const text =
    lastUpdatedAt != null && Number.isFinite(lastUpdatedAt)
      ? `Updated ${formatAgo(Date.now() - lastUpdatedAt)}`
      : "Refreshing…";

  return (
    <div className={`inline-flex flex-wrap items-center gap-2 text-[10px] font-semibold ${className}`}>
      <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/[0.12] px-2.5 py-1 text-emerald-100 shadow-[inset_0_0_0_1px_rgba(16,185,129,0.2)]">
        <span
          className="relative flex h-2 w-2 shrink-0"
          aria-hidden
        >
          <span className="absolute inset-0 animate-ping rounded-full bg-emerald-400 opacity-40" />
          <span className="relative inline-block h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_12px_rgba(52,211,153,0.9)]" />
        </span>
        {label}
      </span>
      <span className="tabular-nums text-gray-500">{text}</span>
    </div>
  );
}

export default memo(LiveRefreshIndicator);
